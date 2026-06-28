use crate::env_config;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

struct HookState {
    buffer: String,
    last_keystroke: Option<Instant>,
    threshold_ms: u64,
}

static HOOK_STATE: OnceLock<Mutex<HookState>> = OnceLock::new();

fn hook_state() -> &'static Mutex<HookState> {
    let threshold_ms = env_config::get_env("PHARMABUDDY_SCANNER_THRESHOLD_MS")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(400);

    HOOK_STATE.get_or_init(|| {
        Mutex::new(HookState {
            buffer: String::new(),
            last_keystroke: None,
            threshold_ms,
        })
    })
}

#[cfg(windows)]
mod win_hook {
    use super::*;
    use std::ffi::c_int;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    static HOOK_HANDLE: AtomicIsize = AtomicIsize::new(0);
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    const VK_RETURN: i32 = 0x0D;
    const VK_TAB: i32 = 0x09;
    const VK_0: i32 = 0x30;
    const VK_9: i32 = 0x39;
    const VK_A: i32 = 0x41;
    const VK_Z: i32 = 0x5A;
    const VK_NUMPAD0: i32 = 0x60;
    const VK_NUMPAD9: i32 = 0x69;

    unsafe extern "system" fn hook_proc(n_code: c_int, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
        if n_code >= 0 {
            let msg = w_param.0 as u32;
            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                let info = *(l_param.0 as *const KBDLLHOOKSTRUCT);
                handle_key_down(info.vkCode as i32);
            }
        }

        let handle = HOOK_HANDLE.load(Ordering::SeqCst);
        if handle == 0 {
            return LRESULT(0);
        }
        CallNextHookEx(Some(HHOOK(handle as *mut _)), n_code, w_param, l_param)
    }

    fn translate_char(vk: i32) -> Option<char> {
        if (VK_0..=VK_9).contains(&vk) {
            return Some((b'0' + (vk - VK_0) as u8) as char);
        }
        if (VK_NUMPAD0..=VK_NUMPAD9).contains(&vk) {
            return Some((b'0' + (vk - VK_NUMPAD0) as u8) as char);
        }
        if (VK_A..=VK_Z).contains(&vk) {
            return Some((b'A' + (vk - VK_A) as u8) as char);
        }
        None
    }

    fn emit_scan_attempt(raw: &str, accepted: bool, reason: &str) {
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
                "scan-attempt",
                serde_json::json!({
                    "raw": raw,
                    "accepted": accepted,
                    "reason": reason,
                }),
            );
        }
    }

    fn emit_hook_buffer(buffer: &str, event: &str) {
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
                "hook-buffer",
                serde_json::json!({
                    "buffer": buffer,
                    "length": buffer.len(),
                    "event": event,
                }),
            );
        }
    }

    fn handle_key_down(vk_code: i32) {
        let mut barcode: Option<String> = None;
        let mut rejected: Option<(String, String)> = None;
        let mut hook_events: Vec<(&str, String)> = Vec::new();

        {
            let mut state = hook_state().lock().unwrap();
            let now = Instant::now();
            if let Some(last) = state.last_keystroke {
                if now.duration_since(last).as_millis() as u64 > state.threshold_ms {
                    if !state.buffer.is_empty() {
                        hook_events.push(("timeout_clear", state.buffer.clone()));
                    }
                    state.buffer.clear();
                }
            }
            state.last_keystroke = Some(now);

            if vk_code == VK_RETURN || vk_code == VK_TAB {
                let raw = state.buffer.clone();
                if !raw.is_empty() {
                    hook_events.push(("flush", raw.clone()));
                }
                if raw.len() > 3 {
                    barcode = Some(raw);
                } else if !raw.is_empty() {
                    let len = raw.len();
                    rejected = Some((
                        raw,
                        format!("Πολύ σύντομο scan ({len} χαρακτήρες)"),
                    ));
                }
                state.buffer.clear();
                hook_events.push(("clear", String::new()));
            } else if let Some(ch) = translate_char(vk_code) {
                state.buffer.push(ch);
                hook_events.push(("append", state.buffer.clone()));
            }
        }

        for (event, buffer) in hook_events {
            emit_hook_buffer(&buffer, event);
        }

        if let Some(code) = barcode {
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("barcode-scanned", code);
            }
        } else if let Some((raw, reason)) = rejected {
            emit_scan_attempt(&raw, false, &reason);
        }
    }

    pub fn start(app: AppHandle) -> Result<(), String> {
        if INSTALLED.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let _ = APP_HANDLE.set(app);

        unsafe {
            let module = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandleW: {e}"))?;
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(hook_proc),
                Some(HINSTANCE(module.0)),
                0,
            )
            .map_err(|e| format!("SetWindowsHookExW failed: {e}"))?;

            HOOK_HANDLE.store(hook.0 as isize, Ordering::SeqCst);
        }

        let threshold_ms = hook_state().lock().unwrap().threshold_ms;
        env_config::app_log(&format!(
            "[Hook] Global keyboard hook installed (threshold={}ms)",
            threshold_ms
        ));
        Ok(())
    }

    pub fn stop() {
        unsafe {
            let handle = HOOK_HANDLE.swap(0, Ordering::SeqCst);
            if handle != 0 {
                let _ = UnhookWindowsHookEx(HHOOK(handle as *mut _));
            }
        }
        INSTALLED.store(false, Ordering::SeqCst);
        env_config::app_log("[Hook] Global keyboard hook removed");
    }
}

#[cfg(windows)]
pub use win_hook::{start, stop};

#[cfg(not(windows))]
pub fn start(app: AppHandle) -> Result<(), String> {
    let _ = APP_HANDLE.set(app);
    env_config::app_log("[Hook] Global hook not available on this OS — use scan fallback input");
    Ok(())
}

#[cfg(not(windows))]
pub fn stop() {}
