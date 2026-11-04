use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    process::Child,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use reqwest::Client;
use tauri::{AppHandle, Manager, State};

mod marker;
mod process;
mod diagnostics;
pub mod background;

pub use diagnostics::get_ompiui_service_diagnostics;
use diagnostics::{Phase, StartupDiagnostics};

use process::{
    is_process_alive, kill_process_tree, prepare_server, request_graceful_shutdown, resource_root,
    service_environment, spawn_server,
};

const DEFAULT_PORT: &str = "8787";

pub struct ServiceState {
    child: Mutex<Option<Child>>,
    child_pid: AtomicU32,
    started_by_us: AtomicBool,
    /// 用户在关闭确认里选择「保留后台服务」：退出兜底不再强杀子进程。
    keep_on_exit: AtomicBool,
    lifecycle: tokio::sync::Mutex<()>,
    operations: tokio::sync::Mutex<()>,
    is_operating: AtomicBool,
    startup: StartupDiagnostics,
    /// 有 start 命令正在等 health，其他命令不要把它当僵死进程杀掉。
    is_starting: AtomicBool,
    service_url: Mutex<Option<String>>,
    /// 当前托管服务的鉴权 token（优雅关闭请求需要带鉴权头）。
    service_token: Mutex<Option<String>>,
    output: Arc<Mutex<VecDeque<String>>>,
}

impl ServiceState {
    pub fn should_confirm_close(&self) -> bool {
        let pid = self.child_pid.load(Ordering::SeqCst);
        (self.started_by_us.load(Ordering::SeqCst) && pid > 0 && is_process_alive(pid))
            || self.is_operating.load(Ordering::SeqCst)
    }

    /// 应用退出前的最后兜底（RunEvent::Exit）：无论前端确认弹窗是否走到，
    /// 只要服务是我们启动的、且用户没选择「保留后台服务」，就杀掉子进程，
    /// 防止孤儿进程长期占用端口。强杀（taskkill /F、断电）不会经过这里，
    /// 那类场景由下次启动时的收养逻辑清场。
    pub fn stop_service_on_exit(&self) {
        if self.keep_on_exit.load(Ordering::SeqCst) {
            return;
        }
        if background::enabled().unwrap_or(true) {
            let _ = tauri::async_runtime::block_on(background::stop());
            return;
        }
        // 如果服务还在冷启动中，先等一小会儿让启动完成或失败，避免退出时
        // 留下状态不一致的半成品进程。
        if self.is_starting.load(Ordering::SeqCst) {
            tauri::async_runtime::block_on(async {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                while self.is_starting.load(Ordering::SeqCst)
                    && tokio::time::Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            });
        }
        if !self.started_by_us.swap(false, Ordering::SeqCst) {
            return;
        }
        let pid = self.child_pid.swap(0, Ordering::SeqCst);
        let url = self.service_url.lock().ok().and_then(|mut guard| guard.take());
        let token = self.service_token.lock().ok().and_then(|mut guard| guard.take());
        if pid > 0 {
            if let Some(url) = url {
                // 核对身份：URL 上活着的必须是我们的 pid 才发 HTTP 关闭。
                // 子进程早死、端口被外部服务接管时，盲发会误杀别人的服务。
                let ours = tauri::async_runtime::block_on(service_matches_pid(&url, token.as_deref(), pid));
                if ours {
                    // 同步的 RunEvent::Exit 上下文：block_on 跑一次带短超时的优雅关闭
                    // （请求 3s + 等待退出 ~3s），失败/超时则强杀兜底，不留孤儿端口。
                    // 注意：server 优雅关闭要等 worker 清理所有 runtime（dispose 预算
                    // 15s），这里等待必须覆盖它，否则每次都强杀 → 会话锁残留 →
                    // 重启后 SESSION_BUSY 要等 60s stale 过期。
                    let graceful = tauri::async_runtime::block_on(request_graceful_shutdown(&url, token.as_deref()));
                    if graceful {
                        // 用持有的 Child 句柄 try_wait 判断退出（零子进程开销），
                        // 不用 tasklist 轮询（每次 ~130ms 的进程创建）。
                        let deadline = std::time::Instant::now() + Duration::from_secs(20);
                        while std::time::Instant::now() < deadline {
                            let exited = self
                                .child
                                .lock()
                                .ok()
                                .and_then(|mut child| child.as_mut().and_then(|process| process.try_wait().ok()).flatten())
                                .is_some();
                            if exited {
                                break
                            }
                            std::thread::sleep(Duration::from_millis(100));
                        }
                    }
                }
            }
            if is_process_alive(pid) {
                kill_process_tree(pid);
            }
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(process) = child.as_mut() {
                let _ = process.kill();
                let _ = process.wait();
            }
            *child = None;
        }
    }
}

struct OperationGuard<'a>(&'a AtomicBool);
impl<'a> OperationGuard<'a> {
    fn new(state: &'a ServiceState) -> Self {
        state.is_operating.store(true, Ordering::SeqCst);
        Self(&state.is_operating)
    }
}
impl Drop for OperationGuard<'_> {
    fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
}

