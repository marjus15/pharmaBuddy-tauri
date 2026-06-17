use crate::env_config;
use crate::galinos;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const EPRESCRIPTION_BASE: &str = "https://www.e-prescription.gr";
const FARMAKO_CATALOG_PAGE: &str = "https://farmako.net/el/times/times-farmakon";

static FARMAKO_INDEX: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();

pub fn eprescription_enabled() -> bool {
    match env_config::get_env("EPRESCRIPTION_LOOKUP_ENABLED") {
        Some(v) => !matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "no" | "off"),
        None => true,
    }
}

/// Greek national ΕΟΦ barcode: 13 digits starting with `280`.
pub fn is_national_eof_barcode(barcode: &str) -> bool {
    barcode.len() == 13 && barcode.starts_with("280") && barcode.chars().all(|c| c.is_ascii_digit())
}

/// National registry fallback for `280…` barcodes that missed on Galinos GTIN lookup.
pub async fn lookup_eprescription(barcode: &str) -> Option<String> {
    if !eprescription_enabled() || !is_national_eof_barcode(barcode) {
        return None;
    }

    env_config::app_log(&format!(
        "[EPrescription] National fallback for {barcode}"
    ));

    let client = galinos::build_client()?;

    if let Some(name) = lookup_eprescription_api(&client, barcode).await {
        env_config::app_log(&format!("[EPrescription] Fallback hit: {name}"));
        return Some(name);
    }

    if let Some(name) = lookup_farmako_index(&client, barcode).await {
        env_config::app_log(&format!("[EPrescription] Fallback hit: {name}"));
        return Some(name);
    }

    if let Some(name) = lookup_galinos_eof_crossref(barcode).await {
        env_config::app_log(&format!("[EPrescription] Fallback hit: {name}"));
        return Some(name);
    }

    None
}

async fn lookup_eprescription_api(client: &reqwest::Client, barcode: &str) -> Option<String> {
    let paths = [
        "/api/v1/drugs/search",
        "/api/drugs/search",
        "/national/search",
    ];

    for path in paths {
        let url = format!("{EPRESCRIPTION_BASE}{path}");
        let get_url = format!("{url}?gtin={barcode}&barcode={barcode}&q={barcode}");
        env_config::app_log(&format!("[EPrescription] GET {get_url}"));
        if let Some(name) = try_eprescription_response(
            client.get(&get_url).header("User-Agent", galinos::USER_AGENT).send().await,
        )
        .await
        {
            return Some(name);
        }

        let payload = serde_json::json!({ "barcode": barcode, "gtin": barcode });
        env_config::app_log(&format!("[EPrescription] POST {url}"));
        if let Some(name) = try_eprescription_response(
            client
                .post(&url)
                .header("User-Agent", galinos::USER_AGENT)
                .header("Content-Type", "application/json")
                .json(&payload)
                .send()
                .await,
        )
        .await
        {
            return Some(name);
        }
    }

    env_config::app_log("[EPrescription] API requires authentication or returned no product");
    None
}

async fn try_eprescription_response(
    response: Result<reqwest::Response, reqwest::Error>,
) -> Option<String> {
    let response = response.ok()?;
    let body = response.text().await.ok()?;
    if body.contains("IBM Confidential") || body.contains("\"operation\"") && body.contains("login") {
        return None;
    }
    parse_eprescription_body(&body)
}

