use serde::Deserialize;
use serde_json::Value;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_notification::NotificationExt;

pub struct DesktopState {
    pub port: u16,
    mode: Mutex<String>,
    topmost: Mutex<bool>,
    pub tray_active: AtomicBool,
}

impl DesktopState {
    pub fn new(port: u16) -> Self {
        Self { port, mode: Mutex::new("dashboard".into()), topmost: Mutex::new(false), tray_active: AtomicBool::new(true) }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dimensions {
    w: Option<u32>,
    expanded: Option<bool>,
    detail_open: Option<bool>,
}

#[derive(Deserialize)]
pub struct GlassRegion {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) radius: f64,
}

#[tauri::command]
pub async fn set_glass_regions(window: WebviewWindow, regions: Option<Vec<GlassRegion>>) -> Result<&'static str, String> {
    authorize(&window)?;
    if let Some(regions) = &regions {
        if regions.is_empty() || regions.len() > 64 || regions.iter().any(|r|
            ![r.x, r.y, r.width, r.height, r.radius].iter().all(|v| v.is_finite() && v.abs() <= 10000.0)
            || r.width <= 0.0 || r.height <= 0.0 || r.radius < 0.0) {
            return Err("Invalid glass region".into());
        }
    }
    #[cfg(target_os = "windows")]
    {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        window.run_on_main_thread(move || {
            #[link(name = "gdi32")]
            extern "system" {
                fn CreateRoundRectRgn(left: i32, top: i32, right: i32, bottom: i32, width: i32, height: i32) -> isize;
                fn CombineRgn(dest: isize, src1: isize, src2: isize, mode: i32) -> i32;
                fn DeleteObject(object: isize) -> i32;
            }
            #[link(name = "user32")]
            extern "system" { fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32; }
            let result = (|| -> Result<&'static str, String> {
                let mut combined = 0;
                if let Some(regions) = &regions {
                    for rect in regions {
                        let left = (rect.x * scale).floor().clamp(0.0, size.width as f64) as i32;
                        let top = (rect.y * scale).floor().clamp(0.0, size.height as f64) as i32;
                        let right = ((rect.x + rect.width) * scale).ceil().clamp(0.0, size.width as f64) as i32;
                        let bottom = ((rect.y + rect.height) * scale).ceil().clamp(0.0, size.height as f64) as i32;
                        if right <= left || bottom <= top { continue; }
                        let diameter = (rect.radius * 2.0 * scale).round().max(1.0) as i32;
                        let part = unsafe { CreateRoundRectRgn(left, top, right + 1, bottom + 1, diameter, diameter) };
                        if part == 0 { if combined != 0 { unsafe { DeleteObject(combined); } } return Err("Could not create glass region".into()); }
                        if combined == 0 { combined = part; } else {
                            let merged = unsafe { CombineRgn(combined, combined, part, 2) };
                            unsafe { DeleteObject(part); }
                            if merged == 0 { unsafe { DeleteObject(combined); } return Err("Could not combine glass regions".into()); }
                        }
                    }
                    if combined == 0 { return Err("Glass regions are outside the window".into()); }
                }
                if unsafe { SetWindowRgn(hwnd, combined, 1) } == 0 {
                    if combined != 0 { unsafe { DeleteObject(combined); } }
                    return Err("Could not apply glass region".into());
                }
                Ok(if let Some(regions) = &regions {
                    crate::backdrop::update(hwnd, regions, scale, size.width, size.height)
                } else {
                    crate::backdrop::destroy();
                    "unavailable"
                })
            })();
            if result.is_err() { crate::backdrop::destroy(); }
            let _ = sender.send(result);
        }).map_err(|e| e.to_string())?;
        receiver.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = regions; Ok("unavailable") }
}

pub(crate) fn authorize(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let state = window.state::<DesktopState>();
    if window.label() != "main" || url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port() != Some(state.port) {
        return Err("Unauthorized desktop request".into());
    }
    Ok(())
}

// Tauri queues z-order changes and does not report Win32 SetWindowPos failures.
// Apply the final z-order on the window thread after the queued style/size changes.
#[cfg(target_os = "windows")]
fn set_topmost(window: &WebviewWindow, topmost: bool) -> Result<(), String> {
    window.set_always_on_top(topmost).map_err(|e| e.to_string())?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window.run_on_main_thread(move || {
        #[link(name = "user32")]
        extern "system" {
            fn SetWindowPos(hwnd: isize, insert_after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        }
        const SWP_NOSIZE: u32 = 0x0001;
        const SWP_NOMOVE: u32 = 0x0002;
        const SWP_NOACTIVATE: u32 = 0x0010;
        let after = if topmost { -1 } else { -2 }; // HWND_TOPMOST / HWND_NOTOPMOST
        let result = unsafe { SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE) };
        let _ = sender.send(if result != 0 { Ok(()) } else { Err(std::io::Error::last_os_error().to_string()) });
    }).map_err(|e| e.to_string())?;
    receiver.recv().map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "windows"))]
fn set_topmost(window: &WebviewWindow, topmost: bool) -> Result<(), String> {
    window.set_always_on_top(topmost).map_err(|e| e.to_string())
}

