use crate::auth_session;
use crate::env_config::{self, AppProfile};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;
use zip::ZipArchive;

pub const UPDATE_NOTE: &str = "↻ Νέα έκδοση στο επόμενο άνοιγμα";
pub const CHECK_INTERVAL: Duration = Duration::from_secs(3 * 60 * 60);
pub const MIN_INSTALLER_BYTES: usize = 1024;

/// NSIS flags for a passive install that runs only when we launch it.
/// `/P` progress bar, `/R` start the app again after install, `/UPDATE` skips the first-run wizard.
#[cfg_attr(not(windows), allow(dead_code))]
pub const NSIS_UPDATE_ARGS: &[&str] = &["/P", "/R", "/UPDATE"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchAction {
    StartNormally,
    InstallPending { version: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckAction {
    Skip,
    AlreadyPending,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PendingMeta {
    version: String,
}

pub fn updates_enabled_setting(require_login_raw: Option<&str>) -> bool {
    // The data profile (TEST/PROD) does not pick the update channel.
    // A backup build compiled with PHARMABUDDY_REQUIRE_LOGIN=false must not
    // replace itself with the login-required GitHub release.
    auth_session::login_required_setting(AppProfile::Prod, require_login_raw)
}

pub fn updates_enabled() -> bool {
    updates_enabled_setting(env_config::get_env("PHARMABUDDY_REQUIRE_LOGIN").as_deref())
}

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn launch_action(
    updates_enabled: bool,
    current_version: &str,
    pending_version: Option<&str>,
) -> LaunchAction {
    match pending_version.map(str::trim).filter(|version| !version.is_empty()) {
        Some(version) if updates_enabled && version != current_version => {
            LaunchAction::InstallPending {
                version: version.to_string(),
            }
        }
        _ => LaunchAction::StartNormally,
    }
}

pub fn check_action(
    updates_enabled: bool,
    current_version: &str,
    pending_version: Option<&str>,
    remote_version: Option<&str>,
) -> CheckAction {
    if !updates_enabled {
        return CheckAction::Skip;
    }
    let Some(remote) = remote_version.map(str::trim).filter(|version| !version.is_empty()) else {
        return CheckAction::Skip;
    };
    if remote == current_version {
        return CheckAction::Skip;
    }
    if pending_version.map(str::trim) == Some(remote) {
        return CheckAction::AlreadyPending;
    }
    CheckAction::Download
}

pub fn pending_paths(app_data: &Path) -> (PathBuf, PathBuf) {
    let dir = app_data.join("updates");
    (dir.join("pending-update.json"), dir.join("pending-update.bin"))
}

pub fn save_pending(app_data: &Path, version: &str, bytes: &[u8]) -> Result<(), String> {
    let (meta_path, bin_path) = pending_paths(app_data);
    if let Some(parent) = meta_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let meta = PendingMeta {
        version: version.trim().to_string(),
    };
    fs::write(
        &meta_path,
        serde_json::to_string(&meta).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    fs::write(&bin_path, bytes).map_err(|err| err.to_string())
}

pub fn load_pending(app_data: &Path) -> Option<(String, Vec<u8>)> {
    let (meta_path, bin_path) = pending_paths(app_data);
    let meta: PendingMeta = serde_json::from_str(&fs::read_to_string(meta_path).ok()?).ok()?;
    let bytes = fs::read(bin_path).ok()?;
    if meta.version.trim().is_empty() || bytes.is_empty() {
        return None;
    }
    Some((meta.version, bytes))
}

pub fn clear_pending(app_data: &Path) {
    let (meta_path, bin_path) = pending_paths(app_data);
    let _ = fs::remove_file(meta_path);
    let _ = fs::remove_file(bin_path);
}

pub fn pending_is_installable(
    version: &str,
    bytes: &[u8],
    current_version: &str,
    updates_enabled: bool,
) -> bool {
    matches!(
        launch_action(updates_enabled, current_version, Some(version)),
        LaunchAction::InstallPending { .. }
    ) && bytes.len() >= MIN_INSTALLER_BYTES
        && (bytes.starts_with(b"MZ") || bytes.starts_with(b"PK"))
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn write_installer(bytes: &[u8], dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    if bytes.starts_with(b"PK") {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|err| err.to_string())?;
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
            let name = file.name().to_string();
            if !name.to_ascii_lowercase().ends_with(".exe") || name.contains("..") {
                continue;
            }
            let path = dir.join("pharmaBuddy-update.exe");
            let mut out = fs::File::create(&path).map_err(|err| err.to_string())?;
            std::io::copy(&mut file, &mut out).map_err(|err| err.to_string())?;
            out.flush().map_err(|err| err.to_string())?;
            return Ok(path);
        }
        return Err("update archive has no installer".into());
    }
    if bytes.starts_with(b"MZ") {
        let path = dir.join("pharmaBuddy-update.exe");
        fs::write(&path, bytes).map_err(|err| err.to_string())?;
        return Ok(path);
    }
    Err("update package is not an installer".into())
}

/// Install a package downloaded on a previous launch, then leave this process.
/// Returns false when the app should continue starting. Never called mid-session.
pub fn install_pending_on_launch() -> bool {
    if !updates_enabled() {
        return false;
    }
    let app_data = auth_session::app_data_dir();
    let Some((version, bytes)) = load_pending(&app_data) else {
        return false;
    };
    if version == current_version() {
        clear_pending(&app_data);
        return false;
    }
    if !pending_is_installable(&version, &bytes, current_version(), true) {
        env_config::app_log(&format!(
            "[Update] Ignoring pending package version={version} bytes={}",
            bytes.len()
        ));
        return false;
    }
    #[cfg(not(windows))]
    {
        let _ = (version, bytes);
        false
    }
    #[cfg(windows)]
    {
        let temp = std::env::temp_dir().join("pharmaBuddy-update");
        let path = match write_installer(&bytes, &temp) {
            Ok(path) => path,
            Err(err) => {
                env_config::app_log(&format!("[Update] Could not prepare installer: {err}"));
                return false;
            }
        };
        // Drop the marker before the installer relaunches us, so we do not loop.
        clear_pending(&app_data);
        env_config::app_log(&format!("[Update] Installing {version} on launch"));
        match std::process::Command::new(&path).args(NSIS_UPDATE_ARGS).spawn() {
            Ok(_) => std::process::exit(0),
            Err(err) => {
                env_config::app_log(&format!("[Update] Installer failed to start: {err}"));
                false
            }
        }
    }
}

pub fn notice_for_pending(app_data: &Path, current_version: &str, updates_enabled: bool) -> Option<String> {
    let (version, bytes) = load_pending(app_data)?;
    if pending_is_installable(&version, &bytes, current_version, updates_enabled) {
        Some(UPDATE_NOTE.to_string())
    } else {
        None
    }
}

pub async fn watch(app: AppHandle) {
    loop {
        check_and_stage(&app).await;
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

pub async fn check_and_stage(app: &AppHandle) {
    if !updates_enabled() {
        return;
    }
    let app_data = auth_session::app_data_dir();
    let pending_version = load_pending(&app_data).map(|(version, _)| version);
    if notice_for_pending(&app_data, current_version(), true).is_some() {
        let _ = app.emit("update-ready", serde_json::json!({ "message": UPDATE_NOTE }));
    }

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(err) => {
            env_config::app_log(&format!("[Update] Updater unavailable: {err}"));
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(err) => {
            env_config::app_log(&format!("[Update] Check failed: {err}"));
            return;
        }
    };
    let remote = update.version.to_string();
    match check_action(true, current_version(), pending_version.as_deref(), Some(&remote)) {
        CheckAction::Skip => {}
        CheckAction::AlreadyPending => {
            let _ = app.emit("update-ready", serde_json::json!({ "message": UPDATE_NOTE }));
        }
        CheckAction::Download => match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => {
                if !pending_is_installable(&remote, &bytes, current_version(), true) {
                    env_config::app_log(&format!(
                        "[Update] Download for {remote} was not an installer ({} bytes)",
                        bytes.len()
                    ));
                    return;
                }
                if let Err(err) = save_pending(&app_data, &remote, &bytes) {
                    env_config::app_log(&format!("[Update] Could not store {remote}: {err}"));
                    return;
                }
                env_config::app_log(&format!(
                    "[Update] Downloaded {remote}; it will install on the next launch"
                ));
                let _ = app.emit("update-ready", serde_json::json!({ "message": UPDATE_NOTE }));
            }
            Err(err) => {
                env_config::app_log(&format!("[Update] Download failed: {err}"));
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_build_does_not_take_updates() {
        assert!(updates_enabled_setting(None));
        assert!(updates_enabled_setting(Some("true")));
        assert!(!updates_enabled_setting(Some("false")));
        assert!(!updates_enabled_setting(Some("0")));
        assert!(!updates_enabled_setting(Some("off")));
    }

    #[test]
    fn update_state_downloads_quietly_and_installs_only_on_a_later_launch() {
        assert_eq!(
            check_action(true, "0.1.0", None, Some("0.2.0")),
            CheckAction::Download
        );
        assert_eq!(
            check_action(true, "0.1.0", Some("0.2.0"), Some("0.2.0")),
            CheckAction::AlreadyPending
        );
        assert_eq!(
            check_action(true, "0.2.0", Some("0.2.0"), Some("0.2.0")),
            CheckAction::Skip
        );
        assert_eq!(check_action(false, "0.1.0", None, Some("0.2.0")), CheckAction::Skip);
        assert_eq!(check_action(true, "0.1.0", None, None), CheckAction::Skip);

        assert_eq!(
            launch_action(true, "0.1.0", Some("0.2.0")),
            LaunchAction::InstallPending {
                version: "0.2.0".into()
            }
        );
        assert_eq!(launch_action(true, "0.2.0", Some("0.2.0")), LaunchAction::StartNormally);
        assert_eq!(launch_action(false, "0.1.0", Some("0.2.0")), LaunchAction::StartNormally);
        assert_eq!(launch_action(true, "0.1.0", None), LaunchAction::StartNormally);
    }

    #[test]
    fn note_is_the_greek_line_and_pending_files_are_not_the_session() {
        assert_eq!(UPDATE_NOTE, "↻ Νέα έκδοση στο επόμενο άνοιγμα");
        assert!(CHECK_INTERVAL >= Duration::from_secs(30 * 60));
        let (meta, bin) = pending_paths(Path::new("C:/Users/pharm/AppData/Local/pharmaBuddy"));
        assert!(meta.ends_with("updates/pending-update.json"));
        assert!(bin.ends_with("updates/pending-update.bin"));
        assert_ne!(bin, PathBuf::from("C:/Users/pharm/AppData/Local/pharmaBuddy/session.secret"));
        assert_eq!(NSIS_UPDATE_ARGS, &["/P", "/R", "/UPDATE"]);
    }

    #[test]
    fn pending_package_roundtrip_and_installer_extract() {
        let dir = std::env::temp_dir().join(format!(
            "pharmabuddy-update-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let mut bytes = vec![b'M', b'Z'];
        bytes.extend(std::iter::repeat(b'U').take(MIN_INSTALLER_BYTES));
        save_pending(&dir, "0.2.0", &bytes).unwrap();
        let (version, loaded) = load_pending(&dir).unwrap();
        assert_eq!(version, "0.2.0");
        assert!(pending_is_installable(&version, &loaded, "0.1.0", true));
        assert!(!pending_is_installable(&version, &loaded, "0.2.0", true));
        assert!(!pending_is_installable(&version, &loaded, "0.1.0", false));
        assert_eq!(
            notice_for_pending(&dir, "0.1.0", true).as_deref(),
            Some(UPDATE_NOTE)
        );
        assert!(notice_for_pending(&dir, "0.1.0", false).is_none());

        let exe = write_installer(&loaded, &dir.join("out")).unwrap();
        assert!(exe.ends_with("pharmaBuddy-update.exe"));
        assert!(fs::read(&exe).unwrap().starts_with(b"MZ"));

        let zip_path = dir.join("update.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("pharmaBuddy-setup.exe", options).unwrap();
            zip.write_all(b"MZZIPINSTALLER").unwrap();
            zip.finish().unwrap();
        }
        let extracted = write_installer(&fs::read(&zip_path).unwrap(), &dir.join("zip-out")).unwrap();
        assert_eq!(fs::read(&extracted).unwrap(), b"MZZIPINSTALLER");

        clear_pending(&dir);
        assert!(load_pending(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cargo_version_matches_tauri_conf() {
        let conf = include_str!("../tauri.conf.json");
        let version = current_version();
        assert!(conf.contains(&format!("\"version\": \"{version}\"")));
    }
}
