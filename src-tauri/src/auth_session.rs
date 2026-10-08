use crate::env_config::{self, AppProfile};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const OFFLINE_MESSAGE: &str = "Δεν υπάρχει σύνδεση στο internet";
pub const BAD_CREDENTIALS_MESSAGE: &str = "Λάθος στοιχεία";
pub const DEFAULT_SUPPORT_CONTACT: &str = "69XX XXX XXX";

const KEYRING_SERVICE: &str = "gr.pharmabuddy.widget";
const KEYRING_ACCOUNT: &str = "supabase-session";
const REQUEST_REFRESH_LEAD_SECS: i64 = 5 * 60;
const BACKGROUND_REFRESH_LEAD_SECS: i64 = 20 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthGate {
    pub mode: String,
    pub logged_in: bool,
    pub scans_enabled: bool,
    pub pharmacy_name: Option<String>,
    pub email: Option<String>,
    pub remembered_username: Option<String>,
    pub support_contact: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthFailure {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    user_id: String,
    email: String,
    pharmacy_id: String,
    pharmacy_name: String,
    pharmacy_active: bool,
}

pub struct FunctionAuth {
    pub bearer: String,
    pub apikey: String,
}

static MEMORY: OnceLock<Mutex<Option<StoredSession>>> = OnceLock::new();
static REFRESH_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn memory() -> &'static Mutex<Option<StoredSession>> {
    MEMORY.get_or_init(|| Mutex::new(None))
}

fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    REFRESH_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}

pub fn login_required() -> bool {
    login_required_setting(env_config::current_profile(), env_config::get_env("PHARMABUDDY_REQUIRE_LOGIN").as_deref())
}

pub fn login_required_setting(profile: AppProfile, raw: Option<&str>) -> bool {
    if profile == AppProfile::Test {
        return false;
    }
    match raw {
        Some(value) => !is_falsey(value),
        None => true,
    }
}

fn is_falsey(value: &str) -> bool {
    matches!(value.trim().to_lowercase().as_str(), "0" | "false" | "no" | "off")
}

pub fn support_contact() -> String {
    env_config::get_env("PHARMABUDDY_SUPPORT_CONTACT")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SUPPORT_CONTACT.to_string())
}

pub fn inactive_pharmacy_message(contact: &str) -> String {
    let trimmed = contact.trim().trim_end_matches('.').trim();
    let who = if trimmed.is_empty() {
        DEFAULT_SUPPORT_CONTACT
    } else {
        trimmed
    };
    format!("Ο λογαριασμός του φαρμακείου είναι ανενεργός, επικοινωνήστε στο {who}.")
}

pub fn unassigned_pharmacy_message(contact: &str) -> String {
    let trimmed = contact.trim().trim_end_matches('.').trim();
    let who = if trimmed.is_empty() {
        DEFAULT_SUPPORT_CONTACT
    } else {
        trimmed
    };
    format!("Ο λογαριασμός δεν είναι συνδεδεμένος με φαρμακείο, επικοινωνήστε στο {who}.")
}

pub fn normalize_identifier(raw: &str, domain: Option<&str>) -> Result<String, AuthFailure> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AuthFailure {
            code: "empty",
            message: "Συμπληρώστε email και κωδικό.".into(),
        });
    }
    if trimmed.contains('@') {
        return Ok(trimmed.to_string());
    }
    if let Some(domain) = domain.map(str::trim).filter(|value| !value.is_empty()) {
        let domain = domain.trim_start_matches('@');
        if !domain.is_empty() {
            return Ok(format!("{trimmed}@{domain}"));
        }
    }
    Err(AuthFailure {
        code: "invalid_identifier",
        message: "Χρησιμοποιήστε το email του λογαριασμού.".into(),
    })
}

pub fn needs_refresh(expires_at: i64, now: i64, lead_secs: i64) -> bool {
    expires_at - now <= lead_secs
}

