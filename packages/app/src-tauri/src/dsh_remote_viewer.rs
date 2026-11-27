use std::{
    borrow::Cow,
    collections::HashMap,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use tauri::{async_runtime, Emitter, EventTarget, Manager, Url, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinSet,
    time::{self, Instant},
};

const CLOSED_EVENT: &str = "dsh-remote-viewer-closed";
const DELIVERED_EVENT: &str = "dsh-remote-viewer-delivered";
const INVALID_GRANT: &str = "Invalid DS Harness Remote browser grant";
const UNAVAILABLE: &str = "Could not open the DS Harness Remote viewer";
const MAX_REDEMPTION: Duration = Duration::from_secs(60);
// Independent of the grant's short redemption window. The control connection owns the real lease,
// which the host may hold for up to two hours; this only outlives it to clear a forgotten listener.
const VIEWER_WATCHDOG: Duration = Duration::from_secs(125 * 60);

#[derive(Default)]
pub struct DshRemoteViewerState(Mutex<HashMap<String, ActiveHandoff>>);

struct ActiveHandoff {
    id: String,
    task: async_runtime::JoinHandle<()>,
    handoff: Arc<Handoff>,
}

impl ActiveHandoff {
    fn cancel(self) {
        self.handoff.grant.lock().unwrap().take();
        self.task.abort();
    }
}

impl DshRemoteViewerState {
    pub fn close_window(&self, label: &str) {
        if let Some(active) = self.0.lock().unwrap().remove(label) {
            active.cancel();
        }
    }

    fn close_handoff(&self, label: &str, handoff_id: &str) {
        let mut active = self.0.lock().unwrap();
        if active
            .get(label)
            .is_some_and(|current| current.id == handoff_id)
        {
            if let Some(current) = active.remove(label) {
                current.cancel();
            }
        }
    }

    pub fn close_all(&self) {
        for (_, active) in self.0.lock().unwrap().drain() {
            active.cancel();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserGrant {
    url: String,
    browser_grant: String,
    expires_at: u64,
}

fn validate_grant(grant: &BrowserGrant) -> Result<String, &'static str> {
    if grant.browser_grant.len() != 43
        || !grant
            .browser_grant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(INVALID_GRANT);
    }
    let invalid_origin = "Invalid DS Harness Remote browser origin";
    // Require the exact canonical HTTPS root, not merely a suffix match on a parsed URL.
    let host = grant
        .url
        .strip_prefix("https://")
        .and_then(|url| url.strip_suffix('/'))
        .ok_or(invalid_origin)?;
    let (id, domain) = host.split_once('.').ok_or(invalid_origin)?;
    let allowed_prefix = match domain {
        "hostc.4ba.io" | "tun.4ba.io" => id.starts_with(['t', 'p']),
        "hostc-test.4ba.io" | "tun-test.4ba.io" => id.starts_with('t'),
        _ => false,
    };
    if !allowed_prefix
        || id.len() != 12
        || !id
            .bytes()
            .skip(1)
            .all(|b| b"abcdefghijkmnpqrstuvwxyz23456789".contains(&b))
    {
        return Err(invalid_origin);
    }
    Ok(format!("https://{host}"))
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn require_local_window(window: &WebviewWindow) -> Result<(), &'static str> {
    if window.label() != "main" && !window.label().starts_with("win-") {
        return Err(UNAVAILABLE);
    }
    let url = window.url().map_err(|_| UNAVAILABLE)?;
    let bundled_origin = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    let same_origin = |expected: &Url| {
        url.scheme() == expected.scheme()
            && url.host() == expected.host()
            && url.port_or_known_default() == expected.port_or_known_default()
    };
    if same_origin(&Url::parse(bundled_origin).unwrap())
        || (tauri::is_dev()
            && window
                .config()
                .build
                .dev_url
                .as_ref()
                .is_some_and(same_origin))
    {
        Ok(())
    } else {
        Err(UNAVAILABLE)
    }
}

#[tauri::command]
pub async fn dsh_remote_viewer_open(
    window: WebviewWindow,
    handoff_id: String,
    grant: serde_json::Value,
) -> Result<(), String> {
    require_local_window(&window)?;
    if handoff_id.len() != 36
        || !handoff_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(UNAVAILABLE.into());
    }
    // Keep serde's input-bearing error details out of IPC errors and diagnostics.
    let grant: BrowserGrant = serde_json::from_value(grant).map_err(|_| INVALID_GRANT)?;
    let target = validate_grant(&grant)?;
    let now_ms = unix_ms();
    let remaining =
        Duration::from_millis(grant.expires_at.saturating_sub(now_ms)).min(MAX_REDEMPTION);
    if remaining.is_zero() {
        return Err(INVALID_GRANT.into());
    }
    let expires_at = now_ms + remaining.as_millis() as u64;
    let deadline = Instant::now() + remaining;

    let mut entropy = [0u8; 24];
    getrandom::fill(&mut entropy).map_err(|_| UNAVAILABLE)?;
    let capability: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| UNAVAILABLE)?;
    let host = listener.local_addr().map_err(|_| UNAVAILABLE)?.to_string();
    let origin = format!("http://{host}");
    // The independent local capability starts in the fragment, not the HTTP request or portal URL.
    let opener_url = format!("{origin}/#{capability}");
    let (events, event_rx) = mpsc::channel(3);
    let handoff = Arc::new(Handoff {
        host,
        origin,
        capability,
        target,
        expires_at,
        deadline,
        grant: Mutex::new(Some(grant.browser_grant)),
        events,
    });

    let id = handoff_id.clone();
    let owner = window.label().to_owned();
    let app = window.app_handle().clone();
    let viewers = window.state::<DshRemoteViewerState>();
    {
        let mut active = viewers.0.lock().unwrap();
        // Browser content never enters a Tauri WebView or receives an IPC bridge.
        let served_handoff = Arc::clone(&handoff);
        let task = async_runtime::spawn(async move {
            let target = EventTarget::webview_window(owner.clone());
            let reason = serve(listener, served_handoff, event_rx, || {
                let _ = app.emit_to(
                    target.clone(),
                    DELIVERED_EVENT,
                    serde_json::json!({ "handoffId": id }),
                );
            })
            .await;
            let viewers = app.state::<DshRemoteViewerState>();
            let mut active = viewers.0.lock().unwrap();
            if active.get(&owner).is_some_and(|current| current.id == id) {
                active.remove(&owner);
                let _ = app.emit_to(
                    target,
                    CLOSED_EVENT,
                    serde_json::json!({ "handoffId": id, "reason": reason }),
                );
            }
        });
        if let Some(previous) = active.insert(
            window.label().to_owned(),
            ActiveHandoff {
                id: handoff_id.clone(),
                task,
                handoff,
            },
        ) {
            previous.cancel();
        }
    }
    // Use the system browser rather than mobile in-app browser sheets, whose popup support varies.
    if window.opener().open_url(opener_url, None::<&str>).is_err() {
        viewers.close_handoff(window.label(), &handoff_id);
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn dsh_remote_viewer_close(
    window: WebviewWindow,
    handoff_id: String,
) -> Result<(), String> {
    require_local_window(&window)?;
    window
        .state::<DshRemoteViewerState>()
        .close_handoff(window.label(), &handoff_id);
    Ok(())
}

struct Handoff {
    host: String,
    origin: String,
    capability: String,
    target: String,
    expires_at: u64,
    deadline: Instant,
    grant: Mutex<Option<String>>,
    events: mpsc::Sender<BrowserEvent>,
}

#[derive(Copy, Clone)]
enum BrowserEvent {
    Taken,
    Delivered,
    Closed,
}

async fn serve(
    listener: TcpListener,
    handoff: Arc<Handoff>,
    mut events: mpsc::Receiver<BrowserEvent>,
    on_delivered: impl FnOnce(),
) -> &'static str {
    let mut pending = true;
    let mut on_delivered = Some(on_delivered);
    let mut connections = JoinSet::new();
    let watchdog = Instant::now() + VIEWER_WATCHDOG;
    loop {
        tokio::select! {
            biased;
            event = events.recv() => match event {
                Some(BrowserEvent::Taken) => pending = false,
                Some(BrowserEvent::Delivered) if !pending => {
                    if let Some(delivered) = on_delivered.take() { delivered(); }
                },
                Some(BrowserEvent::Delivered) => {},
                Some(BrowserEvent::Closed) => break "closed",
                None => break "unavailable",
            },
            _ = time::sleep_until(handoff.deadline), if pending => break "grant-expired",
            _ = time::sleep_until(watchdog) => break "viewer-timeout",
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept(), if connections.len() < 8 => {
                let Ok((stream, _)) = accepted else { break "unavailable"; };
                let handoff = Arc::clone(&handoff);
                connections.spawn(async move {
                    let _ = time::timeout(Duration::from_secs(3), handle(stream, handoff)).await;
                });
            }
        }
    }
    // Dropping the JoinSet also cancels any in-flight local connections.
}

async fn handle(mut stream: TcpStream, handoff: Arc<Handoff>) -> std::io::Result<()> {
    // Bounded header-only HTTP/1.1: endpoints never accept a body, upgrade or keepalive.
    let mut input = [0u8; 8192];
    let mut length = 0;
    loop {
        let n = stream.read(&mut input[length..]).await?;
        if n == 0 {
            return Ok(());
        }
        length += n;
        if input[..length].windows(4).any(|seq| seq == b"\r\n\r\n") {
            break;
        }
    }
    let response = route(&input[..length], &handoff);
    let headers = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: same-origin\r\nX-Content-Type-Options: nosniff\r\n\
         Cross-Origin-Resource-Policy: same-origin\r\n\
         Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'\r\n\r\n",
        response.status,
        response.content_type,
        response.body.len(),
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(response.body.as_bytes()).await?;
    stream.shutdown().await
}

struct Response {
    status: &'static str,
    content_type: &'static str,
    body: Cow<'static, str>,
}

impl Response {
    fn text(status: &'static str, body: impl Into<Cow<'static, str>>) -> Self {
        Self {
            status,
            content_type: "text/plain",
            body: body.into(),
        }
    }
}

fn route(input: &[u8], handoff: &Handoff) -> Response {
    let missing = || Response::text("404 Not Found", "");
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut request = httparse::Request::new(&mut headers);
    if !matches!(request.parse(input), Ok(httparse::Status::Complete(end)) if end == input.len())
        || request.version != Some(1)
    {
        return missing();
    }
    let header_equals = |name: &str, value: Option<&[u8]>| {
        let mut values = request
            .headers
            .iter()
            .filter(|h| h.name.eq_ignore_ascii_case(name));
        values.next().map(|h| h.value) == value && values.next().is_none()
    };
    if !header_equals("Host", Some(handoff.host.as_bytes()))
        || !header_equals("Transfer-Encoding", None)
        || !(header_equals("Content-Length", None) || header_equals("Content-Length", Some(b"0")))
    {
        return missing();
    }
    match (request.method, request.path) {
        (Some("GET"), Some("/")) => Response {
            status: "200 OK",
            content_type: "text/html",
            body: format!(
                r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OMPiUI · DS Harness Remote</title>
                <h1>打开 OMPiUI 远程工作台</h1><button id="open" type="button" data-origin="{}" data-expires-at="{}">打开工作台</button> <button id="close" type="button">结束连接</button>
                <p id="status" role="status">请在一次性授权过期前打开。</p><script src="/handoff.js" defer></script></html>"#,
                handoff.target, handoff.expires_at,
            ).into(),
        },
        (Some("GET"), Some("/handoff.js")) => Response {
            status: "200 OK",
            content_type: "text/javascript",
            body: include_str!("dsh_remote_handoff.js").into(),
        },
        (Some("POST"), Some(path @ ("/grant" | "/delivered" | "/closed")))
            if header_equals("Origin", Some(handoff.origin.as_bytes()))
                && header_equals("X-OMPiUI-Handoff", Some(handoff.capability.as_bytes())) =>
        {
            let mut grant = handoff.grant.lock().unwrap();
            if path == "/closed" {
                grant.take();
                let _ = handoff.events.try_send(BrowserEvent::Closed);
                return Response::text("200 OK", "");
            }
            if path == "/delivered" {
                if grant.is_none() {
                    let _ = handoff.events.try_send(BrowserEvent::Delivered);
                    return Response::text("200 OK", "");
                }
                return missing();
            }
            if Instant::now() < handoff.deadline && unix_ms() < handoff.expires_at {
                if let Some(grant) = grant.take() {
                    let _ = handoff.events.try_send(BrowserEvent::Taken);
                    return Response::text("200 OK", grant);
                }
            }
            Response::text("410 Gone", "")
        }
        _ => missing(),
    }
}
