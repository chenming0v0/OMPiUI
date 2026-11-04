use std::{
    collections::{BTreeMap, VecDeque},
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager};

use super::DEFAULT_PORT;

pub(super) struct PreparedServer {
    binary: PathBuf,
    resource: PathBuf,
    native_modules: PathBuf,
}

pub(super) fn service_environment(
    native_modules: Option<&Path>,
    custom: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::from([
        ("OMPIUI_HOST".to_string(), "127.0.0.1".to_string()),
        ("OMPIUI_PORT".to_string(), DEFAULT_PORT.to_string()),
        ("OMPIUI_DRIVER".to_string(), "omp".to_string()),
    ]);
    if let Some(path) = native_modules {
        environment.insert(
            "OMPIUI_NATIVE_MODULES".to_string(),
            path.display().to_string(),
        );
    }
    environment.extend(
        custom
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    environment
}

pub(super) fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        let text = path.to_string_lossy();
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(stripped));
        }
    }
    Ok(path)
}

/// 桌面壳在 Tauri resource 目录里查找的后端可执行文件名。
///
/// 必须与 `scripts/prepare-tauri-resources.mjs` 拷进去的文件名一致（即
/// `scripts/package-desktop.mjs` 的 bun 编译产物）。改名不同步会让桌面端
/// 永远找不到自带的 server，启动服务时报「server binary was not bundled」。
fn bundled_server_binary(resource: &Path) -> Result<PathBuf, String> {
    let binary = resource.join(if cfg!(target_os = "windows") {
        "omp-worker.exe"
    } else {
        "omp-worker"
    });
    binary.is_file().then_some(binary).ok_or_else(|| {
        format!(
            "OMPiUI server binary was not bundled in {}",
            resource.display()
        )
    })
}

fn server_binary(resource: &Path) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("OMPIUI_SERVER_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    bundled_server_binary(resource)
}

pub(super) fn prepare_backend(resource: PathBuf) -> Result<PreparedServer, String> {
    let binary = server_binary(&resource)?;
    let native_modules = resource.join("node_modules");
    Ok(PreparedServer {
        binary,
        resource,
        native_modules,
    })
}

pub(super) fn prepare_server(app: &AppHandle) -> Result<PreparedServer, String> {
    let prepared = prepare_backend(resource_root(app)?)?;
    if !prepared.native_modules.join("bun-pty").is_dir() {
        return Err(format!(
            "bun-pty was not bundled in {}",
            prepared.native_modules.display()
        ));
    }
    Ok(prepared)
}

// inspection 与服务启动共用 binary、cwd、继承环境及 Windows 无窗口标志。
fn backend_command(
    prepared: &PreparedServer,
    subcommand: &str,
    custom_environment: &BTreeMap<String, String>,
) -> Command {
    let mut command = Command::new(&prepared.binary);
    command
        .arg(subcommand)
        .current_dir(&prepared.resource)
        .envs(service_environment(Some(&prepared.native_modules), custom_environment));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

pub(super) fn inspect_runtime(
    prepared: PreparedServer,
    custom_environment: &BTreeMap<String, String>,
) -> Result<Vec<u8>, String> {
    let command = backend_command(&prepared, "inspect-runtime", custom_environment);
    inspection_output(command, Duration::from_secs(15))
}

// 两条管道并行读取，避免 stdout/stderr 填满阻塞子进程；等待和读取共用截止时间。
fn inspection_output(mut command: Command, timeout: Duration) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;
    use std::time::Instant;

    fn read_pipe(reader: impl Read + Send + 'static) -> mpsc::Receiver<std::io::Result<Vec<u8>>> {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = BufReader::new(reader).read_to_end(&mut bytes).map(|_| bytes);
            let _ = sender.send(result);
        });
        receiver
    }

    let deadline = Instant::now() + timeout;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to inspect OMPiUI runtime: {error}"))?;
    let stdout = read_pipe(child.stdout.take().expect("piped stdout"));
    let stderr = read_pipe(child.stderr.take().expect("piped stderr"));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25).min(deadline.saturating_duration_since(Instant::now())));
            }
            result => {
                // 只终止本次 inspection 子进程，不清场或操作任何服务/Agent。
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("failed to wait for runtime inspection: {error}"),
                    _ => "OMPiUI runtime inspection timed out".to_string(),
                });
            }
        }
    };
    let receive = |pipe: mpsc::Receiver<std::io::Result<Vec<u8>>>| {
        pipe.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "OMPiUI runtime inspection output timed out".to_string())?
            .map_err(|error| format!("failed to read runtime inspection: {error}"))
    };
    let stdout = receive(stdout)?;
    let stderr = receive(stderr)?;
    if !status.success() {
        return Err(format!(
            "OMPiUI runtime inspection exited with {status}: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(stdout)
}

fn spawn_output_reader<R>(reader: R, output: Arc<Mutex<VecDeque<String>>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if let Ok(mut recent) = output.lock() {
                if recent.len() >= 24 {
                    recent.pop_front();
                }
                recent.push_back(line);
            }
        }
    });
}