impl Default for ServiceState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            child_pid: AtomicU32::new(0),
            started_by_us: AtomicBool::new(false),
            keep_on_exit: AtomicBool::new(false),
            lifecycle: tokio::sync::Mutex::new(()),
            operations: tokio::sync::Mutex::new(()),
            is_operating: AtomicBool::new(false),
            startup: StartupDiagnostics::default(),
            is_starting: AtomicBool::new(false),
            service_url: Mutex::new(None),
            service_token: Mutex::new(None),
            output: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartServiceResult {
    pub started: bool,
    pub started_by_us: bool,
    pub url: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusResult {
    pub running: bool,
    pub started_by_us: bool,
    pub pid: Option<u32>,
    pub url: Option<String>,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    process_id: Option<u32>,
    worker_ready: Option<bool>,
    started_at: Option<u64>,
}

enum HealthFailure {
    Unreachable,
    Rejected(String),
}

struct ServiceConfig {
    environment: BTreeMap<String, String>,
    url: String,
    initial_token: Option<String>,
}

impl ServiceConfig {
    fn new(environment: BTreeMap<String, String>) -> Self {
        let url = configured_service_url(&environment);
        let initial_token = read_token(&environment).ok();
        Self {
            environment,
            url,
            initial_token,
        }
    }

    fn token(&self) -> Option<String> {
        read_token(&self.environment)
            .ok()
            .or_else(|| self.initial_token.clone())
    }
}

fn read_token(env_vars: &BTreeMap<String, String>) -> Result<String, String> {
    if let Some(token) = env_vars.get("OMPIUI_AUTH_TOKEN") {
        let token = token.trim();
        return if token.is_empty() {
            Err("OMPIUI_AUTH_TOKEN is empty".to_string())
        } else {
            Ok(token.to_string())
        };
    }
    if let Ok(token) = env::var("OMPIUI_AUTH_TOKEN") {
        let token = token.trim();
        if !token.is_empty() {
            return Ok(token.to_string());
        }
    }
    let home = if cfg!(target_os = "windows") {
        env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        env::var_os("HOME").map(PathBuf::from)
    }
    .ok_or_else(|| "home directory is unavailable".to_string())?;
    let (data_dir, explicit_data_dir) = env_vars
        .get("OMPIUI_DATA_DIR")
        .map(|value| (PathBuf::from(value), true))
        .or_else(|| env::var_os("OMPIUI_DATA_DIR").map(|value| (PathBuf::from(value), true)))
        .unwrap_or_else(|| (home.join(".ompiui"), false));
    let path = data_dir.join("auth-token");
    let read_token_at = |path: &Path| {
        fs::read_to_string(path)
            .map(|token| token.trim().to_string())
            .map_err(|error| {
                format!(
                    "failed to read OMPiUI auth token at {}: {error}",
                    path.display()
                )
            })
            .and_then(|token| {
                if token.is_empty() {
                    Err(format!("OMPiUI auth token at {} is empty", path.display()))
                } else {
                    Ok(token)
                }
            })
    };
    match read_token_at(&path) {
        Ok(token) => Ok(token),
        Err(error) => {
            // PiUI 时代的默认目录（~/.piui）：只读兜底一次，绝不写入——
            // server 首次启动会把旧 token 迁移进 ~/.ompiui，之后读不到这里。
            if explicit_data_dir {
                Err(error)
            } else {
                read_token_at(&home.join(".piui").join("auth-token"))
            }
        }
    }
}

fn recent_output(state: &ServiceState) -> String {
    state
        .output
        .lock()
        .ok()
        .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join(" | "))
        .filter(|output| !output.is_empty())
        .map(|output| format!(" Recent output: {output}"))
        .unwrap_or_default()
}

async fn service_health(url: &str, token: Option<&str>) -> Result<HealthResponse, HealthFailure> {
    service_health_with_timeout(url, token, Duration::from_secs(5)).await
}

async fn service_health_with_timeout(
    url: &str,
    token: Option<&str>,
    timeout: Duration,
) -> Result<HealthResponse, HealthFailure> {
    // 超时别太紧：服务端 health 是只读快照（不在请求路径上孵化/等待
    // worker），正常响应在毫秒级；但系统繁忙/杀软扫描时仍可能抖动，
    // 过紧的超时会把「活着」的服务误判为不可达，进而触发不必要的清场。
    let client = Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| HealthFailure::Unreachable)?;
    let mut request = client
        .get(format!("{}/api/v1/host/health", url.trim_end_matches('/')))
        .timeout(timeout);
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| HealthFailure::Unreachable)?;
    if !response.status().is_success() {
        return Err(HealthFailure::Rejected(response.status().to_string()));
    }
    response
        .json::<HealthResponse>()
        .await
        .map_err(|error| HealthFailure::Rejected(error.to_string()))
}

async fn is_service_running(url: &str, token: Option<&str>) -> bool {
    service_health(url, token).await.is_ok()
}

/// 校验 url 上活着的服务是我们 spawn 的那个 pid。
/// 这是防误杀的关键不变式：健康检查通 ≠ 是我们的进程（用户手动起的
/// server、pid 复用都会让端口健康）。认领 / 关闭 / 强杀前必须先核对身份，
/// 否则桌面壳会把别人的 server 当成自己的杀掉。
async fn service_matches_pid(url: &str, token: Option<&str>, pid: u32) -> bool {
    matches!(
        service_health(url, token).await,
        Ok(health) if health.process_id == Some(pid)
    )
}