pub fn supabase_origin_from(functions_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(functions_url.trim()).ok()?;
    let host = url.host_str()?;
    let scheme = url.scheme();
    match url.port() {
        Some(port) => Some(format!("{scheme}://{host}:{port}")),
        None => Some(format!("{scheme}://{host}")),
    }
}

pub fn app_data_dir() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let trimmed = local.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("pharmaBuddy");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed)
                .join(".local")
                .join("share")
                .join("pharmaBuddy");
        }
    }
    std::env::temp_dir().join("pharmaBuddy")
}

fn remembered_username_path() -> PathBuf {
    app_data_dir().join("remembered_username.txt")
}

fn session_fallback_path() -> PathBuf {
    app_data_dir().join("session.secret")
}

fn read_remembered_username() -> Option<String> {
    let value = fs::read_to_string(remembered_username_path()).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn write_remembered_username(username: &str) {
    let path = remembered_username_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, username.trim());
}

fn cache_session(session: Option<StoredSession>) {
    if let Ok(mut guard) = memory().lock() {
        *guard = session;
    }
}

fn cached_session() -> Option<StoredSession> {
    memory().lock().ok().and_then(|guard| guard.clone())
}

pub fn cached_pharmacy_id() -> Option<String> {
    cached_session()
        .map(|session| session.pharmacy_id)
        .filter(|id| !id.is_empty())
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|err| err.to_string())
}

fn keyring_load() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn keyring_save(value: &str) -> Result<(), String> {
    keyring_entry()?.set_password(value).map_err(|err| err.to_string())
}

fn keyring_delete() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

fn write_secret_file(value: &str) -> Result<(), String> {
    let path = session_fallback_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|err| err.to_string())?;
    file.write_all(value.as_bytes()).map_err(|err| err.to_string())?;
    Ok(())
}

fn load_session_blob() -> Option<String> {
    // Windows Credential Manager is the session store. Other builds keep the
    // secret in the user app-data folder, never in the repo.
    if cfg!(target_os = "windows") {
        match keyring_load() {
            Ok(Some(value)) if !value.trim().is_empty() => return Some(value),
            Ok(_) => {}
            Err(err) => {
                env_config::app_log(&format!(
                    "[Auth] OS keyring unavailable ({err}); reading the app-data session file"
                ));
            }
        }
    }
    fs::read_to_string(session_fallback_path()).ok()
}

fn save_session_blob(value: &str) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        match keyring_save(value) {
            Ok(()) => {
                let _ = fs::remove_file(session_fallback_path());
                return Ok(());
            }
            Err(err) => {
                env_config::app_log(&format!(
                    "[Auth] OS keyring unavailable ({err}); storing the session in the user app-data folder"
                ));
            }
        }
    }
    write_secret_file(value)
}

fn delete_session_blob() {
    if cfg!(target_os = "windows") {
        if let Err(err) = keyring_delete() {
            env_config::app_log(&format!("[Auth] Keyring delete failed: {err}"));
        }
    }
    let _ = fs::remove_file(session_fallback_path());
}

fn load_session() -> Option<StoredSession> {
    if let Some(session) = cached_session() {
        return Some(session);
    }
    let blob = load_session_blob()?;
    let session = serde_json::from_str::<StoredSession>(&blob).ok()?;
    cache_session(Some(session.clone()));
    Some(session)
}

fn save_session(session: &StoredSession) -> Result<(), String> {
    let json = serde_json::to_string(session).map_err(|err| err.to_string())?;
    save_session_blob(&json)?;
    cache_session(Some(session.clone()));
    Ok(())
}

fn clear_session_storage() {
    cache_session(None);
    delete_session_blob();
}

fn empty_login_gate(error_code: Option<&str>, error_message: Option<String>) -> AuthGate {
    AuthGate {
        mode: "login".into(),
        logged_in: false,
        scans_enabled: false,
        pharmacy_name: None,
        email: None,
        remembered_username: read_remembered_username(),
        support_contact: support_contact(),
        error_code: error_code.map(str::to_string),
        error_message,
    }
}

