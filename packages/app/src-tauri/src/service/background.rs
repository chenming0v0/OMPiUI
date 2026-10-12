use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, env, fs, path::PathBuf, process::{Child, Command, Stdio}, time::{Duration, Instant}};
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    login_start: bool,
    crash_recovery: bool,
    environment: BTreeMap<String, String>,
    backend_environment: BTreeMap<String, String>,
    desired: bool,
    paused_for_update: bool,
    restore_after_update: bool,
    backend_pid: Option<u32>,
    supervisor_pid: Option<u32>,
    last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    supported: bool,
    login_start: bool,
    crash_recovery: bool,
    lifecycle: &'static str,
    pid: Option<u32>,
    last_error: Option<String>,
}

fn config_path() -> Result<PathBuf, String> {
    let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))
        .ok_or("Home directory is unavailable")?;
    Ok(env::var_os("OMPIUI_BACKGROUND_DIR").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".ompiui")).join("background.json"))
}

#[cfg(windows)]
struct NamedLock(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for NamedLock {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(self.0);
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn lock(kind: &str, timeout_ms: u32) -> Result<Option<NamedLock>, String> {
    use std::hash::{Hash, Hasher};
    use windows_sys::Win32::{Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_ABANDONED, WAIT_TIMEOUT}, System::Threading::{CreateMutexW, WaitForSingleObject}};
    static DOMAIN: std::sync::LazyLock<Result<u64, String>> = std::sync::LazyLock::new(|| {
        let path = config_path()?;
        let parent = path.parent().ok_or("Invalid background configuration directory")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let identity = parent.canonicalize().map_err(|error| error.to_string())?;
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        identity.to_string_lossy().to_lowercase().hash(&mut hash);
        Ok(hash.finish())
    });
    let domain = DOMAIN.as_ref().map_err(|error| error.clone())?;
    let name: Vec<u16> = format!("Local\\OMPiUI.Background.{kind}.{domain:x}\0").encode_utf16().collect();
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
        match WaitForSingleObject(handle, timeout_ms) {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Some(NamedLock(handle))),
            WAIT_TIMEOUT => { CloseHandle(handle); Ok(None) },
            _ => { let error = std::io::Error::last_os_error(); CloseHandle(handle); Err(error.to_string()) }
        }
    }
}

fn read_config() -> Result<Config, String> {
    let path = config_path()?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Background configuration is invalid; automatic startup is disabled".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn update_config<T>(update: impl FnOnce(&mut Config) -> T) -> Result<T, String> {
    #[cfg(windows)]
    let _lock = lock("Config", 10_000)?.ok_or("Background configuration is busy")?;
    let mut config = read_config()?;
    let result = update(&mut config);
    let path = config_path()?;
    fs::create_dir_all(path.parent().ok_or("Invalid background configuration path")?).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temporary, serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Cannot write background configuration: {error}"))?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // Windows antivirus/indexing readers can temporarily deny replacement.
        // Keep the old complete file until the atomic replace succeeds; never
        // fall back to truncating the live configuration or discard the error.
        let deadline = Instant::now() + Duration::from_millis(500);
        loop {
            if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } != 0 { break; }
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(5 | 32)) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            let _ = fs::remove_file(&temporary);
            return Err(format!("Cannot atomically replace background configuration: {error}"));
        }
    }
    #[cfg(not(windows))]
    fs::rename(temporary, path).map_err(|error| error.to_string())?;
    Ok(result)
}

fn binary() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let path = executable.parent().ok_or("Installation directory is unavailable")?.join("omp-worker.exe");
    if !path.is_file() { return Err("The installed omp-worker.exe is missing".to_string()); }
    Ok(path)
}

#[cfg(windows)]
struct BackendProcess(OwnedHandle);
#[cfg(windows)]
impl BackendProcess {
    fn open(pid: u32) -> Result<Option<Self>, String> {
        use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
        let expected = binary()?.canonicalize().map_err(|error| error.to_string())?;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() { return Ok(None); }
            let process = Self(OwnedHandle::from_raw_handle(handle));
            let mut name = [0u16; 32768];
            let mut length = name.len() as u32;
            if QueryFullProcessImageNameW(handle, 0, name.as_mut_ptr(), &mut length) == 0 { return Err("Cannot verify the managed backend identity".to_string()); }
            let actual = PathBuf::from(String::from_utf16_lossy(&name[..length as usize]));
            if actual.canonicalize().map_err(|error| error.to_string())?.to_string_lossy().to_lowercase() != expected.to_string_lossy().to_lowercase() {
                return Ok(None);
            }
            Ok(Some(process))
        }
    }
    fn exited(&self) -> Option<u32> {
        use windows_sys::Win32::{Foundation::WAIT_TIMEOUT, System::Threading::{WaitForSingleObject, GetExitCodeProcess}};
        unsafe {
            if WaitForSingleObject(self.0.as_raw_handle(), 0) == WAIT_TIMEOUT { return None; }
            let mut code = 1;
            GetExitCodeProcess(self.0.as_raw_handle(), &mut code);
            Some(code)
        }
    }
}

