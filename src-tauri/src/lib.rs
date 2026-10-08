mod auth_session;
mod barcode_fallback;
mod barcode_hook;
mod catalog_cache;
mod commercial_registry;
mod env_config;
mod eprescription;
mod galinos;
mod pharmacy_config;
mod recommendation;
mod side_effects;

use pharmacy_config::PharmacyStatus;
use recommendation::RecommendationDto;
use side_effects::SideEffectsDto;
use tauri::Manager;

#[tauri::command]
async fn get_recommendation(
    barcode: String,
    product_name: Option<String>,
    active_ingredient: Option<String>,
    atc_code: Option<String>,
    side_effects: Option<String>,
) -> RecommendationDto {
    recommendation::get_recommendation(
        &barcode,
        product_name.as_deref(),
        active_ingredient.as_deref(),
        atc_code.as_deref(),
        side_effects.as_deref(),
    )
    .await
}

#[tauri::command]
async fn fetch_side_effects(barcode: String, product_name: Option<String>) -> SideEffectsDto {
    side_effects::fetch_side_effects(&barcode, product_name.as_deref()).await
}

#[tauri::command]
async fn lookup_barcode(barcode: String) -> recommendation::LookupResult {
    recommendation::lookup_barcode(&barcode).await
}

#[tauri::command]
fn get_profile() -> String {
    env_config::current_profile().display_name().to_string()
}

#[tauri::command]
fn toggle_profile() -> String {
    env_config::toggle_profile().display_name().to_string()
}

#[tauri::command]
async fn get_pharmacy_status() -> PharmacyStatus {
    pharmacy_config::get_pharmacy_status().await
}

#[tauri::command]
async fn activate_pharmacy(license_key: String) -> Result<PharmacyStatus, String> {
    pharmacy_config::activate_pharmacy(license_key).await
}

#[tauri::command]
async fn get_auth_gate() -> auth_session::AuthGate {
    auth_session::current_gate().await
}

#[tauri::command]
async fn login(identifier: String, password: String) -> auth_session::AuthGate {
    auth_session::login(identifier, password).await
}

#[tauri::command]
async fn logout() -> auth_session::AuthGate {
    auth_session::logout().await
}

#[cfg(target_os = "windows")]
fn configure_windows_window(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            // Ensure the widget appears in the taskbar and Alt+Tab (not a tool window).
            let without_tool = ex_style & !(WS_EX_TOOLWINDOW.0 as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, without_tool);
        }
        env_config::app_log("[Window] Taskbar entry enabled (WS_EX_TOOLWINDOW cleared)");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_config::initialize();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                configure_windows_window(&window);

                if let Err(err) = barcode_hook::start(app.handle().clone()) {
                    env_config::app_log(&format!("[Hook] Failed to start: {err}"));
                }
            }
            tauri::async_runtime::spawn(async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                    auth_session::refresh_if_due().await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    barcode_hook::stop();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_recommendation,
            lookup_barcode,
            fetch_side_effects,
            get_profile,
            toggle_profile,
            get_pharmacy_status,
            activate_pharmacy,
            get_auth_gate,
            login,
            logout
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
