import { isTauri } from '../utils/tauri'
import { resolveAndroidTailscaleUrl } from '../utils/androidTailscale'
import { serverStore } from '../store/serverStore'
import { auditSocket } from './trafficAudit/socket'

/**
 * PiSocket：WebSocket 的最小抽象（open/message/close + readyState/send/close）。
 * 浏览器直接用原生 WebSocket；Tauri 下走 Rust WS 桥——WebView2 的 WebSocket
 * 会被系统代理劫持，本地回环连接表现为 TCP 层 ERR_CONNECTION_REFUSED，
 * 只能由 Rust 直连绕过。
 */
export const PI_SOCKET_OPEN = 1
export const PI_SOCKET_CLOSING = 2
export const PI_SOCKET_CLOSED = 3

/** 桥连接 open 看门狗：超时仍未收到 open 事件则主动失败让调用方重连 */
const WS_BRIDGE_OPEN_TIMEOUT_MS = 8_000

export interface PiSocketMessage {
  data: unknown
  annotateTraffic?: (parsed: unknown) => void
}

export interface PiSocket {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: PiSocketMessage) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

type BridgeEvent =
  | { type: 'open' }
  | { type: 'message'; sequence: number; data: string }
  | { type: 'close'; code?: number; reason?: string }
  | { type: 'error'; message?: string }

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

class TauriBridgeSocket implements PiSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0

  private id: number | null = null
  private closedByUs = false
  private pendingSends: Array<{ data: string; bytes: number }> = []
  private queuedBytes = 0
  private invokeFn: TauriInvoke | null = null
  private inFlight = 0
  private consumedSequence = 0
  private acknowledgedSequence = 0
  private acknowledgementInFlight = false
  private acknowledgementScheduled = false

  constructor(url: string) {
    void this.connect(url)
  }

  private async connect(url: string): Promise<void> {
    try {
      const { invoke, Channel } = await import('@tauri-apps/api/core')
      this.invokeFn = invoke as TauriInvoke
      const channel = new Channel<BridgeEvent>()
      channel.onmessage = event => this.handleEvent(event)
      const resolved = await resolveAndroidTailscaleUrl(url)
      if (this.closedByUs) return
      // 首次 webview 会话的 IPC 偶发不可靠：invoke 悬挂或事件不送达时，
      // 靠 open 看门狗主动失败一次，让调用方的重连逻辑用全新的 Channel/
      // invoke 重试（等价于一次刷新）。
      let watchdogFired = false
      const openWatchdog = window.setTimeout(() => {
        if (this.readyState !== 0) return
        watchdogFired = true
        this.readyState = PI_SOCKET_CLOSED
        this.onerror?.()
        this.onclose?.({ code: 1006 })
      }, WS_BRIDGE_OPEN_TIMEOUT_MS)
      const id = await invoke<number>('ws_bridge_connect', { url: resolved, onEvent: channel })
      clearTimeout(openWatchdog)
      if (watchdogFired || this.closedByUs) {
        // 看门狗已判死：这条 Rust 连接不再需要，及时关掉避免泄漏。
        void invoke('ws_bridge_close', { id }).catch(() => undefined)
        return
      }
      this.id = id
      this.acknowledgeConsumed()
      this.pump()
    } catch {
      if (this.closedByUs || this.readyState === PI_SOCKET_CLOSED) return
      this.readyState = PI_SOCKET_CLOSED
      this.onerror?.()
      this.onclose?.({ code: 1006 })
    }
  }

  private handleEvent(event: BridgeEvent): void {
    if (event.type === 'open') {
      if (this.readyState !== 0) return
      this.readyState = PI_SOCKET_OPEN
      this.onopen?.()
      return
    }
    if (event.type === 'message') {
      if (this.readyState !== PI_SOCKET_OPEN) return
      try {
        this.onmessage?.({ data: event.data })
      } finally {
        // Channel.send 只将消息加入 IPC 队列；JavaScript 消费者处理完成后
        // 才归还额度，而非发送时归还。
        this.consumedSequence = event.sequence
        this.scheduleAcknowledgement()
      }
      return
    }
    if (event.type === 'error') {
      if (import.meta.env.DEV) console.debug('[PiSocket] bridge error:', event.message)
      this.onerror?.()
      return
    }
    if (this.readyState === PI_SOCKET_CLOSED) return
    this.readyState = PI_SOCKET_CLOSED
    this.pendingSends = []
    this.queuedBytes = 0
    this.onclose?.({ code: event.code ?? 1006, reason: event.reason })
  }

  private scheduleAcknowledgement(): void {
    if (this.acknowledgementScheduled) return
    this.acknowledgementScheduled = true
    queueMicrotask(() => {
      this.acknowledgementScheduled = false
      this.acknowledgeConsumed()
    })
  }

  private acknowledgeConsumed(): void {
    if (
      this.readyState !== PI_SOCKET_OPEN || this.id === null || !this.invokeFn ||
      this.acknowledgementInFlight || this.consumedSequence <= this.acknowledgedSequence
    ) return
    const sequence = this.consumedSequence
    this.acknowledgementInFlight = true
    void this.invokeFn('ws_bridge_ack', { id: this.id, sequence })
      .then(() => { this.acknowledgedSequence = sequence })
      .catch(() => {
        if (this.readyState !== PI_SOCKET_OPEN) return
        this.onerror?.()
        this.close(1011, 'WebSocket bridge acknowledgement failed')
      })
      .finally(() => {
        this.acknowledgementInFlight = false
        // 合并并发确认，避免每帧创建 IPC 请求。
        this.acknowledgeConsumed()
      })
  }

  send(data: string): void {
    if (this.readyState !== PI_SOCKET_OPEN) return
    const bytes = new TextEncoder().encode(data).byteLength
    if (bytes > 128 * 1024 || this.queuedBytes + bytes > 8 * 1024 * 1024 || this.pendingSends.length >= 1024) {
      this.onerror?.()
      this.close(1013, 'WebSocket bridge queue limit exceeded')
      return
    }
    this.pendingSends.push({ data, bytes })
    this.queuedBytes += bytes
    this.pump()
  }

  private pump(): void {
    // 顺序等待 Rust 的有界通道准入，既保留输入顺序，也避免粘贴时并发 IPC 堆积。
    if (this.readyState !== PI_SOCKET_OPEN || this.id === null || !this.invokeFn || this.inFlight) return
    const next = this.pendingSends.shift()
    if (!next) return
    const id = this.id
    this.inFlight++
    void this.invokeFn('ws_bridge_send', { id, data: next.data })
      .catch(() => {
        this.onerror?.()
        this.close(1013, 'WebSocket bridge send failed')
      })
      .finally(() => {
        this.inFlight--
        this.queuedBytes = Math.max(0, this.queuedBytes - next.bytes)
        this.pump()
      })
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === PI_SOCKET_CLOSED) return
    this.closedByUs = true
    this.pendingSends = []
    this.queuedBytes = 0
    const id = this.id
    if (id !== null && this.invokeFn) {
      this.readyState = PI_SOCKET_CLOSING
      void this.invokeFn('ws_bridge_close', { id, code, reason }).catch(() => undefined)
      return
    }
    this.readyState = PI_SOCKET_CLOSED
  }
}

export function openPiSocket(url: string): PiSocket {
  const socket = isTauri() ? new TauriBridgeSocket(url) : (new WebSocket(url) as unknown as PiSocket)
  return auditSocket(socket, url, serverStore.getActiveServer()?.url)
}