fn apply_mode(window: &WebviewWindow, mode: &str, dims: Dimensions, sync: bool) -> Result<(), String> {
    if !matches!(mode, "dashboard" | "widget" | "pill") { return Err("Invalid window mode".into()); }
    let state = window.state::<DesktopState>();
    let mut previous = state.mode.lock().map_err(|e| e.to_string())?;
    let topmost = *state.topmost.lock().map_err(|e| e.to_string())?;
    let monitor = if mode == "pill" && *previous == "pill" { window.current_monitor() } else { window.primary_monitor() }
        .map_err(|e| e.to_string())?.ok_or("No display available")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let (width, height) = match mode {
        "pill" if dims.expanded.unwrap_or(false) => (if dims.detail_open.unwrap_or(true) { 650.0 } else { 365.0 }, 535.0),
        "pill" => (360.0, 56.0),
        "widget" => (if dims.w.unwrap_or(365) > 400 { 650.0 } else { 365.0 }, 475.0),
        _ => ((940.0_f64).min((area.size.width as f64 / scale - 32.0).max(1.0)), (640.0_f64).min((area.size.height as f64 / scale - 40.0).max(1.0))),
    };
    let size = PhysicalSize::new((width * scale).round() as u32, (height * scale).round() as u32);
    let right = area.position.x + area.size.width as i32 - size.width as i32;
    let bottom = area.position.y + area.size.height as i32 - size.height as i32;
    let (x, y) = if mode == "dashboard" {
        (area.position.x + (area.size.width as i32 - size.width as i32) / 2, area.position.y + (area.size.height as i32 - size.height as i32) / 2)
    } else if mode == "pill" && *previous == "pill" {
        let old_pos = window.outer_position().map_err(|e| e.to_string())?;
        let old_size = window.outer_size().map_err(|e| e.to_string())?;
        ((old_pos.x + (old_size.width as i32 - size.width as i32) / 2).clamp(area.position.x.min(right), right.max(area.position.x)),
         (old_pos.y + old_size.height as i32 - size.height as i32).clamp(area.position.y.min(bottom), bottom.max(area.position.y)))
    } else { (right - (16.0 * scale) as i32, bottom - (16.0 * scale) as i32) };
    if window.is_maximized().map_err(|e| e.to_string())? { window.unmaximize().map_err(|e| e.to_string())?; }
    window.set_resizable(mode == "dashboard").map_err(|e| e.to_string())?;
    let desired_topmost = mode == "pill" || (mode == "widget" && topmost);
    window.set_size(size).map_err(|e| e.to_string())?;
    window.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    set_topmost(window, desired_topmost)?;
    *previous = mode.into();
    if sync { window.eval(&format!("window.dispatchEvent(new CustomEvent('chalz-mode-sync',{{detail:'{}'}}))", mode)).map_err(|e| e.to_string())?; }
    Ok(())
}
#[tauri::command]
pub async fn window_action(window: WebviewWindow, action: &str) -> Result<(), String> {
    authorize(&window)?;
    match action {
        "minimize" => window.minimize(),
        "maximize" => if window.is_maximized().map_err(|e| e.to_string())? { window.unmaximize() } else { window.maximize() },
        "close" => window.close(),
        "drag" => window.start_dragging(),
        "topmost" => {
            let state = window.state::<DesktopState>();
            let mut top = state.topmost.lock().map_err(|e| e.to_string())?;
            let next = !*top;
            set_topmost(&window, next)?;
            *top = next;
            Ok(())
        },
        _ => return Err("Invalid window action".into()),
    }.map_err(|e| e.to_string())
}

