use crate::barcode_fallback;
use crate::catalog_cache;
use crate::commercial_registry;
use crate::env_config::{self, AppProfile};
use crate::eprescription;
use crate::galinos;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct RecommendationDto {
    pub success: bool,
    pub product_name: Option<String>,
    pub recommendation: Option<String>,
    pub error_message: Option<String>,
    pub raw_response: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LookupResult {
    pub found: bool,
    pub product_name: Option<String>,
    pub active_ingredient: Option<String>,
    pub atc_code: Option<String>,
    /// Where the name came from: "catalog", "galinos", or absent. Not returned by the
    /// Edge Function, so it must default when deserializing the catalog response.
    #[serde(default)]
    pub source: Option<String>,
    /// Human-readable explanation when `found` is false (shown in preview panel).
    #[serde(default)]
    pub miss_reason: Option<String>,
}

fn lookup_miss(miss_reason: impl Into<String>) -> LookupResult {
    LookupResult {
        found: false,
        product_name: None,
        active_ingredient: None,
        atc_code: None,
        source: None,
        miss_reason: Some(miss_reason.into()),
    }
}

fn barcode_format_hint(barcode: &str) -> String {
    if eprescription::is_national_eof_barcode(barcode) {
        format!("barcode {barcode} (εθνικός ΕΟΦ 280…)")
    } else if barcode_fallback::is_commercial_barcode(barcode) {
        format!(
            "barcode {barcode} ({})",
            barcode_fallback::commercial_prefix_label(barcode)
        )
    } else if barcode.len() == 13 && barcode.chars().all(|c| c.is_ascii_digit()) {
        format!("barcode {barcode} (13 ψηφία, όχι στον κατάλογο)")
    } else {
        format!(
            "barcode {barcode} ({} ψηφία — όχι εθνικός ΕΟΦ 280…)",
            barcode.len()
        )
    }
}

pub async fn lookup_barcode(barcode: &str) -> LookupResult {
    let profile = env_config::current_profile();
    env_config::app_log(&format!("[Lookup] Barcode {barcode} (profile: {:?})", profile));

    match profile {
        AppProfile::Test => lookup_barcode_test(barcode),
        AppProfile::Prod => lookup_barcode_prod(barcode).await,
    }
}

fn lookup_barcode_test(barcode: &str) -> LookupResult {
    if barcode == "0000000000000" {
        return lookup_miss("TEST profile: barcode ρυθμισμένο ως not-found");
    }
    if barcode == "1111111111111" {
        return LookupResult {
            found: true,
            product_name: Some("Panadol Extra 500mg (TEST)".into()),
            active_ingredient: Some("Paracetamol / Caffeine".into()),
            atc_code: Some("N02BE51".into()),
            source: Some("catalog".into()),
            miss_reason: None,
        };
    }
    let suffix = if barcode.len() >= 4 { &barcode[barcode.len() - 4..] } else { barcode };
    LookupResult {
        found: true,
        product_name: Some(format!("Δοκιμαστικό Προϊόν #{suffix}")),
        active_ingredient: Some("Test Ingredient".into()),
        atc_code: Some("N/A".into()),
        source: Some("catalog".into()),
        miss_reason: None,
    }
}

/// Whether the Galinos web fallback is allowed. Defaults to ON in PROD; set
/// `GALINOS_LOOKUP_ENABLED=false` (or 0/no/off) to disable it.
fn galinos_lookup_enabled() -> bool {
    match env_config::get_env("GALINOS_LOOKUP_ENABLED") {
        Some(v) => !matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "no" | "off"),
        None => true,
    }
}