/// 只清理我们自己的子进程，绝不碰 URL：用于「子进程还活着但端口已被
/// 外部服务接管」的极端场景——往 URL 发 HTTP 关闭会误杀别人的服务。
async fn stop_own_child_only(state: &ServiceState) {
    let pid = state.child_pid.swap(0, Ordering::SeqCst);
    state.started_by_us.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = state.service_url.lock() {
        guard.take();
    }
    if let Ok(mut guard) = state.service_token.lock() {
        guard.take();
    }
    if pid > 0 && is_process_alive(pid) {
        kill_process_tree(pid);
    }
    if let Ok(mut child) = state.child.lock() {
        if let Some(process) = child.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        *child = None;
    }
}

fn configured_service_url(env_vars: &BTreeMap<String, String>) -> String {
    let port = env_vars
        .get("OMPIUI_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let host = env_vars
        .get("OMPIUI_HOST")
        .map(String::as_str)
        .filter(|value| !value.is_empty() && *value != "0.0.0.0" && *value != "::")
        .unwrap_or("127.0.0.1");
    format!("http://{host}:{port}")
}

/// 等其他 start 命令完成（释放 lifecycle 锁后再轮询，避免死锁）。
async fn wait_for_start_to_complete(state: &ServiceState) {
    while state.is_starting.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn prepare_server_async(app: &AppHandle) -> Result<process::PreparedServer, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || prepare_server(&app))
        .await
        .map_err(|error| format!("failed to prepare OMPiUI runtime: {error}"))?
}

/// 残留服务收养的宽限探测：进程可能刚从上次启动冷启动（SDK worker 孵化
/// 要数秒），首轮探测不可达不等于僵死，重试几轮再判死。单次探测超时
/// 2s：health 是只读快照，毫秒级响应，2s 已足够覆盖系统抖动——5s × 4 轮
/// 的旧预算会让「进程活着但卡死」的场景在启动路径上白等 ~24s。
const ADOPT_HEALTH_ATTEMPTS: u32 = 3;
const ADOPT_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const ADOPT_HEALTH_RETRY_DELAY: Duration = Duration::from_millis(500);

async fn adopt_persisted_service(
    app: &AppHandle,
    state: &ServiceState,
    config: &ServiceConfig,
) -> Result<bool, String> {
    let Some(marker) = marker::read(app)? else {
        return Ok(false);
    };
    let mut last_failure = HealthFailure::Unreachable;
    for attempt in 0..ADOPT_HEALTH_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(ADOPT_HEALTH_RETRY_DELAY).await;
        }
        match service_health_with_timeout(&marker.url, config.initial_token.as_deref(), ADOPT_HEALTH_TIMEOUT).await {
            Ok(health) if health.process_id == Some(marker.pid) => {
                state.child_pid.store(marker.pid, Ordering::SeqCst);
                state.started_by_us.store(true, Ordering::SeqCst);
                if let Ok(mut url) = state.service_url.lock() {
                    *url = Some(marker.url.clone());
                }
                if let Ok(mut token) = state.service_token.lock() {
                    *token = config.initial_token.clone();
                }
                return Ok(true);
            }
            // URL 已被别的服务接管：放弃收养，按外部服务处理。
            Ok(_) => {
                marker::clear(app);
                clear_service_ownership(state);
                return Ok(false);
            }
            Err(failure) => last_failure = failure,
        }
        if !is_process_alive(marker.pid) {
            // 进程已退出：清掉陈旧标记，走全新启动。
            marker::clear(app);
            clear_service_ownership(state);
            return Ok(false);
        }
    }
    match last_failure {
        // 宽限后仍不可达 = 僵死进程（事件循环卡死/半初始化）。旧逻辑在这里
        // 直接报错并拒绝启动，导致端口被孤儿进程永久占用、新服务起不来；
        // 现在强杀残留进程，让启动流程照常孵化新服务。
        HealthFailure::Unreachable => {
            if state.is_starting.load(Ordering::SeqCst) {
                log::info!(
                    "retained OMPiUI service process {} at {} is still starting; leaving it alone",
                    marker.pid, marker.url
                );
                return Ok(false);
            }
            log::warn!(
                "killing retained OMPiUI service process {} at {}: health stayed unreachable",
                marker.pid, marker.url
            );
            // 优雅优先：先请求 HTTP 关闭，等进程退出，超时才强杀。
            // （保留进程的 token 应与当前配置一致 —— 都是同一个 auth-token 文件）
            let _ = request_graceful_shutdown(&marker.url, config.initial_token.as_deref()).await;
            for _ in 0..30 {
                if !is_process_alive(marker.pid) {
                    break
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if is_process_alive(marker.pid) {
                kill_process_tree(marker.pid);
            }
            marker::clear(app);
            clear_service_ownership(state);
            Ok(false)
        }
        HealthFailure::Rejected(reason) => Err(format!(
            "A retained OMPiUI service at {} rejected its health check ({reason}); check its token and environment before starting another service",
            marker.url
        )),
    }
}

enum ReuseOutcome {
    Ready(StartServiceResult),
    NeedSpawn,
    NeedWait,
}

async fn try_reuse_existing_service(
    app: &AppHandle,
    state: &ServiceState,
    config: &ServiceConfig,
) -> Result<ReuseOutcome, String> {
    if adopt_persisted_service(app, state, config).await? {
        let url = state
            .service_url
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_else(|| config.url.clone());
        return Ok(ReuseOutcome::Ready(StartServiceResult {
            started: false,
            started_by_us: true,
            url: Some(url),
            token: config.initial_token.clone(),
        }));
    }

    if state.started_by_us.load(Ordering::SeqCst) {
        let url = state
            .service_url
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_else(|| config.url.clone());
        let pid = state.child_pid.load(Ordering::SeqCst);
        // 复用前核对身份：只有端口上活着的确实是我们的子进程才复用。
        // 健康但 pid 不符 = 我们的子进程已死、端口被外部服务接管，必须
        // 走下面的外部服务分支（started_by_us=false），绝不能继续认领。
        if pid > 0 && service_matches_pid(&url, config.initial_token.as_deref(), pid).await {
            return Ok(ReuseOutcome::Ready(StartServiceResult {
                started: false,
                started_by_us: true,
                url: Some(url.clone()),
                token: config.initial_token.clone(),
            }));
        }
        if pid > 0 && is_process_alive(pid) {
            // 本次会话内启动的服务 health 还不通。如果是正在冷启动中，
            // 让调用方释放锁后等待，避免把还在孵化的进程当僵死杀掉。
            if state.is_starting.load(Ordering::SeqCst) {
                return Ok(ReuseOutcome::NeedWait);
            }
            if is_service_running(&url, config.initial_token.as_deref()).await {
                // 子进程活着但端口被别的进程服务（极端抢占）：只杀自己的
                // 子进程，绝不往别人的 URL 发关闭。
                log::warn!("OMPiUI service child {pid} is alive but {url} is served by another process; dropping ownership and killing only our child");
                stop_own_child_only(state).await;
            } else {
                log::warn!("killing hung OMPiUI service process {pid} at {url}: health unreachable");
                stop_ompiui_service_process(app, state).await;
            }
        } else {
            marker::clear(app);
            clear_service_ownership(state);
        }
    }

    if is_service_running(&config.url, config.initial_token.as_deref()).await {
        state.started_by_us.store(false, Ordering::SeqCst);
        *state
            .service_url
            .lock()
            .map_err(|error| error.to_string())? = Some(config.url.clone());
        return Ok(ReuseOutcome::Ready(StartServiceResult {
            started: false,
            started_by_us: false,
            url: Some(config.url.clone()),
            token: config.initial_token.clone(),
        }));
    }

    Ok(ReuseOutcome::NeedSpawn)
}

#[tauri::command]
pub async fn start_ompiui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let _operation = state.operations.lock().await;
    let result = start_service_locked(&app, &state, env_vars).await;
    drop(_operation);
    crate::tray::refresh_async(&app);
    result
}

