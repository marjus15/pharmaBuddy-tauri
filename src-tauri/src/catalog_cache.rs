use crate::env_config;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

static SESSION_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn session_cache() -> &'static Mutex<HashMap<String, String>> {
    SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether catalog write-back is allowed after a Galinos hit. Defaults to ON.
pub fn catalog_cache_enabled() -> bool {
    match env_config::get_env("GALINOS_CACHE_ENABLED") {
        Some(v) => !matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "no" | "off"),
        None => true,
    }
}

/// Returns a product name cached in the current app session (same barcode rescanned).
pub fn get_session_cached(barcode: &str) -> Option<String> {
    session_cache()
        .lock()
        .ok()?
        .get(barcode)
        .cloned()
}

pub fn put_session_cached(barcode: &str, product_name: &str) {
    if let Ok(mut cache) = session_cache().lock() {
        cache.insert(barcode.to_string(), product_name.to_string());
    }
}

/// Derives `.../functions/v1/cache-catalog-entry` from the existing recommendation URL.
fn cache_catalog_url() -> Option<String> {
    let functions_url = env_config::get_env("SUPABASE_FUNCTIONS_URL")?;
    let slash = functions_url.rfind('/')?;
    Some(format!("{}/cache-catalog-entry", &functions_url[..slash]))
}

/// Fire-and-forget: upsert a resolved barcode into `global_product_catalog`.
pub fn schedule_catalog_cache(barcode: String, product_name: String) {
    schedule_catalog_cache_with_source(barcode, product_name, "galinos");
}

pub fn schedule_catalog_cache_with_source(
    barcode: String,
    product_name: String,
    source: &str,
) {
    if !catalog_cache_enabled() {
        return;
    }

    let source = source.to_string();
    put_session_cached(&barcode, &product_name);
    tokio::spawn(async move {
        match write_catalog_entry(&barcode, &product_name, &source).await {
            Ok(cached) => {
                env_config::app_log(&format!(
                    "[Cache] {barcode} → {}",
                    if cached { "saved to catalog" } else { "already in catalog" }
                ));
            }
            Err(ex) => {
                env_config::app_log(&format!("[Cache] Failed for {barcode}: {ex}"));
            }
        }
    });
}

async fn write_catalog_entry(barcode: &str, product_name: &str, source: &str) -> Result<bool, String> {
    let url = cache_catalog_url().ok_or_else(|| "Missing SUPABASE_FUNCTIONS_URL".to_string())?;
    let anon_key =
        env_config::get_env("SUPABASE_ANON_KEY").ok_or_else(|| "Missing SUPABASE_ANON_KEY".to_string())?;

    let payload = serde_json::json!({
        "barcode": barcode,
        "product_name": product_name,
        "source": source
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|ex| ex.to_string())?;

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {anon_key}"))
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|ex| ex.to_string())?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {} — {body}", status.as_u16()));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|ex| format!("Invalid JSON: {ex} — {body}"))?;

    Ok(parsed.get("cached").and_then(|v| v.as_bool()).unwrap_or(false))
}