/// PROD lookup: catalog → session cache → commercial registry → Galinos → OpenFoodFacts → unresolved.
async fn lookup_barcode_prod(barcode: &str) -> LookupResult {
    let catalog = lookup_catalog_prod(barcode).await;
    if catalog.found {
        let mut hit = catalog;
        if hit.source.is_none() {
            hit.source = Some("catalog".into());
        }
        return hit;
    }

    if let Some(reason) = catalog.miss_reason {
        return lookup_miss(reason);
    }

    let mut steps = vec!["κατάλογος Supabase: όχι".to_string()];

    if let Some(name) = catalog_cache::get_session_cached(barcode) {
        env_config::app_log(&format!("[Lookup] Session cache hit for {barcode}"));
        return LookupResult {
            found: true,
            product_name: Some(name),
            active_ingredient: None,
            atc_code: None,
            source: Some("galinos".into()),
            miss_reason: None,
        };
    }

    if barcode_fallback::is_commercial_barcode(barcode) {
        if let Some(name) = commercial_registry::lookup_local(barcode) {
            env_config::app_log(&format!("[Cache] Commercial hit for {barcode}"));
            return LookupResult {
                found: true,
                product_name: Some(name),
                active_ingredient: None,
                atc_code: None,
                source: Some("commercial_registry".into()),
                miss_reason: None,
            };
        }
        steps.push("commercial registry: όχι".into());
    }

    if galinos_lookup_enabled() {
        env_config::app_log(&format!("[Lookup] Catalog miss → Galinos fallback for {barcode}"));
        if let Some(name) = galinos::lookup_drug_name(barcode).await {
            catalog_cache::schedule_catalog_cache(barcode.to_string(), name.clone());
            return LookupResult {
                found: true,
                product_name: Some(name),
                active_ingredient: None,
                atc_code: None,
                source: Some("galinos".into()),
                miss_reason: None,
            };
        }
        steps.push("Galinos: όχι".into());
    } else {
        steps.push("Galinos: απενεργοποιημένο".into());
    }

    if eprescription::is_national_eof_barcode(barcode) {
        if let Some(name) = eprescription::lookup_eprescription(barcode).await {
            catalog_cache::schedule_catalog_cache_with_source(
                barcode.to_string(),
                name.clone(),
                "eprescription",
            );
            return LookupResult {
                found: true,
                product_name: Some(name),
                active_ingredient: None,
                atc_code: None,
                source: Some("eprescription".into()),
                miss_reason: None,
            };
        }

        steps.push("e-prescription.gr: όχι".into());
        env_config::app_log(&format!(
            "[Lookup] No result for {barcode} (manual entry required)"
        ));
        return lookup_miss(format!(
            "{} · {}",
            steps.join(" · "),
            barcode_format_hint(barcode)
        ));
    }

    if barcode_fallback::is_commercial_barcode(barcode) {
        if let Some(hit) = barcode_fallback::lookup_open_food_facts(barcode).await {
            commercial_registry::schedule_save(barcode.to_string(), hit.product_name.clone());
            return LookupResult {
                found: true,
                product_name: Some(hit.product_name),
                active_ingredient: None,
                atc_code: None,
                source: Some("openfoodfacts".into()),
                miss_reason: None,
            };
        }

        steps.push("OpenFoodFacts: όχι".into());
        barcode_fallback::log_unresolved(
            barcode,
            "catalog+commercial_registry+galinos+openfoodfacts all missed; needs manual pairing",
        );
    } else {
        env_config::app_log(&format!(
            "[Lookup] No result for {barcode} (manual entry required)"
        ));
    }

    lookup_miss(format!(
        "{} · {}",
        steps.join(" · "),
        barcode_format_hint(barcode)
    ))
}