pub fn native_route(app: &tauri::AppHandle, route: &str, body: &Value, result: &Value) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Desktop window unavailable")?;
    if route == "/api/window" {
        let action = body.get("action").and_then(Value::as_str).unwrap_or("mode");
        match action {
            "focus" => { window.unminimize().map_err(|e| e.to_string())?; window.show().map_err(|e| e.to_string())?; window.set_focus().map_err(|e| e.to_string())?; },
            "hide" => {
                let tray = window.app_handle().tray_by_id("main-tray").ok_or("Tray unavailable")?;
                let state = window.state::<DesktopState>();
                let previous = state.tray_active.load(Ordering::SeqCst);
                tray.set_visible(true).map_err(|e| e.to_string())?;
                if let Err(error) = window.hide() {
                    if let Err(rollback) = tray.set_visible(previous) { return Err(format!("{error}; tray rollback failed: {rollback}")); }
                    return Err(error.to_string());
                }
                state.tray_active.store(true, Ordering::SeqCst);
            },
            "topmost" | "mode" => {
                let top = result.get("topmost").and_then(Value::as_bool).ok_or("Missing topmost state")?;
                let state = window.state::<DesktopState>();
                let previous_top = *state.topmost.lock().map_err(|e| e.to_string())?;
                let mode = body.get("mode").and_then(Value::as_str)
                    .or_else(|| if action == "mode" { Some("dashboard") } else { None });
                if let Some(mode) = mode {
                    let dims = match body.get("desktopDims") {
                        Some(value) => serde_json::from_value(value.clone()).map_err(|e| e.to_string())?,
                        None => Dimensions {
                            w: Some(if body.get("detailOpen").and_then(Value::as_bool).unwrap_or(true) { 650 } else { 365 }),
                            expanded: body.get("expanded").and_then(Value::as_bool),
                            detail_open: body.get("detailOpen").and_then(Value::as_bool),
                        },
                    };
                    *state.topmost.lock().map_err(|e| e.to_string())? = top;
                    if let Err(error) = apply_mode(&window, mode, dims, action == "topmost") {
                        *state.topmost.lock().map_err(|e| e.to_string())? = previous_top;
                        return Err(error);
                    }
                } else {
                    let mode = state.mode.lock().map_err(|e| e.to_string())?.clone();
                    set_topmost(&window, top || mode == "pill")?;
                    *state.topmost.lock().map_err(|e| e.to_string())? = top;
                }
            },
            _ => return Err("Invalid window route action".into()),
        }
    } else if route == "/api/tray" {
        let tray = window.app_handle().tray_by_id("main-tray").ok_or("Tray unavailable")?;
        let state = window.state::<DesktopState>();
        let previous = state.tray_active.load(Ordering::SeqCst);
        let active = result.get("active").and_then(Value::as_bool).unwrap_or(previous);
        tray.set_visible(active).map_err(|e| e.to_string())?;
        if result.get("hidden").and_then(Value::as_bool) == Some(true) {
            if let Err(error) = window.hide() {
                if let Err(rollback) = tray.set_visible(previous) { return Err(format!("{error}; tray rollback failed: {rollback}")); }
                return Err(error.to_string());
            }
        }
        state.tray_active.store(active, Ordering::SeqCst);
    } else { return Err("Invalid native route".into()); }
    Ok(())
}

#[tauri::command]
pub async fn notification_permission(window: WebviewWindow) -> Result<String, String> {
    authorize(&window)?;
    window.notification().request_permission().map(|state| match state {
        tauri_plugin_notification::PermissionState::Granted => "granted",
        tauri_plugin_notification::PermissionState::Denied => "denied",
        _ => "default",
    }.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notify(window: WebviewWindow, title: String, body: String) -> Result<(), String> {
    authorize(&window)?;
    show_notification(window.app_handle(), &title, &body)
}

#[cfg(target_os = "windows")]
pub fn show_notification(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    let app_id = app.config().identifier.clone();
    let title = title.to_owned();
    let body = body.to_owned();
    std::thread::spawn(move || -> Result<(), String> {
        use windows::core::HSTRING;
        use windows::Data::Xml::Dom::XmlDocument;
        use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
        use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|e| e.to_string())?;
        let result = (|| -> windows::core::Result<()> {
            let xml = XmlDocument::new()?;
            xml.LoadXml(&HSTRING::from("<toast><visual><binding template=\"ToastGeneric\"><text></text><text></text></binding></visual><audio silent=\"true\"/></toast>"))?;
            let texts = xml.GetElementsByTagName(&HSTRING::from("text"))?;
            texts.Item(0)?.SetInnerText(&HSTRING::from(title))?;
            texts.Item(1)?.SetInnerText(&HSTRING::from(body))?;
            let toast = ToastNotification::CreateToastNotification(&xml)?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)?;
            Ok(())
        })();
        unsafe { RoUninitialize() };
        result.map_err(|e| e.to_string())
    }).join().map_err(|_| "Notification thread failed".to_string())?
}

#[cfg(not(target_os = "windows"))]
pub fn show_notification(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

pub fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let dashboard = MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)?;
    let widget = MenuItem::with_id(app, "widget", "Compact Widget (W)", true, None::<&str>)?;
    let pill = MenuItem::with_id(app, "pill", "Mini Pill (M)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ChalzTracker", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&dashboard, &widget, &pill, &quit])?;
    let icon = app.default_window_icon().ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?.clone();
    TrayIconBuilder::with_id("main-tray").icon(icon).tooltip("ChalzTracker — Your Personal AI Usage Tracker")
        .menu(&menu).show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" { app.exit(0); return; }
            if let Some(window) = app.get_webview_window("main") {
                let mode = event.id().as_ref();
                if matches!(mode, "dashboard" | "widget" | "pill") {
                    let mode = mode.to_owned();
                    if let Err(error) = std::thread::Builder::new().name("tray-window-mode".into()).spawn(move || {
                        let dims = Dimensions { w: Some(650), ..Dimensions::default() };
                        if let Err(error) = apply_mode(&window, &mode, dims, true) {
                            eprintln!("Window mode: {error}");
                            return;
                        }
                        if let Err(error) = window.unminimize().and_then(|_| window.show()).and_then(|_| window.set_focus()) {
                            eprintln!("Could not show tray window: {error}");
                        }
                    }) {
                        eprintln!("Could not start tray window operation: {error}");
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) { let _ = window.hide(); } else { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); }
                }
            }
        }).build(app)?;
    Ok(())
}