async fn start_service_locked(
    app: &AppHandle,
    state: &ServiceState,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let _busy = OperationGuard::new(state);
    crate::tray::refresh_async(app);
    state.keep_on_exit.store(false, Ordering::SeqCst);
    if background::enabled()? {
        let existing = state.started_by_us.load(Ordering::SeqCst)
            .then_some(state.child_pid.load(Ordering::SeqCst)).filter(|pid| *pid > 0);
        let (pid, url, token) = background::start(env_vars, existing).await?;
        state.child_pid.store(pid, Ordering::SeqCst);
        state.started_by_us.store(true, Ordering::SeqCst);
        *state.service_url.lock().map_err(|error| error.to_string())? = Some(url.clone());
        *state.service_token.lock().map_err(|error| error.to_string())? = Some(token.clone());
        marker::persist(&app, pid, &url)?;
        return Ok(StartServiceResult { started: true, started_by_us: true, url: Some(url), token: Some(token) });
    }
    let environment = env_vars.clone();
    let result = launch_service(&app, &state, env_vars).await?;
    if state.started_by_us.load(Ordering::SeqCst) {
        background::remember_backend(environment, state.child_pid.load(Ordering::SeqCst))?;
    }
    Ok(result)
}

async fn launch_service(
    app: &AppHandle,
    state: &ServiceState,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    state.startup.begin(Phase::Preparing);
    let result = async {
        let config = ServiceConfig::new(env_vars);
        let prepared = prepare_server_async(app).await?;
        let mut lifecycle = Some(state.lifecycle.lock().await);
        state.startup.phase(Phase::Checking);
        loop {
            match try_reuse_existing_service(app, state, &config).await? {
                ReuseOutcome::Ready(result) => return Ok(result),
                ReuseOutcome::NeedSpawn => {
                    state.is_starting.store(true, Ordering::SeqCst);
                    break;
                }
                ReuseOutcome::NeedWait => {
                    drop(lifecycle.take().unwrap());
                    wait_for_start_to_complete(state).await;
                    lifecycle = Some(state.lifecycle.lock().await);
                }
            }
        }
        state.startup.phase(Phase::Starting);
        start_service_after_prepare(app, state, &config, prepared, lifecycle.take().unwrap()).await
    }.await;
    // 包括创建进程失败在内的所有返回路径都解除启动状态，允许重试。
    state.is_starting.store(false, Ordering::SeqCst);
    state.startup.finish(result.as_ref().map(|_| ()).map_err(String::as_str), Phase::Running);
    result
}

