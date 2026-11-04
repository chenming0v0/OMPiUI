use crate::service::{self, TrayServiceStatus};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Window,
};

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TrayConfig {
    close_to_tray: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySettings {
    supported: bool,
    close_to_tray: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequested {
    pub close_to_tray: bool,
    pub exit_app: bool,
}

#[derive(Clone)]
struct TrayMenu {
    open: MenuItem<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    exit: MenuItem<tauri::Wry>,
}

#[derive(Default)]
struct Context {
    env_vars: BTreeMap<String, String>,
    language: String,
    last_hidden: Option<String>,
}

#[derive(Default)]
pub struct TrayState {
    supported: AtomicBool,
    close_to_tray: AtomicBool,
    busy: AtomicBool,
    owned_backend: AtomicBool,
    settings: Mutex<()>,
    context: Mutex<Context>,
    menu: Mutex<Option<TrayMenu>>,
    last_menu: Mutex<Option<(TrayServiceStatus, bool)>>,
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("tray-settings.json"))
}

fn read_config(path: &Path) -> Result<TrayConfig, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid tray settings: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TrayConfig::default()),
        Err(error) => Err(format!("Cannot read tray settings: {error}")),
    }
}

fn save_config(path: &Path, config: &TrayConfig) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid tray settings directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Cannot write tray settings: {error}"))?;
    #[cfg(windows)]
    let result = {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } != 0
        {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    };
    #[cfg(not(windows))]
    let result = fs::rename(&temporary, path);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot replace tray settings: {error}"));
    }
    Ok(())
}

impl TrayState {
    fn result(&self) -> TraySettings {
        let supported = self.supported.load(Ordering::SeqCst);
        TraySettings {
            supported,
            close_to_tray: supported && self.close_to_tray.load(Ordering::SeqCst),
        }
    }

    fn update_context(
        &self,
        env_vars: BTreeMap<String, String>,
        language: String,
    ) -> Result<(), String> {
        let mut context = self.context.lock().map_err(|error| error.to_string())?;
        context.env_vars = env_vars;
        context.language = language;
        Ok(())
    }
}

#[tauri::command]
pub fn get_ompiui_tray_settings(
    app: AppHandle,
    state: State<'_, TrayState>,
    env_vars: BTreeMap<String, String>,
    language: String,
) -> Result<TraySettings, String> {
    let _settings = state.settings.lock().map_err(|error| error.to_string())?;
    let config = read_config(&config_path(&app)?)?;
    state.update_context(env_vars, language)?;
    state
        .close_to_tray
        .store(config.close_to_tray, Ordering::SeqCst);
    refresh_async(&app);
    Ok(state.result())
}

#[tauri::command]
pub fn set_ompiui_tray_settings(
    app: AppHandle,
    state: State<'_, TrayState>,
    close_to_tray: bool,
    env_vars: BTreeMap<String, String>,
    language: String,
) -> Result<TraySettings, String> {
    let _settings = state.settings.lock().map_err(|error| error.to_string())?;
    if close_to_tray && !state.supported.load(Ordering::SeqCst) {
        return Err("System tray is unavailable".to_string());
    }
    // 锁定内存上下文后保存，落盘失败时不改变设置或凭据/语言上下文。
    let mut context = state.context.lock().map_err(|error| error.to_string())?;
    save_config(&config_path(&app)?, &TrayConfig { close_to_tray })?;
    context.env_vars = env_vars;
    context.language = language;
    state.close_to_tray.store(close_to_tray, Ordering::SeqCst);
    drop(context);
    if !close_to_tray {
        // 设置关闭时把此前隐藏的窗口恢复，不能留下无法发现的窗口。
        for window in app.webview_windows().values() {
            if !window.is_visible().unwrap_or(true) {
                let _ = window.show();
            }
        }
    }
    refresh_async(&app);
    Ok(state.result())
}

pub(crate) fn environment(app: &AppHandle) -> Result<BTreeMap<String, String>, String> {
    app.state::<TrayState>()
        .context
        .lock()
        .map(|context| context.env_vars.clone())
        .map_err(|error| error.to_string())
}

