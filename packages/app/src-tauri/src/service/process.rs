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

pub(super) fn prepare_server(app: &AppHandle) -> Result<PreparedServer, String> {
    let resource = resource_root(app)?;
    let binary = server_binary(&resource)?;
    let native_modules = resource.join("node_modules");
    if !native_modules.join("bun-pty").is_dir() {
        return Err(format!(
            "bun-pty was not bundled in {}",
            native_modules.display()
        ));
    }
    Ok(PreparedServer {
        binary,
        resource,
        native_modules,
    })
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
    let environment = service_environment(Some(&prepared.native_modules), custom_environment);
    let mut command = Command::new(&prepared.binary);
    command
        .arg("web")
        .current_dir(&prepared.resource)
        .envs(environment)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

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
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("tasklist");
    command
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(0x08000000);
    command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\",\"{pid}\",")))
        .unwrap_or(false)
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

    /// 打包脚本 (prepare-tauri-resources.mjs → package-desktop.mjs) 产出的
    /// 文件名，钉住桌面壳查找路径：改错任一侧都会让桌面端找不到自带 server。
    #[test]
    fn bundled_server_binary_matches_packaged_name() {
        let dir = env::temp_dir().join(format!("ompiui-bundled-binary-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");

        assert!(
            bundled_server_binary(&dir).is_err(),
            "empty resource dir must not resolve"
        );

        let name = if cfg!(target_os = "windows") {
            "omp-worker.exe"
        } else {
            "omp-worker"
        };
        std::fs::write(dir.join(name), b"").expect("write bundled binary");
        let found = bundled_server_binary(&dir).expect("packaged name must resolve");

        std::fs::remove_dir_all(&dir).expect("clean temp dir");
        assert_eq!(found, dir.join(name));
    }
}