/// Queries only the Supabase `global_product_catalog` via the Edge Function.
async fn lookup_catalog_prod(barcode: &str) -> LookupResult {
    let functions_url = match env_config::get_env("SUPABASE_FUNCTIONS_URL") {
        Some(v) => v,
        None => {
            env_config::app_log("[Lookup] Missing SUPABASE_FUNCTIONS_URL");
            return lookup_miss("Λείπει SUPABASE_FUNCTIONS_URL στο .env");
        }
    };
    let anon_key = match env_config::get_env("SUPABASE_ANON_KEY") {
        Some(v) => v,
        None => {
            env_config::app_log("[Lookup] Missing SUPABASE_ANON_KEY");
            return lookup_miss("Λείπει SUPABASE_ANON_KEY στο .env");
        }
    };

    let payload = serde_json::json!({
        "barcode": barcode,
        "pharmacy_id": "",
        "lookup_only": true
    });

    env_config::app_log(&format!("[Lookup] POST → {functions_url}"));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let response = match client
        .post(&functions_url)
        .header("Authorization", format!("Bearer {anon_key}"))
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
    {
        Ok(r) => r,
        Err(ex) => {
            env_config::app_log(&format!("[Lookup] Network error: {ex}"));
            return lookup_miss(format!("Σφάλμα δικτύου Supabase: {ex}"));
        }
    };

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    env_config::app_log(&format!("[Lookup] Response: {body}"));

    if !status.is_success() {
        return lookup_miss(format!(
            "Supabase HTTP {} — {}",
            status.as_u16(),
            body.chars().take(120).collect::<String>()
        ));
    }

    if let Ok(result) = serde_json::from_str::<LookupResult>(&body) {
        return result;
    }

    // Fallback: parse the full recommendation response format (before Edge Function redeploy)
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
        let has_product = parsed.get("product_name").and_then(|v| v.as_str()).is_some();
        let is_success = parsed.get("success").and_then(|v| v.as_bool()) == Some(true);
        if has_product && is_success {
            return LookupResult {
                found: true,
                product_name: parsed.get("product_name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                active_ingredient: None,
                atc_code: None,
                source: Some("catalog".into()),
                miss_reason: None,
            };
        }
    }

    lookup_miss("Μη έγκυρη απάντηση Supabase (lookup_only)")
}

pub async fn get_recommendation(barcode: &str, product_name: Option<&str>) -> RecommendationDto {
    let profile = env_config::current_profile();
    env_config::app_log(&format!("[Recommend] {barcode} product_name={:?} (profile: {:?})", product_name, profile));

    match profile {
        AppProfile::Test => get_test_recommendation(barcode).await,
        AppProfile::Prod => get_prod_recommendation(barcode, product_name).await,
    }
}

