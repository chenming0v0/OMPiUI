//! WebSocket 桥：WebView2 的 WebSocket 走系统代理，本地回环连接会被代理软件
//! 拒绝（net::ERR_CONNECTION_REFUSED）。所有 ws:// 流量改由 Rust 直连，
//! 事件经 Channel 推回前端，与 plugin-http 的 HTTP 桥同一个思路。
//!
//! 连接按 (window label, bridge id) 键控：多窗口场景下窗口销毁时能精确清理
//! 该窗口的所有连接，避免 Rust 侧 WS 任务泄漏。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::{select, Either};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc::{channel, Sender};
use tokio::sync::{oneshot, Notify};
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message};

#[path = "bridge_inbound.rs"]
mod inbound;
use inbound::{InboundLedger, MAX_INBOUND_MESSAGE_BYTES};

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BridgeEvent {
    Open,
    Message { sequence: u64, data: String },
    Close { code: u16, reason: String },
    Error { message: String },
}

struct BridgeClose {
    code: u16,
    reason: String,
}

impl BridgeClose {
    fn new(code: u16, reason: impl Into<String>) -> Self {
        Self { code, reason: reason.into() }
    }
}

#[derive(Default)]
struct InboundFlow {
    ledger: Mutex<InboundLedger>,
    released: Notify,
}

impl InboundFlow {
    async fn wait_for_capacity(&self) -> Result<(), tokio::time::error::Elapsed> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if self.ledger.lock().expect("bridge inbound state poisoned").can_receive() {
                    return;
                }
                // 若 ACK 先于等待到达，notify_one 会保留一次唤醒许可。
                self.released.notified().await;
            }
        }).await
    }

    fn acknowledge(&self, sequence: u64) -> Result<(), String> {
        self.ledger
            .lock()
            .expect("bridge inbound state poisoned")
            .acknowledge(sequence)
            .map_err(str::to_string)?;
        self.released.notify_one();
        Ok(())
    }
}

struct BridgeConnection {
    sender: Sender<Message>,
    inbound: Arc<InboundFlow>,
    close: Option<oneshot::Sender<BridgeClose>>,
}

impl BridgeConnection {
    fn close(&mut self, code: u16, reason: String) {
        if let Some(close) = self.close.take() {
            let _ = close.send(BridgeClose::new(code, reason));
        }
    }
}

/// 复合键：(window label, bridge id)。同一窗口内 id 唯一；不同窗口可复用 id。
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct BridgeKey {
    window_label: String,
    bridge_id: u32,
}

#[derive(Default)]
pub struct BridgeState {
    next_id: AtomicU32,
    connections: Mutex<HashMap<BridgeKey, BridgeConnection>>,
}

impl BridgeState {
    /// 分配下一个连接 id（全局递增，避免跨窗口撞号）。
    pub fn next_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
    }

    fn insert(&self, key: BridgeKey, connection: BridgeConnection) {
        self.connections
            .lock()
            .expect("bridge state poisoned")
            .insert(key, connection);
    }

    fn sender(&self, key: &BridgeKey) -> Option<Sender<Message>> {
        self.connections
            .lock()
            .expect("bridge state poisoned")
            .get(key)
            .map(|connection| connection.sender.clone())
    }

    fn remove(&self, key: &BridgeKey) -> Option<BridgeConnection> {
        self.connections
            .lock()
            .expect("bridge state poisoned")
            .remove(key)
    }

    fn acknowledge(&self, key: &BridgeKey, sequence: u64) -> Result<(), String> {
        let inbound = self.connections
            .lock()
            .expect("bridge state poisoned")
            .get(key)
            .map(|connection| Arc::clone(&connection.inbound));
        // 已进入 IPC 的 ACK 可能晚于连接关闭事件到达。
        if let Some(inbound) = inbound {
            inbound.acknowledge(sequence)?;
        }
        Ok(())
    }

    /// 关闭使用独立信号，避免发送队列满时阻断清理。
    pub fn disconnect_window(&self, window_label: &str) {
        self.connections
            .lock()
            .expect("bridge state poisoned")
            .retain(|key, connection| {
                if key.window_label != window_label {
                    return true;
                }
                connection.close(1000, "Window closed".to_string());
                false
            });
    }
}