fn gate_from_session(session: &StoredSession, error_code: Option<&str>, error_message: Option<String>) -> AuthGate {
    let usable = session.pharmacy_active && error_code.is_none();
    AuthGate {
        mode: "login".into(),
        logged_in: true,
        scans_enabled: usable,
        pharmacy_name: Some(session.pharmacy_name.clone()),
        email: Some(session.email.clone()),
        remembered_username: Some(session.email.clone()),
        support_contact: support_contact(),
        error_code: error_code.map(str::to_string),
        error_message,
    }
}

fn test_gate() -> AuthGate {
    AuthGate {
        mode: "test".into(),
        logged_in: false,
        scans_enabled: true,
        pharmacy_name: None,
        email: None,
        remembered_username: None,
        support_contact: support_contact(),
        error_code: None,
        error_message: None,
    }
}

fn legacy_gate() -> AuthGate {
    AuthGate {
        mode: "legacy".into(),
        logged_in: false,
        scans_enabled: false,
        pharmacy_name: None,
        email: None,
        remembered_username: None,
        support_contact: support_contact(),
        error_code: None,
        error_message: None,
    }
}

fn map_transport_error(err: &reqwest::Error) -> AuthFailure {
    if err.is_builder() {
        AuthFailure {
            code: "config",
            message: format!("Σφάλμα ρυθμίσεων: {err}"),
        }
    } else {
        AuthFailure {
            code: "offline",
            message: OFFLINE_MESSAGE.into(),
        }
    }
}

fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn supabase_settings() -> Result<(String, String), AuthFailure> {
    let functions_url = env_config::get_env("SUPABASE_FUNCTIONS_URL").ok_or_else(|| AuthFailure {
        code: "config",
        message: "Λείπει SUPABASE_FUNCTIONS_URL στο .env.".into(),
    })?;
    let origin = supabase_origin_from(&functions_url).ok_or_else(|| AuthFailure {
        code: "config",
        message: "Μη έγκυρο SUPABASE_FUNCTIONS_URL.".into(),
    })?;
    let anon = env_config::get_env("SUPABASE_ANON_KEY").ok_or_else(|| AuthFailure {
        code: "config",
        message: "Λείπει SUPABASE_ANON_KEY στο .env.".into(),
    })?;
    Ok((origin, anon))
}

fn login_email_domain() -> Option<String> {
    env_config::get_env("PHARMABUDDY_LOGIN_EMAIL_DOMAIN")
}

struct TokenBundle {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    user_id: String,
    email: String,
}