fn configured(config: &Config) -> bool { config.login_start || config.crash_recovery }

fn launch_supervisor() -> Result<(), String> {
    let mut command = Command::new(env::current_exe().map_err(|error| error.to_string())?);
    command.arg("--background").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000 | 0x00000008); }
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn configure_login(enabled: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    let mut command = Command::new("reg.exe");
    if enabled {
        let target = format!("\"{}\" --background", env::current_exe().map_err(|error| error.to_string())?.display());
        command.args(["ADD", key, "/v", "OMPiUIBackground", "/t", "REG_SZ", "/d", &target, "/f"]);
    } else {
        let exists = Command::new("reg.exe").args(["QUERY", key, "/v", "OMPiUIBackground"])
            .creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|error| error.to_string())?.success();
        if !exists { return Ok(()); }
        command.args(["DELETE", key, "/v", "OMPiUIBackground", "/f"]);
    }
    if !command.creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|error| error.to_string())?.success() {
        return Err("Cannot update the OMPiUI login startup registration".to_string());
    }
    Ok(())
}

pub fn enabled() -> Result<bool, String> { Ok(cfg!(windows) && configured(&read_config()?)) }

pub async fn status() -> Result<BackgroundStatus, String> {
    if !cfg!(windows) {
        return Ok(BackgroundStatus { supported: false, login_start: false, crash_recovery: false, lifecycle: "disabled", pid: None, last_error: None });
    }
    let config = read_config()?;
    #[cfg(windows)]
    let running = match config.backend_pid {
        Some(pid) => BackendProcess::open(pid)?.is_some_and(|process| process.exited().is_none()),
        None => false,
    };
    #[cfg(not(windows))]
    let running = false;
    let lifecycle = if config.paused_for_update { "update-paused" } else if !configured(&config) { "disabled" }
        else if !config.desired { "stopped" } else if running { "running" } else { "recovering" };
    Ok(BackgroundStatus { supported: true, login_start: config.login_start, crash_recovery: config.crash_recovery,
        lifecycle, pid: config.backend_pid.filter(|_| running), last_error: config.last_error })
}

pub async fn connection() -> Result<Option<(u32, String, String)>, String> {
    let config = read_config()?;
    let Some(pid) = config.backend_pid else { return Ok(None); };
    let effective = if config.backend_environment.is_empty() { config.environment } else { config.backend_environment };
    let service = super::ServiceConfig::new(effective);
    let Some(token) = service.token() else { return Ok(None); };
    if super::service_matches_pid(&service.url, Some(&token), pid).await {
        Ok(Some((pid, service.url, token)))
    } else { Ok(None) }
}

pub async fn settings(login_start: bool, crash_recovery: bool, environment: BTreeMap<String, String>, existing_pid: Option<u32>) -> Result<BackgroundStatus, String> {
    if !cfg!(windows) { return Err("Background management is supported only on Windows".to_string()); }
    #[cfg(windows)]
    configure_login(login_start)?;
    let needs_supervisor = update_config(|config| {
        let was_enabled = configured(config);
        config.login_start = login_start;
        config.crash_recovery = crash_recovery;
        config.environment = environment;
        if !was_enabled && configured(config) { config.desired = true; }
        if config.backend_pid.is_none() {
            if let Some(pid) = existing_pid {
                config.backend_pid = Some(pid);
                config.backend_environment = config.environment.clone();
                config.desired = true;
            }
        }
        configured(config) && config.desired && !config.paused_for_update
    })?;
    if needs_supervisor { launch_supervisor()?; }
    status().await
}

pub fn remember_backend(environment: BTreeMap<String, String>, pid: u32) -> Result<(), String> {
    if !cfg!(windows) { return Ok(()); }
    update_config(|config| {
        config.backend_environment = environment.clone();
        config.environment = environment;
        config.backend_pid = (pid > 0).then_some(pid);
        config.desired = pid > 0;
    })
}

