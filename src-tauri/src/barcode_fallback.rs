use crate::env_config;
use crate::galinos;
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

/// GS1 country / commercial prefixes (excluding Greek ΕΟΦ `280`).
const COMMERCIAL_PREFIXES: &[&str] = &[
    "520", "500", "505", "400", "301", "360", "871", "841", "333", "380", "590", "750",
];

const OFF_USER_AGENT: &str = "pharmaBuddy/0.1 (pharmacy lookup; contact@pharmabuddy.local)";

#[derive(Debug, Clone)]
pub struct OpenFoodFactsHit {
    pub product_name: String,
}

pub fn fallback_enabled() -> bool {
    match env_config::get_env("BARCODE_FALLBACK_ENABLED") {
        Some(v) => !matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "no" | "off"),
        None => true,
    }
}

/// Commercial EAN: international retail prefixes, excluding Greek ΕΟΦ (`280…`).
pub fn is_commercial_barcode(barcode: &str) -> bool {
    barcode.len() >= 8
        && !barcode.starts_with("280")
        && COMMERCIAL_PREFIXES.iter().any(|p| barcode.starts_with(p))
}

pub fn commercial_prefix_label(barcode: &str) -> &'static str {
    if barcode.starts_with("520") {
        "GR-commercial (520)"
    } else if barcode.starts_with("500") {
        "UK/Global-commercial (500)"
    } else if barcode.starts_with("505") {
        "IE/Global-pharma (505)"
    } else if barcode.starts_with("400") {
        "DE-commercial (400)"
    } else if barcode.starts_with("301") {
        "FR-commercial (301)"
    } else {
        "international-commercial"
    }
}

/// Open Food / Open Products Facts lookup for commercial barcodes.
pub async fn lookup_open_food_facts(barcode: &str) -> Option<OpenFoodFactsHit> {
    if !fallback_enabled() {
        return None;
    }

    env_config::app_log(&format!(
        "[Fallback] Advanced lookup for {barcode} ({})",
        commercial_prefix_label(barcode)
    ));

    let client = galinos::build_client()?;
    for code in barcode_variants(barcode) {
        if let Some(hit) = query_open_food_facts_v0(&client, &code).await {
            env_config::app_log(&format!(
                "[OpenFoodFacts] Found product: {}",
                hit.product_name
            ));
            return Some(hit);
        }
        if let Some(hit) = query_open_products_facts_v0(&client, &code).await {
            env_config::app_log(&format!(
                "[OpenProductsFacts] Found product: {}",
                hit.product_name
            ));
            return Some(hit);
        }
    }

    None
}

/// Logs unresolved commercial barcodes for manual dictionary pairing.
pub fn log_unresolved(barcode: &str, detail: &str) {
    let prefix = commercial_prefix_label(barcode);
    let timestamp = unix_timestamp();
    let line = format!("{timestamp},{barcode},{prefix},\"{detail}\"\n");

    env_config::app_log(&format!(
        "[Unresolved] {barcode} ({prefix}) — queued for manual pairing. {detail}"
    ));

    let path = unresolved_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        if file.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
            let _ = file.write_all(b"timestamp,barcode,prefix,detail\n");
        }
        let _ = file.write_all(line.as_bytes());
    }
}

fn unresolved_log_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("pharmaBuddy").join("unresolved_barcodes.csv")
}

fn unix_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

fn barcode_variants(barcode: &str) -> Vec<String> {
    let clean = barcode.trim_start_matches('0');
    let mut variants = vec![barcode.to_string()];
    if !clean.is_empty() && clean != barcode {
        variants.push(clean.to_string());
    }
    if barcode.len() == 13 && !barcode.starts_with('0') {
        variants.push(format!("0{barcode}"));
    }
    if barcode.len() == 14 && barcode.starts_with('0') {
        variants.push(barcode[1..].to_string());
    }
    variants.sort();
    variants.dedup();
    variants
}

async fn query_open_food_facts_v0(
    client: &reqwest::Client,
    barcode: &str,
) -> Option<OpenFoodFactsHit> {
    let url = format!("https://world.openfoodfacts.org/api/v0/product/{barcode}.json");
    parse_off_response(client, &url).await
}

async fn query_open_products_facts_v0(
    client: &reqwest::Client,
    barcode: &str,
) -> Option<OpenFoodFactsHit> {
    let url = format!("https://world.openproductsfacts.org/api/v0/product/{barcode}.json");
    parse_off_response(client, &url).await
}

async fn parse_off_response(client: &reqwest::Client, url: &str) -> Option<OpenFoodFactsHit> {
    let response = client
        .get(url)
        .header("User-Agent", OFF_USER_AGENT)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body = response.text().await.ok()?;
    parse_off_json(&body)
}

/// Dynamic JSON parse: `product.product_name_el` → `product.product_name`.
fn parse_off_json(body: &str) -> Option<OpenFoodFactsHit> {
    let root: Value = serde_json::from_str(body).ok()?;
    if root.get("status")?.as_i64()? != 1 {
        return None;
    }

    let product = root.get("product")?;
    let name = product
        .get("product_name_el")
        .or_else(|| product.get("product_name"))
        .or_else(|| product.get("generic_name"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| s.chars().count() >= 2)?;

    Some(OpenFoodFactsHit {
        product_name: name.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_commercial_barcodes() {
        assert!(is_commercial_barcode("5201236130113"));
        assert!(is_commercial_barcode("5000156102123"));
        assert!(!is_commercial_barcode("2803113101101"));
    }

    #[test]
    fn parses_off_json_dynamic() {
        let json = r#"{"status":1,"product":{"product_name_el":"DEPON MAXIMUM","brands":"Demo"}}"#;
        let hit = parse_off_json(json).unwrap();
        assert_eq!(hit.product_name, "DEPON MAXIMUM");
    }
}