fn parse_token_response(body: &str, fallback_email: Option<&str>) -> Result<TokenBundle, AuthFailure> {
    let parsed: Value = serde_json::from_str(body).map_err(|_| AuthFailure {
        code: "invalid_credentials",
        message: BAD_CREDENTIALS_MESSAGE.into(),
    })?;
    let access_token = parsed
        .get("access_token")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let refresh_token = parsed
        .get("refresh_token")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if access_token.is_empty() || refresh_token.is_empty() {
        return Err(AuthFailure {
            code: "invalid_credentials",
            message: BAD_CREDENTIALS_MESSAGE.into(),
        });
    }
    let expires_at = expiry_from_payload(&parsed);
    let user = parsed.get("user");
    let user_id = user
        .and_then(|value| value.get("id"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let email = user
        .and_then(|value| value.get("email"))
        .and_then(|value| value.as_str())
        .or(fallback_email)
        .unwrap_or("")
        .to_string();
    Ok(TokenBundle {
        access_token,
        refresh_token,
        expires_at,
        user_id,
        email,
    })
}

fn expiry_from_payload(parsed: &Value) -> i64 {
    if let Some(seconds) = parsed.get("expires_in").and_then(|value| value.as_i64()) {
        return now_unix() + seconds;
    }
    if let Some(expires_at) = parsed.get("expires_at").and_then(|value| value.as_i64()) {
        if expires_at > 1_000_000_000_000 {
            return expires_at / 1000;
        }
        if expires_at > 1_000_000_000 {
            return expires_at;
        }
    }
    now_unix() + 3600
}

fn classify_token_status(status: u16) -> AuthFailure {
    if status == 400 || status == 401 || status == 403 || status == 422 {
        return AuthFailure {
            code: "invalid_credentials",
            message: BAD_CREDENTIALS_MESSAGE.into(),
        };
    }
    if status == 429 {
        return AuthFailure {
            code: "rate_limited",
            message: "Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.".into(),
        };
    }
    AuthFailure {
        code: "server",
        message: format!("Η υπηρεσία σύνδεσης απάντησε με σφάλμα ({status})."),
    }
}

async fn request_token(grant_url: &str, anon: &str, payload: &Value) -> Result<TokenBundle, AuthFailure> {
    let client = http_client(Duration::from_secs(15));
    let response = client
        .post(grant_url)
        .header("apikey", anon)
        .header("Content-Type", "application/json")
        .json(payload)
        .send()
        .await
        .map_err(|err| map_transport_error(&err))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        env_config::app_log(&format!("[Auth] Token endpoint HTTP {}", status.as_u16()));
        return Err(classify_token_status(status.as_u16()));
    }
    let email = payload.get("email").and_then(|value| value.as_str());
    parse_token_response(&body, email)
}

struct Membership {
    pharmacy_id: String,
    pharmacy_name: String,
    active: bool,
}

async fn fetch_membership(origin: &str, anon: &str, token: &str, user_id: &str) -> Result<Membership, AuthFailure> {
    let url = format!(
        "{origin}/rest/v1/pharmacy_members?user_id=eq.{user_id}&select=pharmacy_id,pharmacies(id,name,active)&limit=1"
    );
    let client = http_client(Duration::from_secs(15));
    let response = client
        .get(url)
        .header("apikey", anon)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| map_transport_error(&err))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.as_u16() == 401 {
        return Err(AuthFailure {
            code: "invalid_credentials",
            message: BAD_CREDENTIALS_MESSAGE.into(),
        });
    }
    if !status.is_success() {
        env_config::app_log(&format!(
            "[Auth] Membership lookup HTTP {} {}",
            status.as_u16(),
            body.chars().take(180).collect::<String>()
        ));
        return Err(AuthFailure {
            code: "server",
            message: "Αποτυχία ελέγχου φαρμακείου.".into(),
        });
    }
    let rows: Vec<Value> = serde_json::from_str(&body).map_err(|_| AuthFailure {
        code: "server",
        message: "Μη έγκυρη απάντηση φαρμακείου.".into(),
    })?;
    let Some(row) = rows.first() else {
        return Err(AuthFailure {
            code: "pharmacy_unassigned",
            message: unassigned_pharmacy_message(&support_contact()),
        });
    };
    let embedded = row.get("pharmacies").cloned().unwrap_or(Value::Null);
    let pharmacy = if let Some(first) = embedded.as_array().and_then(|items| items.first()) {
        first
    } else {
        &embedded
    };
    let active = pharmacy.get("active").and_then(|value| value.as_bool()) == Some(true);
    let pharmacy_id = pharmacy
        .get("id")
        .and_then(|value| value.as_str())
        .or_else(|| row.get("pharmacy_id").and_then(|value| value.as_str()))
        .unwrap_or("")
        .to_string();
    let pharmacy_name = pharmacy
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("Φαρμακείο")
        .to_string();
    if pharmacy_id.is_empty() {
        return Err(AuthFailure {
            code: "pharmacy_unassigned",
            message: unassigned_pharmacy_message(&support_contact()),
        });
    }
    Ok(Membership {
        pharmacy_id,
        pharmacy_name,
        active,
    })
}