/// 在已持有 lifecycle 锁的情况下孵化子进程、写入状态、持久化 marker，
/// 然后释放锁并等待 health 通过。health 等待期间其他命令可以并行执行，
/// 这样刷新页面触发的第二次 start 不会阻塞 60 秒，也不会把还在冷启动的
/// 进程误判成僵死杀掉。
async fn start_service_after_prepare(
    app: &AppHandle,
    state: &ServiceState,
    config: &ServiceConfig,
    prepared: process::PreparedServer,
    lifecycle_guard: tokio::sync::MutexGuard<'_, ()>,
) -> Result<StartServiceResult, String> {
    if let Ok(mut output) = state.output.lock() {
        output.clear();
    }
    let spawned = spawn_server(prepared, state.output.clone(), &config.environment)?;
    let pid = spawned.id();
    state.startup.spawned(pid);

    {
        let mut child = state.child.lock().map_err(|error| error.to_string())?;
        *child = Some(spawned);
    }
    state.child_pid.store(pid, Ordering::SeqCst);
    state.started_by_us.store(true, Ordering::SeqCst);
    *state
        .service_url
        .lock()
        .map_err(|error| error.to_string())? = Some(config.url.clone());
    *state
        .service_token
        .lock()
        .map_err(|error| error.to_string())? = config.initial_token.clone();
    if let Err(error) = marker::persist(app, pid, &config.url) {
        stop_ompiui_service_process(app, state).await;
        state.is_starting.store(false, Ordering::SeqCst);
        return Err(format!("failed to persist OMPiUI service ownership: {error}"));
    }

    // 状态已经写入，可以释放锁让其他命令并行执行。
    drop(lifecycle_guard);

    let mut error_message = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline {
        let exited = {
            let mut child = state.child.lock().map_err(|error| error.to_string())?;
            child
                .as_mut()
                .map(|process| process.try_wait())
                .transpose()
                .map_err(|error| error.to_string())?
                .flatten()
        };
        if let Some(status) = exited {
            error_message = Some(format!(
                "OMPiUI server exited during startup with status {status}.{}",
                recent_output(state)
            ));
            break;
        }

        let current_token = config.token();
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match service_health_with_timeout(&config.url, current_token.as_deref(), remaining.min(Duration::from_secs(5))).await {
            Ok(health) if health.process_id == Some(pid) => {
                // 身份确认：端口上活着的确实是刚 spawn 的进程。
                let _lifecycle = state.lifecycle.lock().await;
                state.is_starting.store(false, Ordering::SeqCst);
                return Ok(StartServiceResult {
                    started: true,
                    started_by_us: true,
                    url: Some(config.url.clone()),
                    token: current_token,
                });
            }
            Ok(health) => {
                // 端口健康但进程不是我们的：外部/手动启动的 server 占着端口。
                // 绝不认领——认领意味着退出时会按 URL 把它误杀。
                error_message = Some(format!(
                    "Port for the OMPiUI service is already served by another process (pid {:?}); not claiming it. Start the app after stopping that service, or change the port.",
                    health.process_id
                ));
                break;
            }
            Err(_) => {
                // 还没起来（冷启动中），继续等。
            }
        }
        tokio::time::sleep(Duration::from_millis(500).min(deadline.saturating_duration_since(tokio::time::Instant::now()))).await;
    }

    // 启动失败：重新持锁做最终清理。
    let _lifecycle = state.lifecycle.lock().await;
    state.is_starting.store(false, Ordering::SeqCst);
    stop_ompiui_service_process(app, state).await;
    Err(error_message.unwrap_or_else(|| format!(
        "OMPiUI server started but health check did not pass.{}",
        recent_output(state)
    )))
}