pub(super) fn spawn_server(
    prepared: PreparedServer,
    output: Arc<Mutex<VecDeque<String>>>,
    custom_environment: &BTreeMap<String, String>,
) -> Result<Child, String> {
    let mut command = backend_command(&prepared, "web", custom_environment);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start OMPiUI server: {error}"))?;
    if let Some(stdout) = child.stdout.take() {
        spawn_output_reader(stdout, output.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_output_reader(stderr, output);
    }
    Ok(child)
}

#[cfg(target_os = "windows")]
pub(super) fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let _ = command.status();
}

/// 请求服务端优雅关闭（POST /api/v1/host/shutdown，带鉴权）。
///
/// Windows 没有 SIGTERM：taskkill /F 直接 TerminateProcess，server 的
/// SIGINT/SIGTERM handler 永远不会被调用，监听 socket 和活动连接瞬间僵死，
/// 留下孤儿 TCP 实体占用端口。必须先走 HTTP 优雅关闭（等 stop() 关监听、
/// 排空连接、dispose worker），超时才允许强杀兜底。
pub(super) async fn request_graceful_shutdown(url: &str, token: Option<&str>) -> bool {
    let client = reqwest::Client::new();
    let mut request = client
        .post(format!("{}/api/v1/host/shutdown", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(3));
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(token);
    }
    match request.send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[cfg(target_os = "windows")]
pub(super) fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    if pid == 0 {
        return false;
    }
    // 只查询指定 PID；tasklist 依赖系统管理服务，实机会阻塞数分钟。
    // 进程退出时句柄变为有信号，零超时等待不会阻塞启动线程。
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let alive = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        alive
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn kill_process_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(target_os = "windows"))]
pub(super) fn is_process_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspection_and_server_commands_share_environment_and_resource_cwd() {
        let prepared = PreparedServer {
            binary: PathBuf::from("C:/installed/omp-worker.exe"),
            resource: PathBuf::from("C:/installed"),
            native_modules: PathBuf::from("C:/installed/node_modules"),
        };
        let custom = BTreeMap::from([
            ("OMPI_OMP_BIN".to_string(), "C:/external/omp.exe".to_string()),
            ("OMPIUI_NATIVE_MODULES".to_string(), "C:/custom/node_modules".to_string()),
            ("PATH".to_string(), "C:/external/bin".to_string()),
        ]);
        let web = backend_command(&prepared, "web", &custom);
        let inspection = backend_command(&prepared, "inspect-runtime", &custom);
        assert_eq!(web.get_program(), inspection.get_program());
        assert_eq!(web.get_current_dir(), inspection.get_current_dir());
        assert_eq!(inspection.get_current_dir(), Some(prepared.resource.as_path()));
        assert_eq!(web.get_envs().collect::<Vec<_>>(), inspection.get_envs().collect::<Vec<_>>());
        assert_eq!(inspection.get_args().collect::<Vec<_>>(), vec![std::ffi::OsStr::new("inspect-runtime")]);
        let environment = inspection.get_envs().collect::<BTreeMap<_, _>>();
        assert_eq!(environment[std::ffi::OsStr::new("OMPIUI_DRIVER")], Some(std::ffi::OsStr::new("omp")));
        assert_eq!(environment[std::ffi::OsStr::new("PATH")], Some(std::ffi::OsStr::new("C:/external/bin")));
        assert_eq!(environment[std::ffi::OsStr::new("OMPIUI_NATIVE_MODULES")], Some(std::ffi::OsStr::new("C:/custom/node_modules")));
    }

    #[test]
    fn inspection_preparation_does_not_require_pty_or_omp_resources() {
        let resource = env::temp_dir().join(format!(
            "ompiui-inspection-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir(&resource).unwrap();
        let binary = resource.join(if cfg!(windows) { "omp-worker.exe" } else { "omp-worker" });
        // 仅构造安装目录，不执行这个空文件，也不创建 OMP 或 PTY 资源。
        std::fs::write(&binary, []).unwrap();
        let prepared = prepare_backend(resource.clone()).unwrap();
        assert_eq!(prepared.resource, resource);
        assert!(!prepared.native_modules.exists());
        assert!(!resource.join("omp-runtime").exists());
        std::fs::remove_dir_all(resource).unwrap();
    }
}