fn session_from_parts(token: TokenBundle, membership: Membership) -> StoredSession {
    StoredSession {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_at,
        user_id: token.user_id,
        email: token.email,
        pharmacy_id: membership.pharmacy_id,
        pharmacy_name: membership.pharmacy_name,
        pharmacy_active: membership.active,
    }
}

fn inactive_failure() -> AuthFailure {
    AuthFailure {
        code: "pharmacy_inactive",
        message: inactive_pharmacy_message(&support_contact()),
    }
}

async fn establish_session(token: TokenBundle) -> Result<StoredSession, AuthFailure> {
    let (origin, anon) = supabase_settings()?;
    let membership = fetch_membership(&origin, &anon, &token.access_token, &token.user_id).await?;
    let session = session_from_parts(token, membership);
    save_session(&session).map_err(|err| AuthFailure {
        code: "store",
        message: format!("Αποτυχία αποθήκευσης σύνδεσης: {err}"),
    })?;
    write_remembered_username(&session.email);
    if !session.pharmacy_active {
        env_config::app_log(&format!(
            "[Auth] Inactive pharmacy {} for user {}",
            session.pharmacy_id, session.user_id
        ));
        return Err(inactive_failure());
    }
    env_config::app_log(&format!(
        "[Auth] Session ready pharmacy_id={} user_id={}",
        session.pharmacy_id, session.user_id
    ));
    Ok(session)
}

pub async fn login(identifier: String, password: String) -> AuthGate {
    let _guard = refresh_lock().lock().await;
    if !login_required() {
        return if env_config::current_profile() == AppProfile::Test {
            test_gate()
        } else {
            legacy_gate()
        };
    }
    if password.trim().is_empty() || identifier.trim().is_empty() {
        return empty_login_gate(Some("empty"), Some("Συμπληρώστε email και κωδικό.".into()));
    }
    let email = match normalize_identifier(&identifier, login_email_domain().as_deref()) {
        Ok(email) => email,
        Err(err) => return empty_login_gate(Some(err.code), Some(err.message)),
    };
    write_remembered_username(&identifier);
    let (origin, anon) = match supabase_settings() {
        Ok(settings) => settings,
        Err(err) => return empty_login_gate(Some(err.code), Some(err.message)),
    };
    let token = match request_token(
        &format!("{origin}/auth/v1/token?grant_type=password"),
        &anon,
        &serde_json::json!({ "email": email, "password": password }),
    )
    .await
    {
        Ok(token) => token,
        Err(err) => {
            env_config::app_log(&format!("[Auth] Login failed code={}", err.code));
            return empty_login_gate(Some(err.code), Some(err.message));
        }
    };
    if token.user_id.is_empty() {
        return empty_login_gate(
            Some("invalid_credentials"),
            Some(BAD_CREDENTIALS_MESSAGE.into()),
        );
    }
    match establish_session(token).await {
        Ok(session) => gate_from_session(&session, None, None),
        Err(err) if err.code == "pharmacy_inactive" => {
            if let Some(session) = cached_session() {
                gate_from_session(&session, Some(err.code), Some(err.message))
            } else {
                empty_login_gate(Some(err.code), Some(err.message))
            }
        }
        Err(err) => empty_login_gate(Some(err.code), Some(err.message)),
    }
}

pub async fn logout() -> AuthGate {
    let _guard = refresh_lock().lock().await;
    clear_session_storage();
    env_config::app_log("[Auth] Logged out");
    if !login_required() {
        return if env_config::current_profile() == AppProfile::Test {
            test_gate()
        } else {
            legacy_gate()
        };
    }
    empty_login_gate(None, None)
}

