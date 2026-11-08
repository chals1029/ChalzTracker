#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod desktop;
mod sound;
mod updater;

use std::sync::{Arc, Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![desktop::window_action, desktop::notification_permission, desktop::notify, updater::get_update_status, updater::install_update])
        .setup(|app| {
            #[cfg(debug_assertions)]
            let resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
            #[cfg(not(debug_assertions))]
            let resources = app.path().resource_dir()?.join("frontend");
            std::env::set_var("CHALZ_APP_RESOURCES", resources);
            let notification_app = app.handle().clone();
            let notify = Arc::new(move |alert: serde_json::Value| {
                let Some(title) = alert.get("title").and_then(serde_json::Value::as_str) else {
                    eprintln!("Background alert has no title");
                    return;
                };
                let Some(body) = alert.get("body").and_then(serde_json::Value::as_str) else {
                    eprintln!("Background alert has no body");
                    return;
                };
                if alert.get("sound").and_then(serde_json::Value::as_bool) != Some(false) {
                    sound::play(alert.get("soundPack").and_then(serde_json::Value::as_str).unwrap_or("cyber"), alert.get("level").and_then(serde_json::Value::as_str).unwrap_or("reset"));
                }
                if let Err(error) = desktop::show_notification(&notification_app, title, body) {
                    eprintln!("Could not show background alert: {error}");
                }
            });
            let native_app = app.handle().clone();
            let native_route = Arc::new(move |route: &str, body: &serde_json::Value, response: &serde_json::Value| {
                desktop::native_route(&native_app, route, body, response)
            });
            let backend = backend::start(notify, native_route)?;
            let port = backend.port;
            app.manage(Mutex::new(backend));
            app.manage(desktop::DesktopState::new(port));
            app.manage(updater::UpdateState::new());
            let origin = format!("http://127.0.0.1:{port}");
            let url = format!("{origin}/").parse()?;
            let expected = origin.clone();
            let nav_app = app.handle().clone();
            let popup_app = app.handle().clone();
            let permission = match app.notification().permission_state()? {
                tauri_plugin_notification::PermissionState::Granted => "granted",
                tauri_plugin_notification::PermissionState::Denied => "denied",
                _ => "default",
            };
            let bridge = format!("if (window.location.origin === {}) {{ window.__CHALZ_NOTIFICATION_PERMISSION__ = {}; {} }}", serde_json::to_string(&origin)?, serde_json::to_string(permission)?, include_str!("bridge.js"));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("ChalzTracker")
                .inner_size(940.0, 640.0)
                .center()
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .initialization_script(bridge)
                .on_navigation(move |url| {
                    if url.origin().ascii_serialization() == expected { return true; }
                    if url.scheme() == "https" { let _ = nav_app.opener().open_url(url.as_str(), None::<&str>); }
                    false
                })
                .on_new_window(move |url, _| {
                    if url.scheme() == "https" { let _ = popup_app.opener().open_url(url.as_str(), None::<&str>); }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            desktop::create_tray(app.handle())?;
            updater::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<desktop::DesktopState>().tray_active.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not start ChalzTracker desktop");
}
