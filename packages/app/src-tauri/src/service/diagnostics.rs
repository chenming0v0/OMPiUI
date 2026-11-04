use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

use super::{service_health_with_timeout, HealthFailure, ServiceConfig, ServiceState};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Phase {
    #[default]
    Idle,
    Preparing,
    Checking,
    Starting,
    WaitingHealth,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl Phase {
    pub(super) fn busy(self) -> bool {
        matches!(
            self,
            Self::Preparing
                | Self::Checking
                | Self::Starting
                | Self::WaitingHealth
                | Self::Stopping
        )
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartupEvent {
    time: u64,
    phase: Phase,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiagnostics {
    pub(super) revision: u64,
    pub(super) phase: Phase,
    requested_at: Option<u64>,
    spawned_at: Option<u64>,
    completed_at: Option<u64>,
    pub(super) pid: Option<u32>,
    error: Option<String>,
    events: Vec<StartupEvent>,
    reachable: Option<bool>,
    worker_ready: Option<bool>,
    omp_version: Option<String>,
    health_error: Option<String>,
    output: Vec<String>,
}

impl ServiceDiagnostics {
    fn apply_health(&mut self, health: super::HealthResponse) {
        self.reachable = Some(true);
        self.worker_ready = health.worker_ready;
        self.omp_version = health.omp_version;
        self.pid = health.process_id;
        if health.started_at.is_some() {
            self.spawned_at = health.started_at;
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Default)]
pub(super) struct StartupDiagnostics(Mutex<ServiceDiagnostics>);

impl StartupDiagnostics {
    pub(super) fn snapshot(&self) -> ServiceDiagnostics {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub(super) fn begin(&self, phase: Phase) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let revision = state.revision + 1;
        *state = ServiceDiagnostics {
            revision,
            requested_at: Some(now()),
            ..Default::default()
        };
        Self::record(&mut state, phase);
    }

    fn record(state: &mut ServiceDiagnostics, phase: Phase) {
        state.phase = phase;
        state.revision += 1;
        state.events.push(StartupEvent { time: now(), phase });
        log::info!("desktop service phase={phase:?} pid={:?}", state.pid);
    }

    pub(super) fn phase(&self, phase: Phase) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        Self::record(&mut state, phase);
    }

    pub(super) fn spawned(&self, pid: u32) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.pid = Some(pid);
        state.spawned_at = Some(now());
        Self::record(&mut state, Phase::WaitingHealth);
    }

    pub(super) fn finish(&self, result: Result<(), &str>, success: Phase) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.completed_at = Some(now());
        state.error = result.err().map(str::to_owned);
        Self::record(
            &mut state,
            if result.is_ok() {
                success
            } else {
                Phase::Failed
            },
        );
    }
}

// 独立于生命周期锁：启动卡住、失败或尚未创建后端时仍可查看。
// 只读健康状态，不收养、清理进程，也不孵化任何会话运行时。
#[tauri::command]
pub async fn get_ompiui_service_diagnostics(
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<ServiceDiagnostics, String> {
    read_diagnostics(&state, env_vars).await
}

async fn read_diagnostics(
    state: &ServiceState,
    env_vars: BTreeMap<String, String>,
) -> Result<ServiceDiagnostics, String> {
    let mut snapshot = state.startup.snapshot();
    if !snapshot.phase.busy() {
        let config = ServiceConfig::new(env_vars);
        let (url, token) = state.connection_snapshot()?.unwrap_or((config.url, config.initial_token));
        match service_health_with_timeout(
            &url,
            token.as_deref(),
            Duration::from_secs(2),
        )
        .await
        {
            Ok(health) => snapshot.apply_health(health),
            Err(failure) => {
                snapshot.reachable = Some(false);
                snapshot.health_error = Some(match failure {
                    HealthFailure::Unreachable => "unreachable".to_owned(),
                    HealthFailure::Rejected(_) => "rejected".to_owned(),
                });
            }
        }
        let latest = state.startup.snapshot();
        if latest.revision != snapshot.revision {
            snapshot = latest;
        }
    }
    snapshot.output = state
        .output
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .cloned()
        .collect();
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_omp_version_is_forwarded_independently_of_worker_ready() {
        for version in [serde_json::json!("14.0.0"), serde_json::Value::Null] {
            let health = serde_json::from_value(serde_json::json!({
                "processId": 42, "workerReady": true, "ompVersion": version, "startedAt": 1234
            })).unwrap();
            let mut diagnostics = ServiceDiagnostics::default();
            diagnostics.apply_health(health);
            let value = serde_json::to_value(diagnostics).unwrap();
            assert_eq!(value["ompVersion"], version);
            assert_eq!(value["workerReady"], true);
            assert_eq!(value["spawnedAt"], 1234);
        }
        let health = serde_json::from_value(serde_json::json!({"workerReady": true})).unwrap();
        let mut diagnostics = ServiceDiagnostics::default();
        diagnostics.apply_health(health);
        assert!(serde_json::to_value(diagnostics).unwrap()["ompVersion"].is_null());
        assert!(serde_json::to_value(ServiceDiagnostics::default()).unwrap()["ompVersion"].is_null());
    }

    #[test]
    fn failed_launch_is_visible_before_a_process_exists_and_retry_clears_it() {
        let diagnostics = StartupDiagnostics::default();
        diagnostics.begin(Phase::Preparing);
        diagnostics.finish(Err("missing binary"), Phase::Running);
        let failed = diagnostics.snapshot();
        assert_eq!(failed.phase, Phase::Failed);
        assert_eq!(failed.error.as_deref(), Some("missing binary"));
        assert!(failed.spawned_at.is_none());
        assert!(failed.completed_at.is_some());
        diagnostics.begin(Phase::Preparing);
        diagnostics.spawned(42);
        diagnostics.finish(Ok(()), Phase::Running);
        let running = diagnostics.snapshot();
        assert!(running.error.is_none());
        assert_eq!(running.pid, Some(42));
        assert!(running.spawned_at >= running.requested_at);
        assert!(running.completed_at >= running.spawned_at);
        assert_eq!(running.events.len(), 3);
    }

    #[test]
    fn startup_snapshot_does_not_wait_for_lifecycle_or_query_the_backend() {
        let state = ServiceState::default();
        state.startup.begin(Phase::Checking);
        let _lifecycle = state.lifecycle.try_lock().unwrap();
        let _operation = state.operations.try_lock().unwrap();
        let started = std::time::Instant::now();
        let snapshot =
            tauri::async_runtime::block_on(read_diagnostics(&state, BTreeMap::new())).unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(snapshot.phase, Phase::Checking);
        assert!(snapshot.reachable.is_none());
        assert!(snapshot.worker_ready.is_none());
        assert!(state.child.lock().unwrap().is_none());
    }
}
