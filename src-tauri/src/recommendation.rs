use crate::env_config::{self, AppProfile};
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

pub async fn get_recommendation(barcode: &str) -> RecommendationDto {
    let profile = env_config::current_profile();
    env_config::app_log(&format!("[Scan] Lookup {barcode} (profile: {:?})", profile));

    match profile {
        AppProfile::Test => get_test_recommendation(barcode).await,
        AppProfile::Prod => get_prod_recommendation(barcode).await,
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

async fn get_prod_recommendation(barcode: &str) -> RecommendationDto {
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

    let payload = serde_json::json!({
        "barcode": barcode,
        "pharmacy_id": ""
    });

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