pub async fn start(environment: BTreeMap<String, String>, existing_pid: Option<u32>) -> Result<(u32, String, String), String> {
    let previous = read_config()?;
    if previous.paused_for_update { return Err("Background startup is paused for an update".to_string()); }
    if previous.backend_pid.is_some() && !previous.backend_environment.is_empty() && previous.backend_environment != environment {
        stop().await?;
    }
    update_config(|config| {
        if config.paused_for_update { return Err("Background startup is paused for an update".to_string()); }
        config.environment = environment;
        config.desired = true;
        config.last_error = None;
        if config.backend_pid.is_none() { config.backend_pid = existing_pid; }
        Ok(())
    })??;
    launch_supervisor()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let config = read_config()?;
        if !config.desired || config.paused_for_update { return Err("Background startup was stopped".to_string()); }
        let service = super::ServiceConfig::new(config.environment.clone());
        if let Some(pid) = config.backend_pid {
            if let Some(token) = service.token() {
                if super::service_matches_pid(&service.url, Some(&token), pid).await { return Ok((pid, service.url, token)); }
            }
        }
        if Instant::now() >= deadline { return Err(config.last_error.unwrap_or_else(|| "Background startup timed out".to_string())); }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn shutdown_recorded(config: &Config) -> Result<(), String> {
    let Some(pid) = config.backend_pid else { return Ok(()); };
    #[cfg(windows)]
    {
        let Some(process) = BackendProcess::open(pid)? else { return Ok(()); };
        if process.exited().is_some() { return Ok(()); }
        let effective = if config.backend_environment.is_empty() { &config.environment } else { &config.backend_environment };
        let service = super::ServiceConfig::new(effective.clone());
        let token = service.token();
        if !super::service_matches_pid(&service.url, token.as_deref(), pid).await {
            return Err("Cannot verify backend health; shutdown was not sent to an unrelated listener".to_string());
        }
        super::process::request_graceful_shutdown(&service.url, token.as_deref()).await;
        let deadline = Instant::now() + Duration::from_secs(25);
        while process.exited().is_none() && Instant::now() < deadline { tokio::time::sleep(Duration::from_millis(100)).await; }
        if process.exited().is_none() {
            super::process::kill_process_tree(pid);
            let deadline = Instant::now() + Duration::from_secs(5);
            while process.exited().is_none() && Instant::now() < deadline { tokio::time::sleep(Duration::from_millis(100)).await; }
            if process.exited().is_none() { return Err("The managed backend did not stop; update is blocked".to_string()); }
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
    Ok(())
}

pub async fn stop() -> Result<(), String> {
    stop_with_intent(false).await
}

async fn stop_with_intent(preserve_update: bool) -> Result<(), String> {
    if !cfg!(windows) { return Ok(()); }
    let config = update_config(|config| {
        config.desired = false;
        if !preserve_update { config.restore_after_update = false; }
        config.clone()
    })?;
    // The persisted stop intent wins over any concurrent crash recovery.
    shutdown_recorded(&config).await?;
    let deadline = Instant::now() + Duration::from_secs(5);
    #[cfg(windows)]
    while lock("Supervisor", 0)?.is_none() {
        if Instant::now() >= deadline { return Err("Background supervisor has not stopped".to_string()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    update_config(|config| { config.backend_pid = None; config.supervisor_pid = None; config.last_error = None; })?;
    Ok(())
}

#[cfg(windows)]
async fn supervise() -> Result<(), String> {
    let Some(_singleton) = lock("Supervisor", 0)? else { return Ok(()); };
    let initial = read_config()?;
    if !configured(&initial) || !initial.desired || initial.paused_for_update { return Ok(()); }
    update_config(|config| config.supervisor_pid = Some(std::process::id()))?;
    let result = supervise_loop().await;
    update_config(|config| {
        if config.supervisor_pid == Some(std::process::id()) { config.supervisor_pid = None; }
        if result.is_err() { config.desired = false; config.last_error = Some("Background supervisor stopped after a management failure".to_string()); }
    })?;
    result
}

#[cfg(windows)]
async fn supervise_loop() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut child: Option<Child> = None;
    let mut observed: Option<BackendProcess> = None;
    let mut failures = 0u32;
    let mut started = Instant::now();
    loop {
        let config = read_config()?;
        if !configured(&config) { return Ok(()); }
        if !config.desired || config.paused_for_update { shutdown_recorded(&config).await?; return Ok(()); }
        if observed.is_none() {
            if let Some(pid) = config.backend_pid {
                observed = BackendProcess::open(pid)?;
            }
            if observed.is_none() {
                let worker = binary()?;
                let resource = worker.parent().ok_or("Installation directory is unavailable")?;
                let native_modules = resource.join("node_modules");
                let environment = super::process::service_environment(Some(&native_modules), &config.environment);
                let spawned = Command::new(&worker).arg("web").current_dir(resource).envs(environment)
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x08000000).spawn();
                match spawned {
                    Ok(process) => {
                        let pid = process.id();
                        child = Some(process);
                        observed = BackendProcess::open(pid)?;
                        update_config(|next| {
                            next.backend_pid = Some(pid);
                            next.backend_environment = config.environment.clone();
                            next.last_error = None;
                        })?;
                        started = Instant::now();
                    }
                    Err(_) => {
                        update_config(|config| config.last_error = Some("The installed backend could not be started".to_string()))?;
                        if !config.crash_recovery { update_config(|config| config.desired = false)?; return Ok(()); }
                        failures = failures.saturating_add(1);
                    }
                }
            }
        }
        let exited = child.as_mut().and_then(|process| process.try_wait().ok().flatten())
            .map(|status| status.code().unwrap_or(1) as u32)
            .or_else(|| observed.as_ref().and_then(BackendProcess::exited));
        if let Some(code) = exited {
            if let Some(mut process) = child.take() { let _ = process.wait(); }
            observed = None;
            update_config(|config| config.backend_pid = None)?;
            if code == 0 || !config.crash_recovery { update_config(|config| config.desired = false)?; return Ok(()); }
            if started.elapsed() > Duration::from_secs(60) { failures = 0; }
            failures = failures.saturating_add(1);
            update_config(|config| config.last_error = Some("The backend exited abnormally; waiting to recover".to_string()))?;
        }
        if observed.is_none() {
            let backoff = Duration::from_secs(1u64 << failures.min(5));
            let until = Instant::now() + backoff;
            while Instant::now() < until {
                let config = read_config()?;
                if !config.desired || config.paused_for_update || !configured(&config) { return Ok(()); }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        } else { tokio::time::sleep(Duration::from_millis(250)).await; }
    }
}

pub fn handle_cli() -> Option<i32> {
    let argument = env::args().nth(1)?;
    if !["--background", "--background-pause-update", "--background-resume-update", "--background-uninstall"].contains(&argument.as_str()) { return None; }
    if !cfg!(windows) { return Some(1); }
    let result: Result<(), String> = tauri::async_runtime::block_on(async {
        match argument.as_str() {
            "--background" => {
                #[cfg(windows)]
                { supervise().await?; }
                Ok(())
            }
            "--background-pause-update" => {
                update_config(|config| {
                    if !config.paused_for_update { config.restore_after_update = config.desired && configured(config); }
                    config.paused_for_update = true;
                    config.desired = false;
                })?;
                stop_with_intent(true).await
            }
            "--background-resume-update" => {
                let previous = read_config()?;
                if previous.paused_for_update && previous.backend_pid.is_some() { stop_with_intent(true).await?; }
                let restore = update_config(|config| {
                    if config.paused_for_update {
                        config.paused_for_update = false;
                        config.desired = config.restore_after_update && configured(config);
                        config.restore_after_update = false;
                        config.backend_pid = None;
                    }
                    config.desired && configured(config)
                })?;
                #[cfg(windows)]
                configure_login(read_config()?.login_start)?;
                if restore { launch_supervisor()?; }
                Ok(())
            }
            "--background-uninstall" => {
                update_config(|config| {
                    if !config.paused_for_update { config.restore_after_update = config.desired && configured(config); }
                    config.paused_for_update = true;
                    config.desired = false;
                })?;
                stop_with_intent(true).await?;
                #[cfg(windows)]
                configure_login(false)?;
                // Preserve passive user preferences for NSIS's uninstall-before-
                // reinstall path. No process or login entry survives uninstall;
                // only a subsequent explicit installer completion can resume.
                Ok(())
            }
            _ => unreachable!(),
        }
    });
    if let Err(error) = result { eprintln!("OMPiUI background operation failed: {error}"); Some(1) } else { Some(0) }
}