pub async fn current_gate() -> AuthGate {
    let _guard = refresh_lock().lock().await;
    if env_config::current_profile() == AppProfile::Test {
        return test_gate();
    }
    if !login_required() {
        return legacy_gate();
    }
    let Some(session) = load_session() else {
        return empty_login_gate(None, None);
    };
    match refresh_session_locked(&session, REQUEST_REFRESH_LEAD_SECS, true).await {
        Ok(updated) => {
            if updated.pharmacy_active {
                gate_from_session(&updated, None, None)
            } else {
                gate_from_session(&updated, Some("pharmacy_inactive"), Some(inactive_pharmacy_message(&support_contact())))
            }
        }
        Err(err) if err.code == "offline" => {
            if session.pharmacy_active && session.expires_at - now_unix() > 30 {
                env_config::app_log("[Auth] Offline at startup; keeping the current session");
                gate_from_session(&session, None, None)
            } else if !session.pharmacy_active {
                gate_from_session(
                    &session,
                    Some("pharmacy_inactive"),
                    Some(inactive_pharmacy_message(&support_contact())),
                )
            } else {
                empty_login_gate(Some(err.code), Some(err.message))
            }
        }
        Err(err) if err.code == "pharmacy_inactive" => {
            if let Some(session) = cached_session() {
                gate_from_session(&session, Some("pharmacy_inactive"), Some(err.message))
            } else {
                empty_login_gate(Some("pharmacy_inactive"), Some(err.message))
            }
        }
        Err(err) if err.code == "server" || err.code == "store" => {
            if session.pharmacy_active && session.expires_at - now_unix() > 30 {
                env_config::app_log("[Auth] Pharmacy recheck failed; keeping the current session");
                gate_from_session(&session, None, None)
            } else {
                empty_login_gate(Some(err.code), Some(err.message))
            }
        }
        Err(err) => {
            clear_session_storage();
            empty_login_gate(Some(err.code), Some(err.message))
        }
    }
}

async fn refresh_session_locked(
    session: &StoredSession,
    lead_secs: i64,
    refresh_pharmacy: bool,
) -> Result<StoredSession, AuthFailure> {
    let token_fresh = !needs_refresh(session.expires_at, now_unix(), lead_secs);
    let token = if token_fresh {
        TokenBundle {
            access_token: session.access_token.clone(),
            refresh_token: session.refresh_token.clone(),
            expires_at: session.expires_at,
            user_id: session.user_id.clone(),
            email: session.email.clone(),
        }
    } else {
        let (origin, anon) = supabase_settings()?;
        match request_token(
            &format!("{origin}/auth/v1/token?grant_type=refresh_token"),
            &anon,
            &serde_json::json!({ "refresh_token": session.refresh_token }),
        )
        .await
        {
            Ok(mut refreshed) => {
                if refreshed.user_id.is_empty() {
                    refreshed.user_id = session.user_id.clone();
                }
                if refreshed.email.is_empty() {
                    refreshed.email = session.email.clone();
                }
                refreshed
            }
            Err(err) if err.code == "invalid_credentials" => {
                return Err(AuthFailure {
                    code: "expired",
                    message: "Η σύνδεση έληξε. Συνδεθείτε ξανά.".into(),
                });
            }
            Err(err) => return Err(err),
        }
    };

    if refresh_pharmacy || !token_fresh {
        let (origin, anon) = supabase_settings()?;
        let membership = fetch_membership(&origin, &anon, &token.access_token, &token.user_id).await?;
        let updated = session_from_parts(token, membership);
        save_session(&updated).map_err(|err| AuthFailure {
            code: "store",
            message: format!("Αποτυχία αποθήκευσης σύνδεσης: {err}"),
        })?;
        if !updated.pharmacy_active {
            return Err(inactive_failure());
        }
        return Ok(updated);
    }

    Ok(session.clone())
}