/// 优雅停止托管的服务进程：先请求 HTTP 优雅关闭并等进程退出，
/// 超时（进程仍活着）才退回 taskkill /F 强杀兜底。
async fn stop_ompiui_service_process(app: &AppHandle, state: &ServiceState) {
    let pid = state.child_pid.swap(0, Ordering::SeqCst);
    state.started_by_us.store(false, Ordering::SeqCst);
    marker::clear(app);
    let url = state
        .service_url
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    let token = state
        .service_token
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    if pid > 0 {
        if let Some(url) = url {
            // 发 HTTP 关闭前核对身份：URL 上活着的必须是我们的 pid。
            // 子进程已死、端口被外部/手动启动的服务接管时，往 URL 发关闭
            // 会误杀别人的服务（appdata 日志里手动 server 被桌面壳杀掉
            // 就是走了这条路）。
            if service_matches_pid(&url, token.as_deref(), pid).await {
                // 1. 先触发服务端优雅关闭（关监听、排空连接、dispose worker）
                let _ = request_graceful_shutdown(&url, token.as_deref()).await;
                // 2. 用持有的 Child 句柄 try_wait 判断退出（零子进程开销，不用
                //    tasklist 轮询——每次 ~130ms 的进程创建）。等待必须覆盖
                //    server 的 shutdown deadline（默认 10s），否则繁忙会话的
                //    优雅关闭每次都以强杀收场 → 会话锁残留、session 文件写坏。
                for _ in 0..60 {
                    let exited = state
                        .child
                        .lock()
                        .ok()
                        .and_then(|mut child| child.as_mut().and_then(|process| process.try_wait().ok()).flatten())
                        .is_some();
                    if exited {
                        break
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
        // 3. 兜底：优雅关闭失败/超时才强杀进程树（只杀我们自己的 pid）
        if is_process_alive(pid) {
            log::warn!("graceful shutdown of OMPiUI service {pid} did not complete; force killing");
            kill_process_tree(pid);
        }
    }
    if let Ok(mut child) = state.child.lock() {
        if let Some(process) = child.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        *child = None;
    }
}

fn clear_service_ownership(state: &ServiceState) {
    state.child_pid.store(0, Ordering::SeqCst);
    state.started_by_us.store(false, Ordering::SeqCst);
    if let Ok(mut url) = state.service_url.lock() {
        *url = None;
    }
    if let Ok(mut token) = state.service_token.lock() {
        *token = None;
    }
    if let Ok(mut child) = state.child.lock() {
        let exited = child
            .as_mut()
            .and_then(|process| process.try_wait().ok())
            .flatten()
            .is_some();
        if exited {
            *child = None;
        }
    }
}

#[tauri::command]
pub async fn stop_ompiui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<(), String> {
    let _operation = state.operations.lock().await;
    let result = stop_service_locked(&app, &state).await;
    drop(_operation);
    crate::tray::refresh_async(&app);
    result
}

async fn stop_service_locked(app: &AppHandle, state: &ServiceState) -> Result<(), String> {
    let _busy = OperationGuard::new(state);
    crate::tray::refresh_async(app);
    // 冷启动托盘可能只读发现了留驻进程，明确 Stop 时才收养已核验身份。
    if !state.started_by_us.load(Ordering::SeqCst) {
        let environment = crate::tray::environment(app)?;
        let snapshot = tray_snapshot(app, state, &environment).await?;
        adopt_tray_snapshot(state, snapshot)?;
    }
    // 先落盘 stop intent，再关进程，避免 crash recovery 将主动停止当作崩溃。
    background::stop().await?;
    state.startup.begin(Phase::Stopping);
    let mut lifecycle = Some(state.lifecycle.lock().await);
    loop {
        if state.is_starting.load(Ordering::SeqCst) {
            drop(lifecycle.take().unwrap());
            wait_for_start_to_complete(&state).await;
            lifecycle = Some(state.lifecycle.lock().await);
            continue;
        }
        stop_ompiui_service_process(&app, &state).await;
        state.startup.finish(Ok(()), Phase::Stopped);
        return Ok(());
    }
}

#[tauri::command]
pub async fn restart_ompiui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let _operation = state.operations.lock().await;
    let result = async {
        stop_service_locked(&app, &state).await?;
        start_service_locked(&app, &state, env_vars).await
    }.await;
    drop(_operation);
    crate::tray::refresh_async(&app);
    result
}

#[tauri::command]
pub async fn get_ompiui_service_status(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<ServiceStatusResult, String> {
    let _operation = state.operations.lock().await;
    if background::enabled()? {
        if let Some((pid, url, token)) = background::connection().await? {
            if state.child_pid.load(Ordering::SeqCst) != pid {
                marker::persist(&app, pid, &url)?;
            }
            state.child_pid.store(pid, Ordering::SeqCst);
            state.started_by_us.store(true, Ordering::SeqCst);
            *state.service_url.lock().map_err(|error| error.to_string())? = Some(url);
            *state.service_token.lock().map_err(|error| error.to_string())? = Some(token);
        }
    }
    let mut lifecycle = Some(state.lifecycle.lock().await);
    let config;
    loop {
        if state.is_starting.load(Ordering::SeqCst) {
            drop(lifecycle.take().unwrap());
            wait_for_start_to_complete(&state).await;
            lifecycle = Some(state.lifecycle.lock().await);
            continue;
        }
        config = ServiceConfig::new(env_vars.clone());
        let _ = adopt_persisted_service(&app, &state, &config).await;
        break;
    }
    let url = state
        .service_url
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .unwrap_or_else(|| config.url.clone());
    let token = state.service_token.lock().map_err(|error| error.to_string())?.clone().or(config.initial_token);
    let health = service_health(&url, token.as_deref())
        .await
        .ok();
    let running = health.is_some();
    let pid = health
        .as_ref()
        .and_then(|health| health.process_id)
        .or_else(|| {
            let pid = state.child_pid.load(Ordering::SeqCst);
            (pid > 0).then_some(pid)
        });
    let resource = resource_root(&app)?;
    let native_modules = resource.join("node_modules");
    Ok(ServiceStatusResult {
        running,
        started_by_us: running && state.started_by_us.load(Ordering::SeqCst),
        pid,
        url: running.then_some(url),
        environment: service_environment(Some(&native_modules), &config.environment),
    })
}

#[tauri::command]
pub async fn confirm_close_app(
    window: tauri::Window,
    state: State<'_, ServiceState>,
    stop_service: bool,
    exit_app: Option<bool>,
) -> Result<(), String> {
    let _operation = state.operations.lock().await;
    if stop_service {
        stop_service_locked(window.app_handle(), &state).await?;
    }
    let close_to_tray = crate::tray::close_to_tray(window.app_handle());
    match crate::tray::confirmed_close_action(close_to_tray, stop_service, exit_app.unwrap_or(false)) {
        crate::tray::CloseAction::Hide => crate::tray::hide_window(&window),
        crate::tray::CloseAction::Exit => {
            state.keep_on_exit.store(!stop_service, Ordering::SeqCst);
            window.app_handle().exit(0);
            Ok(())
        }
        crate::tray::CloseAction::Destroy => {
            state.keep_on_exit.store(!stop_service, Ordering::SeqCst);
            // 隐藏窗口不应阻挡最后一个可见窗口的退出。
            if crate::tray::is_last_visible_window(&window) {
                window.app_handle().exit(0);
                Ok(())
            } else {
                window.destroy().map_err(|error| error.to_string())
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TrayServiceStatus {
    Stopped,
    Running,
    External,
    Busy,
    Unavailable,
}

struct TraySnapshot {
    status: TrayServiceStatus,
    connection: Option<(u32, String, Option<String>)>,
}

// 只读探测，不调用 adopt_persisted_service（它会清理/杀掉不健康进程）。
async fn tray_snapshot(
    app: &AppHandle,
    state: &ServiceState,
    env_vars: &BTreeMap<String, String>,
) -> Result<TraySnapshot, String> {
    let (recorded_environment, recorded_pid) = background::backend_snapshot()?;
    let marker = marker::read(app)?;
    let state_pid = state.child_pid.load(Ordering::SeqCst);
    let owned_pid = recorded_pid
        .or_else(|| state.started_by_us.load(Ordering::SeqCst).then_some(state_pid).filter(|pid| *pid > 0))
        .or_else(|| marker.as_ref().map(|marker| marker.pid));
    let config = ServiceConfig::new(if recorded_pid.is_some() { recorded_environment } else { env_vars.clone() });
    let url = if recorded_pid.is_some() {
        config.url.clone()
    } else {
        state.service_url.lock().map_err(|error| error.to_string())?.clone()
            .or_else(|| marker.as_ref().map(|marker| marker.url.clone()))
            .unwrap_or(config.url)
    };
    let token = if recorded_pid.is_some() {
        config.initial_token
    } else {
        state.service_token.lock().map_err(|error| error.to_string())?.clone().or(config.initial_token)
    };
    let health = service_health_with_timeout(&url, token.as_deref(), Duration::from_secs(2)).await;
    let status = classify_tray_health(health, owned_pid, is_process_alive);
    let connection = if status == TrayServiceStatus::Running {
        owned_pid.map(|pid| (pid, url, token))
    } else { None };
    Ok(TraySnapshot { status, connection })
}

fn classify_tray_health(
    health: Result<HealthResponse, HealthFailure>,
    owned_pid: Option<u32>,
    is_alive: impl FnOnce(u32) -> bool,
) -> TrayServiceStatus {
    match health {
        Ok(health) if owned_pid.is_some() && health.process_id == owned_pid => TrayServiceStatus::Running,
        Ok(_) => TrayServiceStatus::External,
        Err(HealthFailure::Rejected(_)) => TrayServiceStatus::Unavailable,
        Err(HealthFailure::Unreachable) => {
            if owned_pid.is_some_and(is_alive) { TrayServiceStatus::Busy } else { TrayServiceStatus::Stopped }
        }
    }
}

fn adopt_tray_snapshot(state: &ServiceState, snapshot: TraySnapshot) -> Result<(), String> {
    if let Some((pid, url, token)) = snapshot.connection {
        state.child_pid.store(pid, Ordering::SeqCst);
        state.started_by_us.store(true, Ordering::SeqCst);
        *state.service_url.lock().map_err(|error| error.to_string())? = Some(url);
        *state.service_token.lock().map_err(|error| error.to_string())? = token;
    }
    Ok(())
}

pub(crate) fn tray_owned_process_alive(app: &AppHandle) -> bool {
    let state = app.state::<ServiceState>();
    let pid = background::backend_snapshot().ok().and_then(|(_, pid)| pid)
        .or_else(|| state.started_by_us.load(Ordering::SeqCst)
            .then_some(state.child_pid.load(Ordering::SeqCst)).filter(|pid| *pid > 0))
        .or_else(|| marker::read(app).ok().flatten().map(|marker| marker.pid));
    pid.is_some_and(is_process_alive)
}

pub(crate) fn tray_lifecycle_busy(app: &AppHandle) -> bool {
    app.state::<ServiceState>().is_operating.load(Ordering::SeqCst)
}

pub(crate) async fn tray_service_status(app: &AppHandle, env_vars: &BTreeMap<String, String>) -> Result<TrayServiceStatus, String> {
    let state = app.state::<ServiceState>();
    let Ok(_operation) = state.operations.try_lock() else { return Ok(TrayServiceStatus::Busy); };
    Ok(tray_snapshot(app, &state, env_vars).await?.status)
}

pub(crate) async fn tray_start_service(app: &AppHandle, env_vars: BTreeMap<String, String>) -> Result<StartServiceResult, String> {
    let state = app.state::<ServiceState>();
    let _operation = state.operations.lock().await;
    let snapshot = tray_snapshot(app, &state, &env_vars).await?;
    match snapshot.status {
        TrayServiceStatus::External => return Err("An external backend is running; the tray cannot control it".to_string()),
        TrayServiceStatus::Unavailable => return Err("Backend identity could not be verified".to_string()),
        TrayServiceStatus::Busy => return Err("Backend is busy".to_string()),
        _ => {}
    }
    adopt_tray_snapshot(&state, snapshot)?;
    start_service_locked(app, &state, env_vars).await
}

pub(crate) async fn tray_stop_service(app: &AppHandle, env_vars: &BTreeMap<String, String>) -> Result<(), String> {
    let state = app.state::<ServiceState>();
    let _operation = state.operations.lock().await;
    let snapshot = tray_snapshot(app, &state, env_vars).await?;
    if snapshot.status != TrayServiceStatus::Running {
        return Err("No verified application-owned backend is running".to_string());
    }
    adopt_tray_snapshot(&state, snapshot)?;
    stop_service_locked(app, &state).await
}

pub(crate) fn tray_environment() -> Result<BTreeMap<String, String>, String> {
    background::backend_snapshot().map(|(environment, _)| environment)
}

#[tauri::command]
pub async fn get_ompiui_background_status(
    env_vars: BTreeMap<String, String>,
) -> Result<background::BackgroundStatus, String> {
    let _ = env_vars;
    background::status().await
}

#[tauri::command]
pub async fn set_ompiui_background_settings(
    state: State<'_, ServiceState>,
    login_start: bool,
    crash_recovery: bool,
    env_vars: BTreeMap<String, String>,
) -> Result<background::BackgroundStatus, String> {
    let _operation = state.operations.lock().await;
    let _busy = OperationGuard::new(&state);
    let existing = state.started_by_us.load(Ordering::SeqCst)
        .then_some(state.child_pid.load(Ordering::SeqCst)).filter(|pid| *pid > 0);
    background::settings(login_start, crash_recovery, env_vars, existing).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_config_uses_connectable_url_and_explicit_token() {
        let config = ServiceConfig::new(BTreeMap::from([
            ("OMPIUI_HOST".to_string(), "0.0.0.0".to_string()),
            ("OMPIUI_PORT".to_string(), "9123".to_string()),
            ("OMPIUI_AUTH_TOKEN".to_string(), "test-token".to_string()),
        ]));

        assert_eq!(config.url, "http://127.0.0.1:9123");
        assert_eq!(config.initial_token.as_deref(), Some("test-token"));
    }

    #[test]
    fn custom_environment_overrides_built_in_service_values() {
        let environment = service_environment(
            None,
            &BTreeMap::from([
                ("OMPIUI_PORT".to_string(), "9000".to_string()),
                ("OMPI_OMP_BIN".to_string(), "/opt/omp/bin/omp".to_string()),
            ]),
        );

        assert_eq!(
            environment.get("OMPIUI_HOST").map(String::as_str),
            Some("127.0.0.1")
        );
        assert_eq!(
            environment.get("OMPIUI_PORT").map(String::as_str),
            Some("9000")
        );
        assert_eq!(
            environment.get("OMPIUI_DRIVER").map(String::as_str),
            Some("omp")
        );
        assert_eq!(
            environment.get("OMPI_OMP_BIN").map(String::as_str),
            Some("/opt/omp/bin/omp")
        );
    }

    #[test]
    fn tray_classifies_only_verified_pid_as_application_owned() {
        let health = |pid| Ok(HealthResponse { process_id: pid, worker_ready: Some(true), started_at: None });
        assert_eq!(classify_tray_health(health(Some(42)), Some(42), |_| true), TrayServiceStatus::Running);
        assert_eq!(classify_tray_health(health(Some(43)), Some(42), |_| true), TrayServiceStatus::External);
        assert_eq!(classify_tray_health(health(Some(42)), None, |_| true), TrayServiceStatus::External);
        assert_eq!(classify_tray_health(Err(HealthFailure::Unreachable), Some(42), |_| false), TrayServiceStatus::Stopped);
        assert_eq!(classify_tray_health(Err(HealthFailure::Unreachable), Some(42), |_| true), TrayServiceStatus::Busy);
        assert_eq!(classify_tray_health(Err(HealthFailure::Rejected("401".to_string())), Some(42), |_| true), TrayServiceStatus::Unavailable);
    }

    #[test]
    fn read_only_poll_does_not_require_close_confirmation_but_lifecycle_does() {
        let state = ServiceState::default();
        let _read = state.operations.try_lock().unwrap();
        assert!(!state.should_confirm_close());
        let operation = OperationGuard::new(&state);
        assert!(state.should_confirm_close());
        drop(operation);
        assert!(!state.should_confirm_close());
        state.started_by_us.store(true, Ordering::SeqCst);
        state.child_pid.store(std::process::id(), Ordering::SeqCst);
        assert!(state.should_confirm_close());
        state.child_pid.store(0, Ordering::SeqCst);
        assert!(!state.should_confirm_close(), "stale ownership without a live backend must not prompt");
    }

    #[test]
    fn tray_health_probe_is_authenticated_read_only_loopback_get() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /api/v1/host/health HTTP/1.1\r\n"));
            assert!(request.to_lowercase().contains("authorization: bearer tray-test-token\r\n"));
            let body = format!("{{\"processId\":{},\"workerReady\":true}}", std::process::id());
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let health = tauri::async_runtime::block_on(service_health_with_timeout(&format!("http://{address}"), Some("tray-test-token"), Duration::from_secs(2)));
        assert_eq!(classify_tray_health(health, Some(std::process::id()), is_process_alive), TrayServiceStatus::Running);
        server.join().unwrap();
    }

    #[test]
    fn tray_started_event_preserves_full_native_connection_contract() {
        let result = StartServiceResult { started: true, started_by_us: true, url: Some("http://127.0.0.1:8815".to_string()), token: Some("tray-test-token".to_string()) };
        assert_eq!(serde_json::to_value(result).unwrap(), serde_json::json!({ "started": true, "startedByUs": true, "url": "http://127.0.0.1:8815", "token": "tray-test-token" }));
    }

    #[test]
    fn process_liveness_distinguishes_current_and_missing_processes() {
        let started = std::time::Instant::now();
        assert!(is_process_alive(std::process::id()));
        // 使用确实退出的子进程，避免随意选 PID 或启动交互式 cmd。
        let mut command = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" });
        if cfg!(windows) {
            command.args(["/C", "exit", "0"]);
        }
        let mut child = command.spawn().expect("spawn helper should succeed");
        let dead_pid = child.id();
        let _ = child.wait();
        assert!(!is_process_alive(dead_pid));
        assert!(started.elapsed() < Duration::from_secs(2), "PID checks must not wait for tasklist");
    }
}
