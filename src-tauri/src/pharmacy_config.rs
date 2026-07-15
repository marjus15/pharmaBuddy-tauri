use crate::env_config;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const OFFLINE_GRACE_SECS: i64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PharmacyConfig {
    pub pharmacy_id: String,
    pub business_name: String,
    pub license_key: String,
    pub activated_at: i64,
    pub last_validated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PharmacyStatus {
    pub activated: bool,
    pub business_name: Option<String>,
    pub license_valid: bool,
    pub needs_reconnect: bool,
    pub lock_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ActivateResponse {
    pharmacy_id: String,
    business_name: String,
    status: String,
    license_key: String,
}

#[derive(Debug, Deserialize)]
struct ActivateError {
    error: Option<String>,
    message: Option<String>,
}

fn pharmacy_config_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("pharmaBuddy").join("pharmacy.json")
}

fn edge_function_url(name: &str) -> Option<String> {
    let functions_url = env_config::get_env("SUPABASE_FUNCTIONS_URL")?;
    let slash = functions_url.rfind('/')?;
    Some(format!("{}/{}", &functions_url[..slash], name))
}

pub fn load_config() -> Option<PharmacyConfig> {
    let path = pharmacy_config_path();
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_config(config: &PharmacyConfig) -> Result<(), String> {
    let path = pharmacy_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

pub fn clear_config() {
    let path = pharmacy_config_path();
    let _ = fs::remove_file(path);
}

pub fn get_pharmacy_id() -> Option<String> {
    load_config().map(|c| c.pharmacy_id)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}

fn within_offline_grace(last_validated_at: i64) -> bool {
    now_unix() - last_validated_at <= OFFLINE_GRACE_SECS
}

async fn call_activate(license_key: &str) -> Result<ActivateResponse, String> {
    let url = edge_function_url("activate-pharmacy")
        .ok_or_else(|| "Λείπει SUPABASE_FUNCTIONS_URL".to_string())?;
    let anon_key = env_config::get_env("SUPABASE_ANON_KEY")
        .ok_or_else(|| "Λείπει SUPABASE_ANON_KEY".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let payload = serde_json::json!({ "license_key": license_key.trim().to_uppercase() });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {anon_key}"))
        .header("apikey", &anon_key)
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Σφάλμα δικτύου: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<ActivateError>(&body) {
            let msg = err
                .message
                .or(err.error)
                .unwrap_or_else(|| "Άκυρος κωδικός ενεργοποίησης".to_string());
            return Err(msg);
        }
        return Err(format!("Σφάλμα ενεργοποίησης ({})", status.as_u16()));
    }

    serde_json::from_str::<ActivateResponse>(&body)
        .map_err(|e| format!("Μη έγκυρη απάντηση: {e}"))
}

pub async fn activate_pharmacy(license_key: String) -> Result<PharmacyStatus, String> {
    let result = call_activate(&license_key).await?;

    if result.status != "active" {
        clear_config();
        return Ok(PharmacyStatus {
            activated: false,
            business_name: Some(result.business_name),
            license_valid: false,
            needs_reconnect: false,
            lock_reason: Some("Η άδεια χρήσης δεν είναι ενεργή.".into()),
        });
    }

    let now = now_unix();
    let config = PharmacyConfig {
        pharmacy_id: result.pharmacy_id,
        business_name: result.business_name.clone(),
        license_key: result.license_key,
        activated_at: now,
        last_validated_at: now,
    };
    save_config(&config)?;
    env_config::app_log(&format!(
        "[Pharmacy] Activated: {} ({})",
        config.business_name, config.pharmacy_id
    ));

    Ok(PharmacyStatus {
        activated: true,
        business_name: Some(result.business_name),
        license_valid: true,
        needs_reconnect: false,
        lock_reason: None,
    })
}

pub async fn get_pharmacy_status() -> PharmacyStatus {
    let Some(config) = load_config() else {
        return PharmacyStatus {
            activated: false,
            business_name: None,
            license_valid: false,
            needs_reconnect: false,
            lock_reason: None,
        };
    };

    match call_activate(&config.license_key).await {
        Ok(result) if result.status == "active" => {
            let now = now_unix();
            let updated = PharmacyConfig {
                last_validated_at: now,
                ..config.clone()
            };
            let _ = save_config(&updated);
            PharmacyStatus {
                activated: true,
                business_name: Some(result.business_name),
                license_valid: true,
                needs_reconnect: false,
                lock_reason: None,
            }
        }
        Ok(_) => {
            clear_config();
            PharmacyStatus {
                activated: false,
                business_name: Some(config.business_name),
                license_valid: false,
                needs_reconnect: false,
                lock_reason: Some("Η άδεια χρήσης δεν είναι ενεργή.".into()),
            }
        }
        Err(_) if within_offline_grace(config.last_validated_at) => PharmacyStatus {
            activated: true,
            business_name: Some(config.business_name),
            license_valid: true,
            needs_reconnect: false,
            lock_reason: None,
        },
        Err(_) => PharmacyStatus {
            activated: true,
            business_name: Some(config.business_name),
            license_valid: false,
            needs_reconnect: true,
            lock_reason: Some(
                "Απαιτείται σύνδεση στο διαδίκτυο για επαλήθευση της άδειας.".into(),
            ),
        },
    }
}

pub fn is_license_inactive_error(raw_response: &str) -> bool {
    raw_response.contains("license_inactive")
}
