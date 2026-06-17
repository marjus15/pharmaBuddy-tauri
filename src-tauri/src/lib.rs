mod barcode_fallback;
mod barcode_hook;
mod catalog_cache;
mod commercial_registry;
mod env_config;
mod eprescription;
mod galinos;
mod recommendation;

use recommendation::RecommendationDto;
use tauri::Manager;

#[tauri::command]
async fn get_recommendation(barcode: String, product_name: Option<String>) -> RecommendationDto {
    recommendation::get_recommendation(&barcode, product_name.as_deref()).await
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
            get_profile,
            toggle_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
