use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppProfile {
    Test,
    Prod,
}

impl AppProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            AppProfile::Test => "test",
            AppProfile::Prod => "prod",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            AppProfile::Test => "TEST",
            AppProfile::Prod => "PROD",
        }
    }
}

static PROFILE: OnceLock<std::sync::Mutex<AppProfile>> = OnceLock::new();

pub fn profile_mutex() -> &'static std::sync::Mutex<AppProfile> {
    PROFILE.get_or_init(|| std::sync::Mutex::new(load_profile()))
}

pub fn initialize() {
    load_env_files();

    if has_embedded_supabase_config() {
        app_log("[Env] Using compile-time embedded Supabase config (release build)");
    }

    let profile = load_profile();
    *profile_mutex().lock().unwrap() = profile;
    app_log(&format!("[Init] Profile: {:?}", profile));
}

pub fn current_profile() -> AppProfile {
    *profile_mutex().lock().unwrap()
}

pub fn toggle_profile() -> AppProfile {
    let mut guard = profile_mutex().lock().unwrap();
    *guard = if *guard == AppProfile::Test {
        AppProfile::Prod
    } else {
        AppProfile::Test
    };
    save_profile(*guard);
    app_log(&format!("[Profile] Switched to: {}", guard.display_name()));
    *guard
}

pub fn get_env(key: &str) -> Option<String> {
    if let Ok(value) = std::env::var(key) {
        if !value.trim().is_empty() {
            return Some(value.trim().to_string());
        }
    }

    for path in candidate_env_files() {
        if let Some(value) = read_env_from_file(&path, key) {
            return Some(value);
        }
    }

    embedded_env(key)
}

/// Values baked in at compile time (GitHub Actions release builds).
fn embedded_env(key: &str) -> Option<String> {
    let value = match key {
        "SUPABASE_FUNCTIONS_URL" => option_env!("SUPABASE_FUNCTIONS_URL")?,
        "SUPABASE_ANON_KEY" => option_env!("SUPABASE_ANON_KEY")?,
        "PHARMABUDDY_PROFILE" => option_env!("PHARMABUDDY_PROFILE")?,
        _ => return None,
    };

    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn has_embedded_supabase_config() -> bool {
    embedded_env("SUPABASE_FUNCTIONS_URL").is_some() && embedded_env("SUPABASE_ANON_KEY").is_some()
}

fn load_env_files() {
    for path in candidate_env_files() {
        if path.exists() {
            let _ = dotenvy::from_path(&path);
            app_log(&format!("[Env] Loaded {}", path.display()));
        }
    }
}

fn candidate_env_files() -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();

    let starts: Vec<PathBuf> = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf())),
    ]
    .into_iter()
    .flatten()
    .collect();

    for start in starts {
        let mut dir = Some(start.as_path());
        while let Some(d) = dir {
            let candidate = d.join(".env");
            if seen.insert(candidate.clone()) {
                files.push(candidate);
            }
            dir = d.parent();
        }
    }

    files
}

fn read_env_from_file(path: &Path, key: &str) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (k, v) = trimmed.split_once('=')?;
        if k.trim().eq_ignore_ascii_case(key) {
            return Some(v.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn profile_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("pharmaBuddy").join("profile.txt")
}

fn load_profile() -> AppProfile {
    let path = profile_path();
    if path.exists() {
        if let Ok(saved) = fs::read_to_string(&path) {
            if let Some(profile) = parse_profile(&saved) {
                return profile;
            }
        }
    }

    if let Some(from_env) = get_env("PHARMABUDDY_PROFILE") {
        if let Some(profile) = parse_profile(&from_env) {
            return profile;
        }
    }

    AppProfile::Test
}

fn save_profile(profile: AppProfile) {
    let path = profile_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, profile.as_str());
}

fn parse_profile(value: &str) -> Option<AppProfile> {
    match value.trim().to_lowercase().as_str() {
        "test" | "dev" | "mock" => Some(AppProfile::Test),
        "prod" | "production" | "live" => Some(AppProfile::Prod),
        _ => None,
    }
}

pub fn log_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("pharmaBuddy").join("pharmabuddy-tauri.log")
}

pub fn app_log(message: &str) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{message}");
    }
    #[cfg(debug_assertions)]
    eprintln!("{message}");
}