pub fn close_to_tray(app: &AppHandle) -> bool {
    app.state::<TrayState>().result().close_to_tray
}

pub fn has_owned_backend(app: &AppHandle) -> bool {
    let state = app.state::<TrayState>();
    state.busy.load(Ordering::SeqCst)
        || (state.owned_backend.load(Ordering::SeqCst) && service::tray_owned_process_alive(app))
}

pub fn is_last_visible_window(window: &Window) -> bool {
    let windows = window.app_handle().webview_windows();
    last_visible_label(
        window.label(),
        windows
            .values()
            .map(|other| (other.label(), other.is_visible().unwrap_or(true))),
    )
}

fn last_visible_label<'a>(label: &str, windows: impl Iterator<Item = (&'a str, bool)>) -> bool {
    !windows
        .into_iter()
        .any(|(other_label, visible)| other_label != label && visible)
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Destroy,
    Exit,
}

pub fn confirmed_close_action(
    close_to_tray: bool,
    stop_service: bool,
    exit_app: bool,
) -> CloseAction {
    if exit_app || (close_to_tray && stop_service) {
        CloseAction::Exit
    } else if close_to_tray {
        CloseAction::Hide
    } else {
        CloseAction::Destroy
    }
}

pub fn hide_window(window: &Window) -> Result<(), String> {
    if !close_to_tray(window.app_handle()) {
        return Err("System tray is unavailable".to_string());
    }
    window.hide().map_err(|error| error.to_string())?;
    if let Ok(mut context) = window.state::<TrayState>().context.lock() {
        context.last_hidden = Some(window.label().to_string());
    }
    Ok(())
}

fn restore_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let label = app
        .state::<TrayState>()
        .context
        .lock()
        .map_err(|error| error.to_string())?
        .last_hidden
        .clone();
    let window = label
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next());
    let window = match window {
        Some(window) => window,
        None => {
            let window = crate::create_main_window(app).map_err(|error| error.to_string())?;
            crate::finish_desktop_window_setup(&window);
            crate::restore_window_state(&window);
            window
        }
    };
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(window)
}

fn report_error(app: &AppHandle, error: String) {
    let _ = restore_window(app);
    let _ = app.emit("desktop-service-error", error);
}

fn request_exit(app: &AppHandle) {
    match restore_window(app) {
        Ok(window) => {
            if let Err(error) = window.emit(
                "close-requested",
                CloseRequested {
                    close_to_tray: false,
                    exit_app: true,
                },
            ) {
                report_error(app, error.to_string());
            }
        }
        Err(error) => report_error(app, error),
    }
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn lifecycle_action(app: &AppHandle, start: bool) {
    let state = app.state::<TrayState>();
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<TrayState>();
        let busy = BusyGuard(&state.busy);
        let _ = refresh(&app).await;
        let environment = state
            .context
            .lock()
            .map_err(|error| error.to_string())
            .map(|context| context.env_vars.clone());
        let result = async {
            let environment = environment?;
            if start {
                let result = service::tray_start_service(&app, environment).await?;
                app.emit("desktop-service-started", result)
                    .map_err(|error| error.to_string())
            } else {
                service::tray_stop_service(&app, &environment).await?;
                app.emit("desktop-service-stopped", ())
                    .map_err(|error| error.to_string())
            }
        }
        .await;
        drop(busy);
        if let Err(error) = result {
            report_error(&app, error);
        }
        let _ = refresh(&app).await;
    });
}

fn menu_text(status: TrayServiceStatus, chinese: bool) -> &'static str {
    match (status, chinese) {
        (TrayServiceStatus::Running, true) => "后端：运行中",
        (TrayServiceStatus::External, true) => "后端：外部服务（不可启停）",
        (TrayServiceStatus::Stopped, true) => "后端：已停止",
        (TrayServiceStatus::Busy, true) => "后端：处理中",
        (TrayServiceStatus::Unavailable, true) => "后端：状态不可用",
        (TrayServiceStatus::Running, false) => "Backend: running",
        (TrayServiceStatus::External, false) => "Backend: external (not managed)",
        (TrayServiceStatus::Stopped, false) => "Backend: stopped",
        (TrayServiceStatus::Busy, false) => "Backend: busy",
        (TrayServiceStatus::Unavailable, false) => "Backend: unavailable",
    }
}

