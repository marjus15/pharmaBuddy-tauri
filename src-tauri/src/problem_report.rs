use crate::auth_session::{self, OFFLINE_MESSAGE};
use crate::env_config::{self, AppProfile};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Last slice of the widget log attached to a report.
pub const LOG_CAP_BYTES: usize = 48 * 1024;
pub const MESSAGE_MAX_CHARS: usize = 2_000;

const REFERENCE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportChannel {
    /// PROD login build: edge function, pharmacy id taken from the user JWT.
    Remote,
    /// TEST profile and the PHARMABUDDY_REQUIRE_LOGIN=false backup build.
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportParts {
    pub message: Option<String>,
    pub app_version: String,
    pub profile: String,
    pub os_info: String,
    pub logs: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProblemReportResponse {
    pub ok: bool,
    pub reference_code: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

pub fn report_channel(login_required: bool) -> ReportChannel {
    if login_required {
        ReportChannel::Remote
    } else {
        ReportChannel::Local
    }
}

pub fn describe_os(os: &str, arch: &str) -> String {
    format!("{os} {arch}")
}

pub fn current_os_info() -> String {
    describe_os(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn problem_report_url(functions_url: &str) -> Option<String> {
    let trimmed = functions_url.trim().trim_end_matches('/');
    let (base, _) = trimmed.rsplit_once('/')?;
    if !base.contains("/functions/") {
        return None;
    }
    Some(format!("{base}/submit-problem-report"))
}

pub fn reference_from_bytes(bytes: [u8; 4]) -> String {
    bytes
        .iter()
        .map(|byte| REFERENCE_ALPHABET[(byte % REFERENCE_ALPHABET.len() as u8) as usize] as char)
        .collect()
}

pub fn reference_is_phone_safe(code: &str) -> bool {
    code.len() == 4
        && code
            .bytes()
            .all(|byte| REFERENCE_ALPHABET.contains(&byte))
}

pub fn random_reference_code() -> String {
    let mut bytes = [0u8; 4];
    rand::Rng::fill(&mut rand::thread_rng(), &mut bytes[..]);
    reference_from_bytes(bytes)
}

/// Tail of the log, preferring the current session (`[Init]`) when it fits.
pub fn recent_log_excerpt(contents: &str, cap_bytes: usize) -> String {
    if cap_bytes == 0 || contents.is_empty() {
        return String::new();
    }
    let tail = tail_str(contents, cap_bytes);
    if let Some(index) = tail.rfind("[Init]") {
        return tail[index..].to_string();
    }
    tail
}

fn tail_str(contents: &str, cap_bytes: usize) -> String {
    if contents.len() <= cap_bytes {
        return contents.to_string();
    }
    let mut start = contents.len() - cap_bytes;
    while start < contents.len() && !contents.is_char_boundary(start) {
        start += 1;
    }
    if let Some(newline) = contents[start..].find('\n') {
        if newline < 240 && start + newline + 1 < contents.len() {
            start += newline + 1;
        }
    }
    contents[start..].to_string()
}

pub fn clip_chars(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    input.chars().take(max_chars).collect()
}

const SECRET_KEYS: &[&str] = &[
    "refresh_token",
    "access_token",
    "private_key",
    "service_role",
    "id_token",
    "authorization",
    "api_key",
    "anon_key",
    "password",
    "passwd",
    "apikey",
];

/// Strip passwords, API keys, bearer tokens, and JWTs before a report leaves the PC.
pub fn redact_secrets(input: &str) -> String {
    redact_jwts(&redact_bearer(&redact_keyed_secrets(input)))
}

fn redact_keyed_secrets(input: &str) -> String {
    let lower = input.to_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if let Some(key) = secret_key_at(&lower, index) {
            if let Some((value_start, value_end)) = secret_value_range(input, index + key.len()) {
                out.push_str(&input[index..value_start]);
                out.push_str("[REDACTED]");
                index = value_end;
                continue;
            }
        }
        let ch = input[index..].chars().next().unwrap_or('\0');
        if ch == '\0' {
            break;
        }
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn secret_key_at(lower: &str, index: usize) -> Option<&'static str> {
    if index > 0 {
        let prev = lower[..index].chars().next_back()?;
        if prev.is_ascii_alphanumeric() || prev == '_' {
            return None;
        }
    }
    for key in SECRET_KEYS {
        if !lower[index..].starts_with(key) {
            continue;
        }
        let after = index + key.len();
        if after < lower.len() {
            let next = lower[after..].chars().next().unwrap_or('\0');
            if next.is_ascii_alphanumeric() || next == '_' {
                continue;
            }
        }
        return Some(*key);
    }
    None
}

fn secret_value_range(input: &str, mut index: usize) -> Option<(usize, usize)> {
    let bytes = input.as_bytes();
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index < bytes.len() && bytes[index] == b'"' {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
    }
    if index >= bytes.len() || (bytes[index] != b':' && bytes[index] != b'=') {
        return None;
    }
    index += 1;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() {
        return None;
    }
    if bytes[index] == b'"' {
        index += 1;
        let start = index;
        while index < bytes.len() {
            if bytes[index] == b'\\' {
                index = (index + 2).min(bytes.len());
                continue;
            }
            if bytes[index] == b'"' {
                break;
            }
            index += 1;
        }
        if start == index {
            return None;
        }
        return Some((start, index));
    }
    let start = index;
    while index < bytes.len()
        && !matches!(
            bytes[index],
            b' ' | b'\n' | b'\r' | b'\t' | b',' | b'&' | b'}' | b';'
        )
    {
        index += 1;
    }
    if start == index {
        None
    } else {
        Some((start, index))
    }
}

fn redact_bearer(input: &str) -> String {
    let lower = input.to_lowercase();
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let boundary_ok = index == 0
            || !lower[..index]
                .chars()
                .next_back()
                .unwrap_or(' ')
                .is_ascii_alphanumeric();
        if boundary_ok && lower[index..].starts_with("bearer ") {
            let mut cursor = index + "bearer ".len();
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            let start = cursor;
            while cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() && bytes[cursor] != b',' {
                cursor += 1;
            }
            if start < cursor {
                out.push_str("Bearer ");
                out.push_str("[REDACTED]");
                index = cursor;
                continue;
            }
        }
        let ch = input[index..].chars().next().unwrap_or('\0');
        if ch == '\0' {
            break;
        }
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn redact_jwts(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < bytes.len() {
        let boundary_ok = index == 0 || !is_token_char(bytes[index - 1]);
        if boundary_ok && bytes[index..].starts_with(b"eyJ") {
            if let Some(end) = jwt_end(bytes, index) {
                out.push_str("[REDACTED]");
                index = end;
                continue;
            }
        }
        let ch = input[index..].chars().next().unwrap_or('\0');
        if ch == '\0' {
            break;
        }
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn is_token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn jwt_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start;
    let mut dots = 0;
    let mut segment = 0;
    while index < bytes.len() && (is_token_char(bytes[index]) || bytes[index] == b'.') {
        if bytes[index] == b'.' {
            if segment < 8 {
                return None;
            }
            dots += 1;
            segment = 0;
            if dots > 2 {
                return None;
            }
        } else {
            segment += 1;
        }
        index += 1;
    }
    if dots == 2 && segment >= 8 {
        Some(index)
    } else {
        None
    }
}

pub fn assemble_report(
    message: Option<&str>,
    app_version: &str,
    profile: &str,
    os_info: &str,
    raw_logs: &str,
) -> ReportParts {
    let message = message
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| redact_secrets(&clip_chars(value, MESSAGE_MAX_CHARS)));
    let logs = redact_secrets(&recent_log_excerpt(raw_logs, LOG_CAP_BYTES));
    ReportParts {
        message,
        app_version: clip_chars(app_version.trim(), 40),
        profile: profile.trim().to_string(),
        os_info: clip_chars(os_info.trim(), 200),
        logs,
    }
}

pub fn build_report_payload(parts: &ReportParts) -> Value {
    json!({
        "message": parts.message,
        "app_version": parts.app_version,
        "profile": parts.profile,
        "os_info": parts.os_info,
        "logs": parts.logs,
    })
}

pub fn classify_submit_error(err: &str) -> (&'static str, String) {
    let lower = err.to_lowercase();
    if lower.contains("δικτύ")
        || lower.contains("network")
        || lower.contains("offline")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || err.contains(OFFLINE_MESSAGE)
    {
        return ("offline", OFFLINE_MESSAGE.to_string());
    }
    if lower.contains("σύνδεση") || lower.contains("unauthorized") || lower.contains("logged") {
        return ("logged_out", "Απαιτείται σύνδεση.".into());
    }
    ("server", "Η αναφορά δεν στάλθηκε. Δοκιμάστε ξανά.".into())
}

fn ok_response(code: String) -> ProblemReportResponse {
    ProblemReportResponse {
        ok: true,
        reference_code: Some(code),
        error_code: None,
        error_message: None,
    }
}

fn err_response(code: &str, message: String) -> ProblemReportResponse {
    ProblemReportResponse {
        ok: false,
        reference_code: None,
        error_code: Some(code.to_string()),
        error_message: Some(message),
    }
}

pub fn local_report_path(app_data: &Path, code: &str) -> PathBuf {
    app_data.join("problem-reports").join(format!("{code}.json"))
}

pub fn save_local_report(app_data: &Path, parts: &ReportParts, code: &str) -> Result<(), String> {
    let path = local_report_path(app_data, code);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let body = json!({
        "reference_code": code,
        "delivery": "local",
        "message": parts.message,
        "app_version": parts.app_version,
        "profile": parts.profile,
        "os_info": parts.os_info,
        "logs": parts.logs,
    });
    fs::write(&path, serde_json::to_string_pretty(&body).map_err(|err| err.to_string())?)
        .map_err(|err| err.to_string())
}

fn read_widget_log() -> String {
    fs::read_to_string(env_config::log_path()).unwrap_or_default()
}

pub async fn submit(message: Option<String>, app_version: &str) -> ProblemReportResponse {
    let profile = env_config::current_profile();
    let parts = assemble_report(
        message.as_deref(),
        app_version,
        profile.display_name(),
        &current_os_info(),
        &read_widget_log(),
    );
    let channel = report_channel(auth_session::login_required());
    match channel {
        ReportChannel::Local => submit_local(&parts, profile),
        ReportChannel::Remote => submit_remote(&parts).await,
    }
}

fn submit_local(parts: &ReportParts, profile: AppProfile) -> ProblemReportResponse {
    let code = random_reference_code();
    let dir = auth_session::app_data_dir();
    match save_local_report(&dir, parts, &code) {
        Ok(()) => {
            env_config::app_log(&format!(
                "[Report] Saved locally code={code} profile={}",
                profile.display_name()
            ));
            ok_response(code)
        }
        Err(err) => {
            env_config::app_log(&format!("[Report] Local save failed: {err}"));
            err_response("server", "Η αναφορά δεν στάλθηκε. Δοκιμάστε ξανά.".into())
        }
    }
}

async fn submit_remote(parts: &ReportParts) -> ProblemReportResponse {
    let functions_url = match env_config::get_env("SUPABASE_FUNCTIONS_URL") {
        Some(url) => url,
        None => {
            return err_response("server", "Λείπει SUPABASE_FUNCTIONS_URL στο .env.".into());
        }
    };
    let url = match problem_report_url(&functions_url) {
        Some(url) => url,
        None => {
            return err_response("server", "Μη έγκυρο SUPABASE_FUNCTIONS_URL.".into());
        }
    };
    let payload = build_report_payload(parts);
    let result = auth_session::post_edge(&url, &payload, Duration::from_secs(20)).await;
    let (status, body) = match result {
        Ok(pair) => pair,
        Err(err) => {
            let (code, message) = classify_submit_error(&err);
            env_config::app_log(&format!("[Report] Send failed code={code}"));
            return err_response(code, message);
        }
    };
    if let Some(message) = auth_session::session_block_message(status, &body).await {
        let code = if message == OFFLINE_MESSAGE {
            "offline"
        } else if message.contains("σύνδεση") || message.contains("Συνδεθείτε") {
            "logged_out"
        } else {
            "server"
        };
        env_config::app_log(&format!("[Report] Rejected HTTP {status} code={code}"));
        return err_response(code, message);
    }
    if !(200..300).contains(&status) {
        let (code, message) = if status == 401 {
            ("logged_out", "Απαιτείται σύνδεση.".into())
        } else {
            classify_submit_error(&body)
        };
        env_config::app_log(&format!("[Report] HTTP {status} code={code}"));
        return err_response(code, message);
    }
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) => {
            env_config::app_log("[Report] Response was not JSON");
            return err_response("server", "Η αναφορά δεν στάλθηκε. Δοκιμάστε ξανά.".into());
        }
    };
    let code = parsed
        .get("reference_code")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if !reference_is_phone_safe(&code) {
        env_config::app_log("[Report] Response missing a reference code");
        return err_response("server", "Η αναφορά δεν στάλθηκε. Δοκιμάστε ξανά.".into());
    }
    env_config::app_log(&format!("[Report] Submitted code={code}"));
    ok_response(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_and_backup_builds_stay_local() {
        assert_eq!(report_channel(true), ReportChannel::Remote);
        assert_eq!(report_channel(false), ReportChannel::Local);
    }

    #[test]
    fn reference_code_is_four_phone_safe_characters() {
        let code = reference_from_bytes([0, 1, 10, 31]);
        assert_eq!(code.len(), 4);
        assert!(reference_is_phone_safe(&code));
        assert!(!code.contains('0'));
        assert!(!code.contains('O'));
        assert!(!code.contains('1'));
        assert!(!code.contains('I'));
        assert!(reference_is_phone_safe("A2B3"));
        assert!(!reference_is_phone_safe("A1B2"));
        assert!(!reference_is_phone_safe("ABCD5"));
    }

    #[test]
    fn recent_log_prefers_the_last_session_and_caps_the_tail() {
        let older = "[Init] Profile: old\n".repeat(20);
        let current = format!("{older}[Init] Profile: current\nbarcode 5200000000001\n");
        let excerpt = recent_log_excerpt(&current, 80);
        assert!(excerpt.contains("[Init] Profile: current"));
        assert!(!excerpt.contains("Profile: old"));

        let huge = format!("{}END", "x".repeat(LOG_CAP_BYTES + 500));
        let tail = recent_log_excerpt(&huge, 100);
        assert!(tail.ends_with("END"));
        assert!(tail.len() <= 100);
    }

    #[test]
    fn payload_redacts_secrets_and_keeps_the_note_and_barcode() {
        let logs = r#"
[Init] Profile: Prod
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N
password=super-secret-pharmacy
{"access_token":"token-aaa","refresh_token":"token-bbb"}
apikey: sb_secret_should_not_leave
barcode 5201234567890
"#;
        let parts = assemble_report(
            Some("έπεσε το scan password=nope και ο κωδικός φαίνεται σωστός"),
            "0.1.0",
            "PROD",
            "windows x86_64",
            logs,
        );
        let payload = build_report_payload(&parts);
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("super-secret"));
        assert!(!json.contains("token-aaa"));
        assert!(!json.contains("token-bbb"));
        assert!(!json.contains("sb_secret_should_not_leave"));
        assert!(!json.contains("eyJ"));
        assert!(!json.contains("password=nope"));
        assert!(json.contains("[REDACTED]"));
        assert!(json.contains("5201234567890"));
        assert!(json.contains("έπεσε το scan"));
        assert!(json.contains("κωδικός φαίνεται σωστός"));
        assert_eq!(payload["app_version"], "0.1.0");
        assert_eq!(payload["profile"], "PROD");
        assert_eq!(payload["os_info"], "windows x86_64");
        assert!(payload.get("pharmacy_id").is_none());
    }

    #[test]
    fn empty_note_is_omitted_and_offline_errors_match_the_widget() {
        let parts = assemble_report(Some("   "), "0.1.0", "TEST", "linux x86_64", "");
        assert_eq!(parts.message, None);
        assert!(build_report_payload(&parts)["message"].is_null());
        let (code, message) = classify_submit_error("Σφάλμα δικτύου: connection reset");
        assert_eq!(code, "offline");
        assert_eq!(message, OFFLINE_MESSAGE);
    }

    #[test]
    fn report_url_replaces_the_function_name() {
        let url = problem_report_url(
            "https://abc.supabase.co/functions/v1/get-ai-recommendation",
        )
        .unwrap();
        assert_eq!(
            url,
            "https://abc.supabase.co/functions/v1/submit-problem-report"
        );
    }

    #[test]
    fn local_report_file_is_not_the_session_secret() {
        let path = local_report_path(Path::new("/tmp/pharmaBuddy"), "A2B3");
        assert!(path.ends_with("problem-reports/A2B3.json"));
        assert!(!path.ends_with("session.secret"));
    }
}