pub async fn refresh_if_due() {
    if !login_required() {
        return;
    }
    let _guard = refresh_lock().lock().await;
    let Some(session) = load_session() else {
        return;
    };
    if !needs_refresh(session.expires_at, now_unix(), BACKGROUND_REFRESH_LEAD_SECS) {
        return;
    }
    match refresh_session_locked(&session, BACKGROUND_REFRESH_LEAD_SECS, false).await {
        Ok(updated) => {
            env_config::app_log(&format!(
                "[Auth] Refreshed session pharmacy_id={} user_id={}",
                updated.pharmacy_id, updated.user_id
            ));
        }
        Err(err) => {
            env_config::app_log(&format!("[Auth] Background refresh failed code={}", err.code));
            if err.code == "expired" {
                clear_session_storage();
            }
        }
    }
}

async fn ensure_access_token_locked() -> Result<String, AuthFailure> {
    let session = load_session().ok_or_else(|| AuthFailure {
        code: "logged_out",
        message: "Απαιτείται σύνδεση.".into(),
    })?;
    if !session.pharmacy_active {
        return Err(inactive_failure());
    }
    if !needs_refresh(session.expires_at, now_unix(), REQUEST_REFRESH_LEAD_SECS) {
        return Ok(session.access_token);
    }
    match refresh_session_locked(&session, REQUEST_REFRESH_LEAD_SECS, false).await {
        Ok(updated) => Ok(updated.access_token),
        Err(err) if err.code == "offline" && session.expires_at - now_unix() > 30 => {
            Ok(session.access_token)
        }
        Err(err) => Err(err),
    }
}

pub async fn function_auth() -> Result<FunctionAuth, String> {
    let apikey = env_config::get_env("SUPABASE_ANON_KEY")
        .ok_or_else(|| "Λείπει SUPABASE_ANON_KEY στο .env".to_string())?;
    if !login_required() {
        return Ok(FunctionAuth {
            bearer: apikey.clone(),
            apikey,
        });
    }
    let _guard = refresh_lock().lock().await;
    match ensure_access_token_locked().await {
        Ok(bearer) => Ok(FunctionAuth { bearer, apikey }),
        Err(err) if err.code == "offline" => Err(format!("Σφάλμα δικτύου: {OFFLINE_MESSAGE}")),
        Err(err) => Err(err.message),
    }
}

pub async fn post_edge(url: &str, payload: &Value, timeout: Duration) -> Result<(u16, String), String> {
    let auth = function_auth().await?;
    let first = post_with_auth(&auth, url, payload, timeout).await?;
    if first.0 != 401 || !login_required() {
        return Ok(first);
    }
    env_config::app_log("[Auth] Edge function returned 401; refreshing once");
    {
        let _guard = refresh_lock().lock().await;
        if let Some(session) = load_session() {
            let expired = StoredSession {
                expires_at: 0,
                ..session
            };
            if let Err(err) = refresh_session_locked(&expired, REQUEST_REFRESH_LEAD_SECS, false).await {
                if err.code == "offline" {
                    return Err(format!("Σφάλμα δικτύου: {OFFLINE_MESSAGE}"));
                }
                if err.code == "expired" || err.code == "invalid_credentials" {
                    clear_session_storage();
                }
                return Ok(first);
            }
        }
    }
    let auth = function_auth().await?;
    post_with_auth(&auth, url, payload, timeout).await
}

async fn post_with_auth(
    auth: &FunctionAuth,
    url: &str,
    payload: &Value,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let client = http_client(timeout);
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", auth.bearer))
        .header("apikey", &auth.apikey)
        .header("Accept", "application/json")
        .json(payload)
        .send()
        .await
        .map_err(|err| {
            if err.is_builder() {
                format!("Σφάλμα αιτήματος: {err}")
            } else {
                format!("Σφάλμα δικτύου: {err}")
            }
        })?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok((status, body))
}

