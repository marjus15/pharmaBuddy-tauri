use crate::auth_session;
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
    schedule_catalog_facts(barcode, product_name, source, None, None, None);
}

/// A catalog key is a real GTIN. Typed-name sentinels such as `manual-entry` are not.
pub fn catalog_write_allowed_with_session(
    barcode: &str,
    product_name: &str,
    session_name: Option<&str>,
) -> bool {
    let barcode = barcode.trim();
    let product_name = product_name.trim();
    if barcode.len() < 8 || !barcode.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if product_name.chars().count() < 2 {
        return false;
    }
    if let Some(existing) = session_name.map(str::trim).filter(|name| !name.is_empty()) {
        if !crate::galinos::names_refer_to_same_product(existing, product_name) {
            return false;
        }
    }
    true
}

pub fn catalog_write_allowed(barcode: &str, product_name: &str) -> bool {
    catalog_write_allowed_with_session(
        barcode,
        product_name,
        get_session_cached(barcode).as_deref(),
    )
}

/// Writes a catalog row and, when the barcode already exists, merges missing metadata
/// such as the SPC side-effect excerpt.
/// Refuses a non-barcode key and a name that disagrees with the name already cached
/// for that barcode in this session, so a typed name cannot overwrite another product.
pub fn schedule_catalog_facts(
    barcode: String,
    product_name: String,
    source: &str,
    active_ingredient: Option<String>,
    atc_code: Option<String>,
    side_effects: Option<String>,
) {
    if !catalog_cache_enabled() {
        return;
    }
    if !catalog_write_allowed(&barcode, &product_name) {
        env_config::app_log(&format!(
            "[Cache] refused write for {barcode}: name does not belong to this barcode"
        ));
        return;
    }

    let source = source.to_string();
    if !product_name.trim().is_empty() {
        put_session_cached(&barcode, &product_name);
    }
    tokio::spawn(async move {
        match write_catalog_entry(
            &barcode,
            &product_name,
            &source,
            active_ingredient.as_deref(),
            atc_code.as_deref(),
            side_effects.as_deref(),
        )
        .await
        {
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

async fn write_catalog_entry(
    barcode: &str,
    product_name: &str,
    source: &str,
    active_ingredient: Option<&str>,
    atc_code: Option<&str>,
    side_effects: Option<&str>,
) -> Result<bool, String> {
    let url = cache_catalog_url().ok_or_else(|| "Missing SUPABASE_FUNCTIONS_URL".to_string())?;
    if env_config::get_env("SUPABASE_ANON_KEY").is_none() {
        return Err("Missing SUPABASE_ANON_KEY".to_string());
    }

    let mut payload = serde_json::json!({
        "barcode": barcode,
        "product_name": product_name,
        "source": source
    });
    if let Some(value) = active_ingredient.map(str::trim).filter(|v| !v.is_empty()) {
        payload["active_ingredient"] = serde_json::Value::String(value.to_string());
    }
    if let Some(value) = atc_code.map(str::trim).filter(|v| !v.is_empty()) {
        payload["atc_code"] = serde_json::Value::String(value.to_string());
    }
    if let Some(value) = side_effects.map(str::trim).filter(|v| !v.is_empty()) {
        payload["side_effects"] = serde_json::Value::String(value.to_string());
    }

    let (status, body) = auth_session::post_edge(&url, &payload, Duration::from_secs(8)).await?;
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status} — {body}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|ex| format!("Invalid JSON: {ex} — {body}"))?;

    Ok(parsed.get("cached").and_then(|v| v.as_bool()).unwrap_or(false))
}