async fn get_test_recommendation(barcode: &str) -> RecommendationDto {
    let delay = rand::thread_rng().gen_range(700..=1400);
    tokio::time::sleep(Duration::from_millis(delay)).await;

    if barcode == "0000000000000" {
        return RecommendationDto {
            success: false,
            product_name: None,
            recommendation: None,
            error_message: Some(
                "Δοκιμαστικό σφάλμα — το προϊόν δεν βρέθηκε στον κατάλογο.".into(),
            ),
            raw_response: Some(r#"{"error":"product_not_found","mode":"test"}"#.into()),
        };
    }

    if barcode == "1111111111111" {
        return RecommendationDto {
            success: true,
            product_name: Some("Panadol Extra 500mg (TEST)".into()),
            recommendation: Some(
                "Μαζί με το Panadol Extra, μπορείτε να προτείνετε ένα ήπιο προβιοτικό για υποστήριξη της εντερικής άνεσης κατά τη διάρκεια της αγωγής. \
                Είναι μια πρακτική και ασφαλής συνοδευτική πρόταση που βελτιώνει τη συνολική φροντίδα του ασθενούς. \
                Επιπλέον, ένα συμπλήρωμα μαγνησίου μπορεί να βοηθήσει σε περιπτώσεις μυϊκής έντασης — πάντα με βάση το ιατρικό ιστορικό."
                    .into(),
            ),
            error_message: None,
            raw_response: None,
        };
    }

    if barcode == "2222222222222" {
        return RecommendationDto {
            success: true,
            product_name: Some("Vitamin C 1000mg (TEST)".into()),
            recommendation: Some(
                "Συνιστάται συμπληρωματική πρόταση ψευδάργυρου για ενίσχυση της ανοσολογικής υποστήριξης.".into(),
            ),
            error_message: None,
            raw_response: None,
        };
    }

    let suffix = if barcode.len() >= 4 {
        &barcode[barcode.len() - 4..]
    } else {
        barcode
    };

    RecommendationDto {
        success: true,
        product_name: Some(format!("Δοκιμαστικό Προϊόν #{suffix}")),
        recommendation: Some(format!(
            "Για το δοκιμαστικό προϊόν (barcode {barcode}), προτείνετε ένα συμβατό συμπλήρωμα που υποστηρίζει την καθημερινή φροντίδα. \
            Αυτή είναι mock απάντηση TEST — χωρίς κλήση AI API.Για το δοκιμαστικό προϊόν (barcode {barcode}), προτείνετε ένα συμβατό συμπλήρωμα που υποστηρίζει την καθημερινή φροντίδα. \
            Αυτή είναι mock απάντηση TEST — χωρίς κλήση AI API."
        )),
        error_message: None,
        raw_response: None,
    }
}

async fn get_prod_recommendation(barcode: &str, product_name: Option<&str>) -> RecommendationDto {
    let functions_url = match env_config::get_env("SUPABASE_FUNCTIONS_URL") {
        Some(v) => v,
        None => {
            return RecommendationDto {
                success: false,
                product_name: None,
                recommendation: None,
                error_message: Some(
                    "Λείπουν SUPABASE_FUNCTIONS_URL ή SUPABASE_ANON_KEY (απαιτούνται για PROD).".into(),
                ),
                raw_response: None,
            };
        }
    };

    let anon_key = match env_config::get_env("SUPABASE_ANON_KEY") {
        Some(v) => v,
        None => {
            return RecommendationDto {
                success: false,
                product_name: None,
                recommendation: None,
                error_message: Some(
                    "Λείπουν SUPABASE_FUNCTIONS_URL ή SUPABASE_ANON_KEY (απαιτούνται για PROD).".into(),
                ),
                raw_response: None,
            };
        }
    };

    let mut payload = serde_json::json!({
        "barcode": barcode,
        "pharmacy_id": ""
    });
    if let Some(name) = product_name {
        payload["product_name"] = serde_json::Value::String(name.to_string());
    }

    env_config::app_log(&format!("[Prod] POST → {functions_url}"));
    env_config::app_log(&format!("[Prod] Payload: {payload}"));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let response = match client
        .post(&functions_url)
        .header("Authorization", format!("Bearer {anon_key}"))
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
    {
        Ok(r) => r,
        Err(ex) => {
            env_config::app_log(&format!("[Prod] Network error: {ex}"));
            return RecommendationDto {
                success: false,
                product_name: None,
                recommendation: None,
                error_message: Some(format!("Σφάλμα δικτύου: {ex}")),
                raw_response: None,
            };
        }
    };

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    env_config::app_log(&format!("[Prod] HTTP {}", status.as_u16()));
    env_config::app_log(&format!("[Prod] Body: {body}"));

    if !status.is_success() {
        return RecommendationDto {
            success: false,
            product_name: None,
            recommendation: None,
            error_message: Some(format!("Σφάλμα Supabase ({})", status.as_u16())),
            raw_response: Some(body),
        };
    }

    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
        if parsed.get("success").and_then(|v| v.as_bool()) == Some(false) {
            let msg = parsed
                .get("message")
                .or_else(|| parsed.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("Το προϊόν δεν βρέθηκε.");
            return RecommendationDto {
                success: false,
                product_name: None,
                recommendation: None,
                error_message: Some(msg.to_string()),
                raw_response: Some(body),
            };
        }

        if parsed.get("error").is_some() && parsed.get("product_name").is_none() {
            let msg = parsed
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Σφάλμα API");
            return RecommendationDto {
                success: false,
                product_name: None,
                recommendation: None,
                error_message: Some(msg.to_string()),
                raw_response: Some(body),
            };
        }
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        product_name: Option<String>,
        recommendation: Option<String>,
    }

    match serde_json::from_str::<ApiResponse>(&body) {
        Ok(parsed) => RecommendationDto {
            success: true,
            product_name: Some(
                parsed
                    .product_name
                    .unwrap_or_else(|| "(χωρίς όνομα προϊόντος)".into()),
            ),
            recommendation: Some(
                parsed
                    .recommendation
                    .unwrap_or_else(|| "(χωρίς πρόταση)".into()),
            ),
            error_message: None,
            raw_response: Some(body),
        },
        Err(ex) => RecommendationDto {
            success: false,
            product_name: None,
            recommendation: None,
            error_message: Some(format!("Μη έγκυρη απάντηση JSON: {ex}")),
            raw_response: Some(body),
        },
    }
}