pub async fn session_block_message(status: u16, body: &str) -> Option<String> {
    if body.contains("pharmacy_inactive") {
        mark_pharmacy_inactive().await;
        return Some(inactive_pharmacy_message(&support_contact()));
    }
    if body.contains("pharmacy_unassigned") {
        let _guard = refresh_lock().lock().await;
        clear_session_storage();
        return Some(unassigned_pharmacy_message(&support_contact()));
    }
    if login_required() && (status == 401 || body.contains("\"unauthorized\"")) {
        let _guard = refresh_lock().lock().await;
        clear_session_storage();
        return Some("Η σύνδεση έληξε. Συνδεθείτε ξανά.".into());
    }
    None
}

pub async fn mark_pharmacy_inactive() {
    let _guard = refresh_lock().lock().await;
    let Some(mut session) = load_session() else {
        return;
    };
    session.pharmacy_active = false;
    if let Err(err) = save_session(&session) {
        env_config::app_log(&format!("[Auth] Failed to persist inactive flag: {err}"));
    }
    env_config::app_log(&format!(
        "[Auth] Pharmacy deactivated pharmacy_id={} user_id={}",
        session.pharmacy_id, session.user_id
    ));
}

pub fn request_pharmacy_id() -> String {
    if login_required() {
        cached_pharmacy_id().unwrap_or_default()
    } else {
        crate::pharmacy_config::get_pharmacy_id().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_profile_never_requires_login() {
        assert!(!login_required_setting(AppProfile::Test, None));
        assert!(!login_required_setting(AppProfile::Test, Some("true")));
    }

    #[test]
    fn prod_requires_login_unless_flag_is_off() {
        assert!(login_required_setting(AppProfile::Prod, None));
        assert!(login_required_setting(AppProfile::Prod, Some("true")));
        assert!(login_required_setting(AppProfile::Prod, Some("yes")));
        assert!(!login_required_setting(AppProfile::Prod, Some("false")));
        assert!(!login_required_setting(AppProfile::Prod, Some("0")));
        assert!(!login_required_setting(AppProfile::Prod, Some("off")));
    }

    #[test]
    fn greek_auth_messages_match_the_widget() {
        assert_eq!(BAD_CREDENTIALS_MESSAGE, "Λάθος στοιχεία");
        assert_eq!(OFFLINE_MESSAGE, "Δεν υπάρχει σύνδεση στο internet");
        assert_eq!(DEFAULT_SUPPORT_CONTACT, "69XX XXX XXX");
        assert_eq!(
            inactive_pharmacy_message("210 000 0000"),
            "Ο λογαριασμός του φαρμακείου είναι ανενεργός, επικοινωνήστε στο 210 000 0000."
        );
        assert_eq!(
            inactive_pharmacy_message("  69XX XXX XXX. "),
            "Ο λογαριασμός του φαρμακείου είναι ανενεργός, επικοινωνήστε στο 69XX XXX XXX."
        );
    }

    #[test]
    fn username_without_at_uses_optional_domain() {
        let email = normalize_identifier("pilot", Some("pharmacies.pharmabuddy.gr")).unwrap();
        assert_eq!(email, "pilot@pharmacies.pharmabuddy.gr");
        let kept = normalize_identifier(" Pilot@Example.com ", None).unwrap();
        assert_eq!(kept, "Pilot@Example.com");
        assert!(normalize_identifier("pilot", None).is_err());
    }

    #[test]
    fn refresh_lead_window() {
        assert!(needs_refresh(1_000, 900, 120));
        assert!(!needs_refresh(1_000, 800, 120));
    }

    #[test]
    fn origin_comes_from_the_functions_url() {
        let origin = supabase_origin_from(
            "https://abc.supabase.co/functions/v1/get-ai-recommendation",
        )
        .unwrap();
        assert_eq!(origin, "https://abc.supabase.co");
    }

    #[test]
    fn expiry_prefers_expires_in() {
        let parsed = serde_json::json!({ "expires_in": 3600 });
        let expires_at = expiry_from_payload(&parsed);
        let now = now_unix();
        assert!(expires_at >= now + 3500 && expires_at <= now + 3700);
    }
}