/// WS 拨号超时：connect_async 本身无超时，撞上服务重启/半死端口的窗口期
/// 会永远 pending——前端没有 open 也没有 close 事件，终端 tab 永远停在
/// connecting（黄色）。超时后报错，前端的断线重连逻辑会接管。
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[tauri::command]
pub async fn ws_bridge_connect(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, BridgeState>,
    url: String,
    on_event: Channel<BridgeEvent>,
) -> Result<u32, String> {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_INBOUND_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_INBOUND_MESSAGE_BYTES);
    let (socket, _) = tokio::time::timeout(
        WS_CONNECT_TIMEOUT,
        connect_async_with_config(&url, Some(config), false),
    )
    .await
    .map_err(|_| {
        format!(
            "WebSocket connect timed out after {}s",
            WS_CONNECT_TIMEOUT.as_secs()
        )
    })?
    .map_err(|error| format!("WebSocket connect failed: {error}"))?;
    let (mut writer, mut reader) = socket.split();

    let id = state.next_id();
    let key = BridgeKey {
        window_label: window.label().to_string(),
        bridge_id: id,
    };
    let inbound = Arc::new(InboundFlow::default());
    let (tx, mut rx) = channel::<Message>(64);
    let (close_tx, close_rx) = oneshot::channel();
    state.insert(key.clone(), BridgeConnection {
        sender: tx,
        inbound: Arc::clone(&inbound),
        close: Some(close_tx),
    });

    if on_event.send(BridgeEvent::Open).is_err() {
        state.remove(&key);
        return Err("WebSocket event channel is already closed".to_string());
    }

    tauri::async_runtime::spawn(async move {
        let read_loop = async {
            loop {
                if inbound.wait_for_capacity().await.is_err() {
                    break BridgeClose::new(1013, "WebSocket bridge consumer acknowledgement timed out");
                }
                let Some(frame) = reader.next().await else {
                    break BridgeClose::new(1006, "WebSocket stream ended without a close frame");
                };
                let data = match frame {
                    Ok(Message::Text(text)) => text,
                    Ok(Message::Binary(bytes)) => String::from_utf8(bytes).unwrap_or_else(|error| {
                        String::from_utf8_lossy(error.as_bytes()).into_owned()
                    }),
                    Ok(Message::Close(frame)) => {
                        let code = frame.as_ref().map(|frame| u16::from(frame.code)).unwrap_or(1005);
                        let reason = frame.map(|frame| frame.reason.into_owned()).unwrap_or_default();
                        break BridgeClose::new(code, reason);
                    }
                    Ok(Message::Ping(payload)) => {
                        if let Some(sender) = app.state::<BridgeState>().sender(&key) {
                            let _ = sender.try_send(Message::Pong(payload));
                        }
                        continue;
                    }
                    Ok(_) => continue,
                    Err(error) => {
                        let code = if matches!(error, WebSocketError::Capacity(_)) { 1009 } else { 1006 };
                        let reason = error.to_string();
                        let _ = on_event.send(BridgeEvent::Error { message: reason.clone() });
                        break BridgeClose::new(code, reason);
                    }
                };
                if data.len() > MAX_INBOUND_MESSAGE_BYTES {
                    break BridgeClose::new(1009, "WebSocket bridge message exceeds 4 MiB");
                }
                let sequence = match inbound.ledger.lock().expect("bridge inbound state poisoned").record(data.len()) {
                    Ok(sequence) => sequence,
                    Err(reason) => break BridgeClose::new(1013, reason),
                };
                if on_event.send(BridgeEvent::Message { sequence, data }).is_err() {
                    break BridgeClose::new(1006, "WebSocket event channel is closed");
                }
            }
        };
        let write_loop = async {
            let close = {
                let forward = async {
                    while let Some(message) = rx.recv().await {
                        if !matches!(
                            tokio::time::timeout(Duration::from_secs(15), writer.send(message)).await,
                            Ok(Ok(()))
                        ) {
                            return BridgeClose::new(1011, "WebSocket bridge send failed or timed out");
                        }
                    }
                    BridgeClose::new(1000, "WebSocket bridge closed")
                };
                futures_util::pin_mut!(close_rx, forward);
                match select(close_rx, forward).await {
                    Either::Left((requested, _)) => requested.unwrap_or_else(|_| BridgeClose::new(1000, "WebSocket bridge closed")),
                    Either::Right((close, _)) => return close,
                }
            };
            let frame = CloseFrame { code: close.code.into(), reason: close.reason.clone().into() };
            let _ = tokio::time::timeout(Duration::from_secs(15), writer.send(Message::Close(Some(frame)))).await;
            close
        };
        // 任一方向结束都会取消另一方向，包括等待 ACK 的读取端。
        futures_util::pin_mut!(read_loop, write_loop);
        let close = match select(read_loop, write_loop).await {
            Either::Left((close, _)) | Either::Right((close, _)) => close,
        };
        app.state::<BridgeState>().remove(&key);
        let _ = on_event.send(BridgeEvent::Close { code: close.code, reason: close.reason });
    });

    Ok(id)
}

