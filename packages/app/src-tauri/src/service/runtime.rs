use std::{collections::BTreeMap, env, net::IpAddr, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{process, ServiceState};

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OmpRuntimeSource {
    Environment,
    Bundled,
    Path,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OmpRuntimeCandidate {
    path: String,
    source: OmpRuntimeSource,
    version: Option<String>,
    command: String,
    args: Vec<String>,
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_root: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OmpRuntimeInspection {
    selected: Option<OmpRuntimeCandidate>,
    candidates: Vec<OmpRuntimeCandidate>,
    bundled: bool,
    error: Option<String>,
    configured_bin: Option<String>,
    configured_runtime_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpRuntimeCatalog {
    available: OmpRuntimeInspection,
    current: Option<OmpRuntimeInspection>,
    current_error: Option<String>,
}

impl OmpRuntimeInspection {
    fn unavailable(environment: &BTreeMap<String, String>, error: String) -> Self {
        let configured = |key| {
            environment
                .get(key)
                .cloned()
                .or_else(|| env::var(key).ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Self {
            selected: None,
            candidates: Vec::new(),
            bundled: false,
            error: Some(error),
            configured_bin: configured("OMPI_OMP_BIN"),
            configured_runtime_dir: configured("OMPI_OMP_RUNTIME_DIR"),
        }
    }
}

fn available_runtime(
    resource: Result<PathBuf, String>,
    custom_environment: &BTreeMap<String, String>,
) -> OmpRuntimeInspection {
    let native_modules = resource.as_ref().ok().map(|path| path.join("node_modules"));
    let environment = process::service_environment(native_modules.as_deref(), custom_environment);
    let result = resource
        .and_then(process::prepare_backend)
        .and_then(|prepared| process::inspect_runtime(prepared, custom_environment))
        .and_then(|output| {
            serde_json::from_slice(&output)
                .map_err(|error| format!("invalid OMPiUI runtime inspection JSON: {error}"))
        });
    result.unwrap_or_else(|error| OmpRuntimeInspection::unavailable(&environment, error))
}

fn current_request(url: &str, token: Option<&str>) -> Result<reqwest::Request, String> {
    let mut url = reqwest::Url::parse(url)
        .map_err(|error| format!("invalid current backend URL: {error}"))?;
    let local = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !local || !matches!(url.scheme(), "http" | "https") {
        return Err("current runtime inspection requires a connected local backend".to_string());
    }
    url.set_path("/api/v1/host/omp-runtime");
    url.set_query(None);
    url.set_fragment(None);
    let mut request = reqwest::Request::new(reqwest::Method::GET, url);
    *request.timeout_mut() = Some(Duration::from_secs(12));
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        let mut header = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "invalid current backend token".to_string())?;
        header.set_sensitive(true);
        request
            .headers_mut()
            .insert(reqwest::header::AUTHORIZATION, header);
    }
    Ok(request)
}

async fn current_runtime(state: &ServiceState) -> Result<Option<OmpRuntimeInspection>, String> {
    // 只使用已连接服务保存的连接信息；编辑中的 envVars 不参与这里的 URL/token。
    let Some((url, token)) = state.connection_snapshot()? else {
        return Ok(None);
    };
    let request = current_request(&url, token.as_deref())?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("failed to query current OMP runtime: {error}"))?;
    let response = client
        .execute(request)
        .await
        .map_err(|error| format!("failed to query current OMP runtime: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "current OMP runtime query returned {}",
            response.status()
        ));
    }
    response
        .json()
        .await
        .map(Some)
        .map_err(|error| format!("invalid current OMP runtime inspection JSON: {error}"))
}

fn catalog(
    available: OmpRuntimeInspection,
    current: Result<Option<OmpRuntimeInspection>, String>,
) -> OmpRuntimeCatalog {
    match current {
        Ok(current) => OmpRuntimeCatalog {
            available,
            current,
            current_error: None,
        },
        Err(error) => OmpRuntimeCatalog {
            available,
            current: None,
            current_error: Some(error),
        },
    }
}

// 只运行自带 backend 的 inspection 子命令及只读 GET，不调用任何服务生命周期操作。
#[tauri::command]
pub async fn get_ompiui_runtime_catalog(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<OmpRuntimeCatalog, String> {
    let resource = process::resource_root(&app);
    let fallback_environment = env_vars.clone();
    let inspection =
        tauri::async_runtime::spawn_blocking(move || available_runtime(resource, &env_vars));
    let current = current_runtime(&state).await;
    let available = inspection.await.unwrap_or_else(|error| {
        OmpRuntimeInspection::unavailable(
            &fallback_environment,
            format!("runtime inspection task failed: {error}"),
        )
    });
    Ok(catalog(available, current))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspection() -> OmpRuntimeInspection {
        serde_json::from_value(serde_json::json!({
            "selected": {
                "path": "C:/omp/bin/omp.exe", "source": "bundled", "version": "14.0.0",
                "command": "C:/omp/bin/omp.exe", "args": [], "error": null,
                "runtimeRoot": "C:/omp"
            },
            "candidates": [{
                "path": "omp", "source": "path", "version": null,
                "command": "omp", "args": ["--rpc"], "error": "not installed"
            }],
            "bundled": true, "error": null, "configuredBin": null, "configuredRuntimeDir": null
        }))
        .unwrap()
    }

    #[test]
    fn inspection_contract_preserves_versions_errors_and_runtime_root() {
        let available = inspection();
        let value = serde_json::to_value(&available).unwrap();
        assert_eq!(value["selected"]["source"], "bundled");
        assert_eq!(value["selected"]["runtimeRoot"], "C:/omp");
        assert_eq!(value["selected"]["version"], "14.0.0");
        assert!(value["candidates"][0]["version"].is_null());
        assert_eq!(value["candidates"][0]["args"], serde_json::json!(["--rpc"]));
        assert_eq!(
            serde_json::from_value::<OmpRuntimeInspection>(value).unwrap(),
            available
        );
    }

    #[test]
    fn unavailable_backend_preserves_config_without_requiring_omp_or_pty() {
        let env = BTreeMap::from([
            (
                "OMPI_OMP_BIN".to_string(),
                " C:/missing/omp.exe ".to_string(),
            ),
            (
                "OMPI_OMP_RUNTIME_DIR".to_string(),
                "C:/missing/runtime".to_string(),
            ),
        ]);
        // 路径解析失败时仍返回结构化结果，不执行外部 OMP 或启动任何进程。
        let available = available_runtime(Err("backend resource unavailable".to_string()), &env);
        assert!(available.selected.is_none());
        assert!(available.candidates.is_empty());
        assert_eq!(
            available.configured_bin.as_deref(),
            Some("C:/missing/omp.exe")
        );
        assert_eq!(
            available.configured_runtime_dir.as_deref(),
            Some("C:/missing/runtime")
        );
        assert_eq!(
            available.error.as_deref(),
            Some("backend resource unavailable")
        );
    }

    #[test]
    fn current_failure_does_not_discard_available_inspection() {
        let available = inspection();
        let result = catalog(inspection(), Err("current returned 404".to_string()));
        assert_eq!(result.available, available);
        assert!(result.current.is_none());
        assert_eq!(
            result.current_error.as_deref(),
            Some("current returned 404")
        );
        let value = serde_json::to_value(result).unwrap();
        assert!(value["current"].is_null());
        assert_eq!(value["currentError"], "current returned 404");
    }

    #[test]
    fn current_request_uses_saved_connection_not_edited_environment() {
        let state = ServiceState::default();
        *state.service_url.lock().unwrap() = Some("http://127.0.0.1:9123".to_string());
        *state.service_token.lock().unwrap() = Some("connected-token".to_string());
        let edited_environment = BTreeMap::from([
            ("OMPIUI_PORT".to_string(), "9999".to_string()),
            ("OMPIUI_AUTH_TOKEN".to_string(), "edited-token".to_string()),
        ]);
        let _operation = state.operations.try_lock().unwrap();
        let _lifecycle = state.lifecycle.try_lock().unwrap();
        let (url, token) = state.connection_snapshot().unwrap().unwrap();
        let request = current_request(&url, token.as_deref()).unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(
            request.url().as_str(),
            "http://127.0.0.1:9123/api/v1/host/omp-runtime"
        );
        assert_eq!(
            request.headers()[reqwest::header::AUTHORIZATION],
            "Bearer connected-token"
        );
        assert_eq!(request.timeout(), Some(&Duration::from_secs(12)));
        assert_ne!(
            request.url().port(),
            edited_environment["OMPIUI_PORT"].parse().ok()
        );
        assert!(!state
            .started_by_us
            .load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.child.lock().unwrap().is_none());
        assert!(!state.is_operating.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn disconnected_current_is_null_without_reading_config_or_mutating_state() {
        let state = ServiceState::default();
        let _operation = state.operations.try_lock().unwrap();
        let _lifecycle = state.lifecycle.try_lock().unwrap();
        let current = tauri::async_runtime::block_on(current_runtime(&state)).unwrap();
        assert!(current.is_none());
        let result = catalog(inspection(), Ok(current));
        assert!(result.current_error.is_none());
        assert!(state.service_url.lock().unwrap().is_none());
        assert!(state.child.lock().unwrap().is_none());
    }

    #[test]
    fn current_query_rejects_remote_urls_and_accepts_loopback_ipv6() {
        assert!(current_request("https://example.com:8787", Some("token")).is_err());
        assert!(current_request("file:///tmp/runtime", None).is_err());
        assert!(current_request("http://localhost:8787", None).is_ok());
        assert!(current_request("http://[::1]:8787", None).is_ok());
    }
}