fn parse_eprescription_body(body: &str) -> Option<String> {
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if json.get("operation").and_then(|v| v.as_str()) == Some("login") {
            return None;
        }
        for key in ["product_name", "product_name_el", "name", "tradeName", "commercialName"] {
            if let Some(name) = json.get(key).and_then(|v| v.as_str()) {
                let name = name.trim();
                if name.chars().count() >= 2 {
                    return Some(name.to_string());
                }
            }
        }
        if let Some(product) = json.get("product") {
            for key in ["product_name", "product_name_el", "name"] {
                if let Some(name) = product.get(key).and_then(|v| v.as_str()) {
                    let name = name.trim();
                    if name.chars().count() >= 2 {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    galinos::parse_best_drug_result_from_html(body)
}

async fn lookup_farmako_index(client: &reqwest::Client, barcode: &str) -> Option<String> {
    let index = load_farmako_index(client).await?;
    index.get(barcode).cloned()
}

async fn load_farmako_index(client: &reqwest::Client) -> Option<HashMap<String, String>> {
    {
        let guard = farmako_index_lock().lock().ok()?;
        if let Some(map) = guard.as_ref() {
            return Some(map.clone());
        }
    }

    let csv_url = discover_farmako_csv_url(client).await?;
    env_config::app_log(&format!("[EPrescription] Farmako CSV → {csv_url}"));

    let response = client
        .get(&csv_url)
        .header("User-Agent", galinos::USER_AGENT)
        .header("Accept", "text/csv,text/plain,*/*")
        .header("Referer", FARMAKO_CATALOG_PAGE)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let text = response.text().await.ok()?;
    let mut map = HashMap::new();
    for line in text.lines() {
        if let Some((code, name)) = parse_farmako_csv_line(line) {
            map.insert(code, name);
        }
    }

    if let Ok(mut guard) = farmako_index_lock().lock() {
        *guard = Some(map.clone());
    }

    Some(map)
}

fn farmako_index_lock() -> &'static Mutex<Option<HashMap<String, String>>> {
    FARMAKO_INDEX.get_or_init(|| Mutex::new(None))
}

async fn discover_farmako_csv_url(client: &reqwest::Client) -> Option<String> {
    let response = client
        .get(FARMAKO_CATALOG_PAGE)
        .header("User-Agent", galinos::USER_AGENT)
        .header("Accept", "text/html,*/*")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;

    let html = response.text().await.ok()?;
    let mut candidates = extract_csv_candidates(&html);

    for script_url in extract_script_urls(&html) {
        if let Ok(js_resp) = client
            .get(&script_url)
            .header("User-Agent", galinos::USER_AGENT)
            .send()
            .await
        {
            if js_resp.status().is_success() {
                if let Ok(js_text) = js_resp.text().await {
                    candidates.extend(extract_csv_candidates(&js_text));
                }
            }
        }
    }

    candidates.sort();
    candidates.dedup();
    candidates.into_iter().next()
}

fn extract_script_urls(html: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = html[search_from..].find("src=\"") {
        let start = search_from + rel + 5;
        if let Some(end_rel) = html[start..].find('"') {
            let src = &html[start..start + end_rel];
            let absolute = if src.starts_with("http") {
                src.to_string()
            } else if src.starts_with('/') {
                format!("https://farmako.net{src}")
            } else {
                format!("https://farmako.net/{src}")
            };
            urls.push(absolute);
            search_from = start + end_rel;
        } else {
            break;
        }
    }
    urls
}

fn extract_csv_candidates(text: &str) -> Vec<String> {
    let mut results = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find("data_") {
        let start = search_from + rel;
        if let Some(end_rel) = text[start..].find(".csv") {
            let end = start + end_rel + 4;
            let raw = &text[start..end];
            let clean: String = raw
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.' || *c == '/')
                .collect();
            let url = if clean.starts_with("http") {
                clean
            } else if clean.starts_with('/') {
                format!("https://farmako.net{clean}")
            } else {
                format!("https://farmako.net/{clean}")
            };
            results.push(url);
            search_from = end;
        } else {
            break;
        }
    }
    results
}

fn parse_farmako_csv_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let fields: Vec<&str> = line.split(';').map(str::trim).collect();
    let barcode = fields.first()?.to_string();
    if !barcode.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let raw_name = fields.get(1)?;
    let name = if raw_name.starts_with("http") {
        name_from_url(raw_name)
    } else {
        (*raw_name).to_string()
    };
    if name.trim().chars().count() < 2 {
        return None;
    }
    Some((barcode, name.trim().to_string()))
}

fn name_from_url(raw: &str) -> String {
    if let Some(last) = raw.rsplit('/').find(|seg| !seg.is_empty() && !seg.chars().all(|c| c.is_ascii_digit())) {
        let slug = last.replace(['-', '_'], " ");
        return slug
            .split_whitespace()
            .map(|w| {
                let mut chars = w.chars();
                match chars.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    raw.trim().to_string()
}

async fn lookup_galinos_eof_crossref(barcode: &str) -> Option<String> {
    if barcode.len() != 13 {
        return None;
    }
    let eof_code = &barcode[3..12];
    env_config::app_log(&format!("[EPrescription] Galinos EOF cross-ref → {eof_code}"));
    galinos::lookup_by_search_query(eof_code).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn national_eof_detection() {
        assert!(is_national_eof_barcode("2803113101101"));
        assert!(!is_national_eof_barcode("5201236130113"));
    }

    #[test]
    fn parses_farmako_csv_row() {
        let row = "2803113101101;SAGILIA TAB 1MG;ingredient;ATC";
        let (code, name) = parse_farmako_csv_line(row).unwrap();
        assert_eq!(code, "2803113101101");
        assert_eq!(name, "SAGILIA TAB 1MG");
    }
}