#[tauri::command]
pub fn ws_bridge_ack(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    id: u32,
    sequence: u64,
) -> Result<(), String> {
    state.acknowledge(&BridgeKey {
        window_label: window.label().to_string(),
        bridge_id: id,
    }, sequence)
}

#[tauri::command]
pub fn ws_bridge_send(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let key = BridgeKey {
        window_label: window.label().to_string(),
        bridge_id: id,
    };
    let sender = state
        .sender(&key)
        .ok_or_else(|| "WebSocket is not connected".to_string())?;
    if data.len() > 128 * 1024 {
        return Err("WebSocket bridge message exceeds 128 KiB".to_string());
    }
    sender
        .try_send(Message::Text(data.into()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ws_bridge_close(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    id: u32,
    code: Option<u16>,
    reason: Option<String>,
) -> Result<(), String> {
    let key = BridgeKey {
        window_label: window.label().to_string(),
        bridge_id: id,
    };
    if let Some(mut connection) = state.remove(&key) {
        connection.close(code.unwrap_or(1000), reason.unwrap_or_default());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(window_label: &str, bridge_id: u32) -> BridgeKey {
        BridgeKey {
            window_label: window_label.to_string(),
            bridge_id,
        }
    }

    fn register(state: &BridgeState, key: BridgeKey) -> (tokio::sync::mpsc::Receiver<Message>, oneshot::Receiver<BridgeClose>) {
        let (sender, receiver) = channel(64);
        let (close, closed) = oneshot::channel();
        state.insert(key, BridgeConnection {
            sender,
            inbound: Arc::new(InboundFlow::default()),
            close: Some(close),
        });
        (receiver, closed)
    }

    #[test]
    fn window_destroy_cleans_only_that_windows_bridges() {
        let state = BridgeState::default();
        let (_rx_a1, mut close_a1) = register(&state, key("main", 1));
        let (_rx_a2, mut close_a2) = register(&state, key("main", 2));
        let (_rx_b1, mut close_b1) = register(&state, key("win-1", 1));

        state.disconnect_window("main");

        assert!(state.sender(&key("main", 1)).is_none());
        assert!(state.sender(&key("main", 2)).is_none());
        assert_eq!(close_a1.try_recv().unwrap().code, 1000);
        assert_eq!(close_a2.try_recv().unwrap().code, 1000);
        assert!(matches!(close_b1.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
        // 其他窗口的同 id 连接不受影响
        assert!(state.sender(&key("win-1", 1)).is_some());
    }

    #[test]
    fn same_id_in_different_windows_is_isolated() {
        let state = BridgeState::default();
        let (_rx_a, _close_a) = register(&state, key("main", 7));
        let (_rx_b, _close_b) = register(&state, key("win-1", 7));

        // 关掉 main 的 7，win-1 的 7 保留
        state.remove(&key("main", 7));
        assert!(state.sender(&key("main", 7)).is_none());
        assert!(state.sender(&key("win-1", 7)).is_some());
    }

    #[test]
    fn window_destroy_interrupts_even_a_full_send_queue() {
        let state = BridgeState::default();
        let (_receiver, mut closed) = register(&state, key("main", 1));
        let sender = state.sender(&key("main", 1)).unwrap();
        for _ in 0..64 {
            sender.try_send(Message::Text("pending".into())).unwrap();
        }
        state.disconnect_window("main");
        assert_eq!(closed.try_recv().unwrap().code, 1000);
        assert!(state.sender(&key("main", 1)).is_none());
    }

    #[test]
    fn next_id_is_unique_across_windows() {
        let state = BridgeState::default();
        let first = state.next_id();
        let second = state.next_id();
        assert_ne!(first, second);
    }
}
