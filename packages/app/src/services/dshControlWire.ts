import {
  DSH_CONTROL_LIMIT, DSH_RELAY_LIMIT, DSH_REMOTE_ORIGIN, dshFrame, isDshExpiry, parseDshFrame, type DshFrame,
} from '@ompiui/protocol/dsh-remote'
import { openPlatformSocket, PI_SOCKET_OPEN, type PiSocket } from '../omp/ompSocket'
import { isTauri } from '../utils/tauri'
import { recordDshDiagnostic } from './dshConnectionDiagnostics'

const WSS = DSH_REMOTE_ORIGIN.replace('https:', 'wss:') + '/ws/v1/connect'
const encoder = new TextEncoder()

/** DS 控制帧只记录阶段与错误码，不进入普通会话的正文流量预览。 */
export class DshControlWire {
  closeInfo?: { code: number; reason: string }
  private readonly socket: PiSocket
  private readonly queue: Array<{ frame: DshFrame; size: number }> = []
  private readonly ended = new AbortController()
  private queuedBytes = 0
  private controlLimit = DSH_CONTROL_LIMIT
  private relayLimit = DSH_RELAY_LIMIT
  private wake?: () => void
  private opened?: () => void
  private idleTimer?: ReturnType<typeof setTimeout>
  private readonly detach: () => void

  constructor(signal: AbortSignal, attemptId: string) {
    this.socket = openPlatformSocket(WSS)
    const abort = () => this.close()
    this.detach = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    recordDshDiagnostic('connect.transport.selected', { attemptId, transport: isTauri() ? 'native' : 'webview' })
    this.socket.onopen = () => this.opened?.()
    this.socket.onclose = event => {
      this.closeInfo = { code: event.code, reason: event.reason ?? '' }
      recordDshDiagnostic('connect.socket.closed', { attemptId, closeCode: event.code, closeReason: event.reason ?? '' })
      this.finish()
    }
    // 原生桥会在 error 后投递原始 close；不要提前关闭而覆盖服务端原因。
    this.socket.onerror = () => this.finish()
    this.socket.onmessage = event => {
      try {
        if (typeof event.data !== 'string') throw new Error('Invalid DSH frame encoding')
        const size = encoder.encode(event.data).length
        if (size > this.relayLimit) throw new Error('DSH frame too large')
        const frame = parseDshFrame(event.data)
        if (frame.type !== 'relay' && size > this.controlLimit) throw new Error('DSH control frame too large')
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => this.close(), 60_000)
        if (frame.type === 'ping') { this.send('pong', frame.payload); return }
        if (this.queue.length >= 16 || this.queuedBytes + size > DSH_RELAY_LIMIT) throw new Error('DSH control queue full')
        this.queue.push({ frame, size })
        this.queuedBytes += size
        this.wake?.()
      } catch {
        recordDshDiagnostic('connect.frame.invalid', { attemptId, code: 'PROTOCOL' })
        this.close()
      }
    }
    if (signal.aborted) this.close()
  }

  async open(signal: AbortSignal): Promise<void> {
    const lifetime = AbortSignal.any([signal, this.ended.signal])
    lifetime.throwIfAborted()
    if (this.socket.readyState === PI_SOCKET_OPEN) return
    await new Promise<void>((resolve, reject) => {
      const remove = () => { lifetime.removeEventListener('abort', abort); this.opened = undefined }
      const abort = () => { remove(); reject(new Error('Could not connect to DS Harness Remote')) }
      this.opened = () => { remove(); resolve() }
      lifetime.addEventListener('abort', abort, { once: true })
    })
  }

  limit(control: unknown, relay: unknown): void {
    if (!isDshExpiry(control) || control > DSH_CONTROL_LIMIT || !isDshExpiry(relay) || relay > DSH_RELAY_LIMIT) {
      throw new Error('Invalid DSH frame limits')
    }
    this.controlLimit = control
    this.relayLimit = relay
  }

  send(type: string, payload: Record<string, unknown>): void {
    if (this.ended.signal.aborted || this.socket.readyState !== PI_SOCKET_OPEN || (this.socket.bufferedAmount ?? 0) > DSH_RELAY_LIMIT) {
      throw new Error('DSH control connection is closed')
    }
    const frame = JSON.stringify(dshFrame(type, payload))
    if (encoder.encode(frame).length > (type === 'relay' ? this.relayLimit : this.controlLimit)) throw new Error('DSH frame too large')
    this.socket.send(frame)
  }

  async next(signal: AbortSignal): Promise<DshFrame> {
    const lifetime = AbortSignal.any([signal, this.ended.signal])
    while (!this.queue.length) {
      lifetime.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = () => { this.wake = undefined; reject(lifetime.reason) }
        this.wake = () => { this.wake = undefined; lifetime.removeEventListener('abort', abort); resolve() }
        lifetime.addEventListener('abort', abort, { once: true })
      })
    }
    signal.throwIfAborted()
    const item = this.queue.shift()!
    this.queuedBytes -= item.size
    return item.frame
  }

  private finish(): void {
    clearTimeout(this.idleTimer)
    this.detach()
    this.ended.abort()
    this.wake?.()
  }

  close(): void {
    this.finish()
    this.socket.close()
  }
}
