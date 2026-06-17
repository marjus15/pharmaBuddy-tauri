use crate::env_config;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

static REGISTRY: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();

fn registry_lock() -> &'static RwLock<HashMap<String, String>> {
    REGISTRY.get_or_init(|| RwLock::new(load_from_disk()))
}

pub fn registry_path() -> PathBuf {
    if let Some(custom) = env_config::get_env("COMMERCIAL_REGISTRY_PATH") {
        return PathBuf::from(custom);
    }
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("pharmaBuddy").join("commercial_registry.json")
}

fn seed_path_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join("commercial_registry.seed.json"));
        paths.push(cwd.join("..").join("commercial_registry.seed.json"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            paths.push(parent.join("commercial_registry.seed.json"));
        }
    }
    paths
}

fn ensure_registry_file() {
    let path = registry_path();
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    for seed in seed_path_candidates() {
        if seed.exists() {
            if fs::copy(&seed, &path).is_ok() {
                env_config::app_log(&format!(
                    "[Cache] Seeded commercial registry from {}",
                    seed.display()
                ));
                return;
            }
        }
    }
    let _ = fs::write(&path, "{}\n");
}

fn load_from_disk() -> HashMap<String, String> {
    ensure_registry_file();
    let path = registry_path();
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(ex) => {
            env_config::app_log(&format!(
                "[Cache] Commercial registry read failed ({}): {ex}",
                path.display()
            ));
            return HashMap::new();
        }
    };

    match serde_json::from_str::<HashMap<String, String>>(&content) {
        Ok(map) => map,
        Err(ex) => {
            env_config::app_log(&format!("[Cache] Commercial registry JSON parse error: {ex}"));
            HashMap::new()
        }
    }
}

/// Fast in-memory lookup against the local commercial override map.
pub fn lookup_local(barcode: &str) -> Option<String> {
    let guard = registry_lock().read().ok()?;
    guard.get(barcode).cloned()
}

fn put_memory(barcode: &str, product_name: &str) {
    if let Ok(mut guard) = registry_lock().write() {
        guard.insert(barcode.to_string(), product_name.to_string());
    }
}

/// Fire-and-forget: persist a resolved commercial barcode to `commercial_registry.json`.
pub fn schedule_save(barcode: String, product_name: String) {
    put_memory(&barcode, &product_name);
    tokio::spawn(async move {
        if let Err(ex) = persist_entry(&barcode, &product_name).await {
            env_config::app_log(&format!(
                "[Cache] Commercial registry write failed for {barcode}: {ex}"
            ));
        } else {
            env_config::app_log(&format!(
                "[Cache] Commercial registry saved {barcode} → {product_name}"
            ));
        }
    });
}

async fn persist_entry(barcode: &str, product_name: &str) -> Result<(), String> {
    let path = registry_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|ex| ex.to_string())?;
    }

    let mut map: Map<String, Value> = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|ex| ex.to_string())?;
        serde_json::from_str(&content).unwrap_or_else(|_| Map::new())
    } else {
        Map::new()
    };

    map.insert(
        barcode.to_string(),
        Value::String(product_name.to_string()),
    );

    let json = serde_json::to_string_pretty(&map).map_err(|ex| ex.to_string())?;
    fs::write(&path, format!("{json}\n")).map_err(|ex| ex.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_roundtrip() {
        put_memory("5201236130113", "DEPON MAXIMUM 1000MG EF.TAB");
        assert_eq!(
            lookup_local("5201236130113").as_deref(),
            Some("DEPON MAXIMUM 1000MG EF.TAB")
        );
    }
}