async fn refresh(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<TrayState>();
    let (environment, chinese) = {
        let context = state.context.lock().map_err(|error| error.to_string())?;
        (context.env_vars.clone(), context.language.starts_with("zh"))
    };
    let mut status = if state.busy.load(Ordering::SeqCst) {
        TrayServiceStatus::Busy
    } else {
        service::tray_service_status(app, &environment)
            .await
            .unwrap_or(TrayServiceStatus::Unavailable)
    };
    // 健康探测等待期间可能刚开始新的原生启停，不能用旧探测结果重新启用菜单。
    if state.busy.load(Ordering::SeqCst) || service::tray_lifecycle_busy(app) {
        status = TrayServiceStatus::Busy;
    }
    // Busy 不覆盖已确认的所有权：此时关闭也应保留确认流程。
    if status != TrayServiceStatus::Busy {
        state
            .owned_backend
            .store(status == TrayServiceStatus::Running, Ordering::SeqCst);
    }
    let menu = state
        .menu
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let Some(menu) = menu else {
        return Ok(());
    };
    let mut last = state.last_menu.lock().map_err(|error| error.to_string())?;
    if *last == Some((status, chinese)) {
        return Ok(());
    }
    menu.open
        .set_text(if chinese {
            "打开窗口"
        } else {
            "Open window"
        })
        .map_err(|error| error.to_string())?;
    menu.status
        .set_text(menu_text(status, chinese))
        .map_err(|error| error.to_string())?;
    menu.start
        .set_text(if chinese {
            "启动后端"
        } else {
            "Start backend"
        })
        .map_err(|error| error.to_string())?;
    menu.stop
        .set_text(if chinese {
            "停止后端"
        } else {
            "Stop backend"
        })
        .map_err(|error| error.to_string())?;
    menu.exit
        .set_text(if chinese { "退出" } else { "Exit" })
        .map_err(|error| error.to_string())?;
    menu.start
        .set_enabled(status == TrayServiceStatus::Stopped)
        .map_err(|error| error.to_string())?;
    menu.stop
        .set_enabled(status == TrayServiceStatus::Running)
        .map_err(|error| error.to_string())?;
    *last = Some((status, chinese));
    Ok(())
}

pub(crate) fn refresh_async(app: &AppHandle) {
    if !app.state::<TrayState>().supported.load(Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = refresh(&app).await;
    });
}

