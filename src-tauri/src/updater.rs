use std::sync::Mutex;
#[cfg(not(feature = "store"))]
use std::sync::atomic::{AtomicBool, Ordering};
use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow};
#[cfg(not(feature = "store"))]
use tauri::AppHandle;
#[cfg(not(feature = "store"))]
use tauri_plugin_updater::UpdaterExt;

pub struct UpdateState {
    status: Mutex<Value>,
    #[cfg(not(feature = "store"))]
    busy: AtomicBool,
}

impl UpdateState {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(json!({"status":"idle"})),
            #[cfg(not(feature = "store"))]
            busy: AtomicBool::new(false),
        }
    }
}

#[cfg(not(feature = "store"))]
fn update_check_error(error: &tauri_plugin_updater::Error) -> String {
    if matches!(error, tauri_plugin_updater::Error::ReleaseNotFound) {
        return format!("{error}. The update server did not return a successful response; its signed-update manifest may be unavailable.");
    }

    // reqwest's Display omits the underlying DNS, TLS, or connection error.
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let detail = cause.to_string();
        if !message.contains(&detail) {
            message.push_str(": ");
            message.push_str(&detail);
        }
        source = cause.source();
    }
    message
}

#[cfg(not(feature = "store"))]
fn publish(app: &AppHandle, value: Value) -> Value {
    *app.state::<UpdateState>().status.lock().unwrap() = value.clone();
    if let Some(window) = app.get_webview_window("main") {
        let script = format!("window.dispatchEvent(new CustomEvent('chalz-update-status', {{detail:{value}}}))");
        let _ = window.eval(&script);
    }
    value
}

#[cfg(not(feature = "store"))]
fn notify_available(app: &AppHandle, version: &str) {
    let Ok(dir) = crate::backend::data_dir() else { return; };
    let path = dir.join("update-notification.json");
    let prior = std::fs::read(&path).ok().and_then(|data| serde_json::from_slice::<Value>(&data).ok());
    if prior.as_ref().and_then(|v| v["version"].as_str()) == Some(version) { return; }
    if crate::desktop::show_notification(app, "ChalzTracker update available", &format!("Version {version} is available." )).is_ok() {
        if let Err(error) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(path, json!({"version":version}).to_string())) {
            eprintln!("Could not remember update notification: {error}");
        }
    }
}

#[cfg(not(feature = "store"))]
async fn check(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::AcqRel) { return; }
    publish(app, json!({"status":"checking"}));
    let result = match app.updater() {
        Ok(updater) => updater.check().await.map_err(|e| update_check_error(&e)),
        Err(e) => Err(e.to_string()),
    };
    match result {
        Ok(Some(update)) => {
            notify_available(app, &update.version);
            publish(app, json!({"status":"available","version":update.version}));
        }
        Ok(None) => { publish(app, json!({"status":"up-to-date"})); }
        Err(error) => { publish(app, json!({"status":"error","message":format!("Could not check for updates: {error}")})); }
    }
    state.busy.store(false, Ordering::Release);
}

#[cfg(not(feature = "store"))]
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            check(&app).await;
            tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

#[tauri::command]
pub fn get_update_status(window: WebviewWindow) -> Result<Value, String> {
    crate::desktop::authorize(&window)?;
    let state = window.state::<UpdateState>();
    let result = state.status.lock().unwrap().clone();
    Ok(result)
}

#[cfg(not(feature = "store"))]
#[tauri::command]
pub async fn install_update(window: WebviewWindow) -> Result<Value, String> {
    crate::desktop::authorize(&window)?;
    let app = window.app_handle().clone();
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::AcqRel) { return Ok(state.status.lock().unwrap().clone()); }
    let version = state.status.lock().unwrap().get("version").and_then(Value::as_str).map(str::to_owned);
    let result: Result<(), String> = async {
        let expected = version.as_ref().ok_or("No update is available yet.")?;
        let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| update_check_error(&e))?.ok_or("No update is available anymore.")?;
        if &update.version != expected { return Err("The available update changed; wait for the next check.".into()); }
        publish(&app, json!({"status":"downloading","version":expected,"percent":0}));
        let progress_app = app.clone();
        let progress_version = expected.clone();
        let finish_app = app.clone();
        let finish_version = expected.clone();
        let mut downloaded = 0u64;
        update.download_and_install(move |chunk, total| {
            downloaded += chunk as u64;
            let percent = total.filter(|n| *n > 0).map(|n| (downloaded as f64 * 100.0 / n as f64).min(100.0));
            publish(&progress_app, json!({"status":"downloading","version":progress_version,"percent":percent}));
        }, move || { publish(&finish_app, json!({"status":"installing","version":finish_version})); }).await.map_err(|e| e.to_string())?;
        Ok(())
    }.await;
    state.busy.store(false, Ordering::Release);
    match result {
        Ok(()) => app.restart(),
        Err(error) => Ok(publish(&app, json!({"status":"error","version":version,"message":format!("Could not install update: {error}")}))),
    }
}

#[cfg(feature = "store")]
#[tauri::command]
pub async fn install_update(window: WebviewWindow) -> Result<Value, String> {
    crate::desktop::authorize(&window)?;
    Err("Updates are managed by Microsoft Store.".into())
}