pub fn init(app: &AppHandle) {
    let state = app.state::<TrayState>();
    match config_path(app).and_then(|path| read_config(&path)) {
        Ok(config) => state
            .close_to_tray
            .store(config.close_to_tray, Ordering::SeqCst),
        Err(error) => {
            log::warn!("Tray settings could not be read; close-to-tray remains disabled: {error}")
        }
    }
    if let Ok(environment) = service::tray_environment() {
        let _ = state.update_context(environment, "en".to_string());
    }
    let result = (|| -> tauri::Result<TrayMenu> {
        let open = MenuItem::with_id(app, "ompiui-tray-open", "Open window", true, None::<&str>)?;
        let status = MenuItem::with_id(
            app,
            "ompiui-tray-status",
            "Backend: busy",
            false,
            None::<&str>,
        )?;
        let start = MenuItem::with_id(
            app,
            "ompiui-tray-start",
            "Start backend",
            false,
            None::<&str>,
        )?;
        let stop = MenuItem::with_id(app, "ompiui-tray-stop", "Stop backend", false, None::<&str>)?;
        let exit = MenuItem::with_id(app, "ompiui-tray-exit", "Exit", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&open, &status, &start, &stop, &separator, &exit])?;
        let icon = app
            .default_window_icon()
            .cloned()
            .ok_or_else(|| tauri::Error::AssetNotFound("application tray icon".to_string()))?;
        TrayIconBuilder::with_id("ompiui-tray")
            .icon(icon)
            .tooltip("OMPiUI")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    if let Err(error) = restore_window(tray.app_handle()) {
                        report_error(tray.app_handle(), error);
                    }
                }
            })
            .on_menu_event(|app, event| match event.id().as_ref() {
                "ompiui-tray-open" => {
                    if let Err(error) = restore_window(app) {
                        report_error(app, error);
                    }
                }
                "ompiui-tray-start" => lifecycle_action(app, true),
                "ompiui-tray-stop" => lifecycle_action(app, false),
                "ompiui-tray-exit" => request_exit(app),
                _ => {}
            })
            .build(app)?;
        Ok(TrayMenu {
            open,
            status,
            start,
            stop,
            exit,
        })
    })();
    match result {
        Ok(menu) => {
            *state.menu.lock().unwrap() = Some(menu);
            state.supported.store(true, Ordering::SeqCst);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = refresh(&app).await;
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            });
        }
        Err(error) => {
            log::warn!("System tray is unavailable; close-to-tray remains disabled: {error}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_defaults_off_and_persists_only_close_setting() {
        let config: TrayConfig = serde_json::from_str("{}").unwrap();
        assert!(!config.close_to_tray);
        assert_eq!(
            serde_json::to_value(TrayConfig {
                close_to_tray: true
            })
            .unwrap(),
            serde_json::json!({ "closeToTray": true })
        );
        let state = TrayState::default();
        state.close_to_tray.store(true, Ordering::SeqCst);
        assert!(!state.result().close_to_tray);
        state.supported.store(true, Ordering::SeqCst);
        assert!(state.result().close_to_tray);
    }

    #[test]
    fn confirmation_preserves_legacy_and_never_retrays_explicit_exit() {
        assert_eq!(
            confirmed_close_action(false, false, false),
            CloseAction::Destroy
        );
        assert_eq!(
            confirmed_close_action(false, true, false),
            CloseAction::Destroy
        );
        assert_eq!(
            confirmed_close_action(true, false, false),
            CloseAction::Hide
        );
        assert_eq!(confirmed_close_action(true, true, false), CloseAction::Exit);
        for tray in [false, true] {
            for stop in [false, true] {
                assert_eq!(confirmed_close_action(tray, stop, true), CloseAction::Exit);
            }
        }
    }

    #[test]
    fn close_event_and_settings_match_frontend_contract() {
        let payload = CloseRequested {
            close_to_tray: true,
            exit_app: false,
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({ "closeToTray": true, "exitApp": false })
        );
        assert_eq!(
            serde_json::to_value(TraySettings {
                supported: true,
                close_to_tray: false
            })
            .unwrap(),
            serde_json::json!({ "supported": true, "closeToTray": false })
        );
        assert_eq!(
            menu_text(TrayServiceStatus::External, "zh-CN".starts_with("zh")),
            "后端：外部服务（不可启停）"
        );
    }

    #[test]
    fn hidden_main_does_not_block_last_visible_window_exit() {
        assert!(last_visible_label(
            "win-1",
            [("main", false), ("win-1", true)].into_iter()
        ));
        assert!(!last_visible_label(
            "win-1",
            [("main", true), ("win-1", true)].into_iter()
        ));
        assert!(last_visible_label(
            "main",
            [("main", true), ("win-1", false)].into_iter()
        ));
    }

    #[test]
    fn local_settings_roundtrip_and_failed_replace_preserves_saved_file() {
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("ompiui-tray-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("tray-settings.json");
        assert!(!read_config(&path).unwrap().close_to_tray);
        save_config(
            &path,
            &TrayConfig {
                close_to_tray: true,
            },
        )
        .unwrap();
        assert!(read_config(&path).unwrap().close_to_tray);
        save_config(&path, &TrayConfig::default()).unwrap();
        assert!(!read_config(&path).unwrap().close_to_tray);
        let invalid = directory.join("directory.json");
        fs::create_dir_all(&invalid).unwrap();
        assert!(save_config(
            &invalid,
            &TrayConfig {
                close_to_tray: true
            }
        )
        .is_err());
        assert!(invalid.is_dir());
        assert!(!read_config(&path).unwrap().close_to_tray);
        fs::remove_dir_all(directory).unwrap();
    }
}
