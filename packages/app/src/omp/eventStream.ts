import {
  PROTOCOL_VERSION,
  eventStreamKey,
  parseEventStreamKey,
  type EventCursor,
  type EventCursorMap,
  type EventEnvelope,
  type EventServerMessage,
  type EventStreamKey,
  type EventStreamRef,
  isJsonObject,
  type CommandRecord,
  type JsonObject,
} from '@ompiui/protocol'
import type { AgentMessage, AgentSessionEvent, PiLiveMessage, ToolResultMessage } from './domain/index.js'
import type { ProviderAuthEvent, SessionsActivitySnapshot, SessionActivityStatus } from '@ompiui/protocol'
import { getApiBase, getPiAuthToken, piFetch } from './httpClient.js'
import { openPiSocket, PI_SOCKET_CLOSED, PI_SOCKET_CLOSING, PI_SOCKET_OPEN, type PiSocket } from './ompSocket'
import { piBranchStore, piCommandStore, piSessionStateStore } from './state/index.js'
import { extensionUiStore } from './extensionUiStore'
import { extensionTuiStore } from './extensionTuiStore'
import { commandFeedbackStore } from './commandFeedbackStore'
import { extensionDiagnosticStore } from './extensionDiagnosticStore'
import { notificationStore } from '../store/notificationStore'
import i18n from '../i18n'
import { liveToolOutputStore, extractToolExecutionText } from './liveToolOutput'
import { toolInteractionStore } from './toolInteractionStore'
import { ompSubagentStore } from './ompSubagentStore'
import { activeSessionStore } from '../store/activeSessionStore'
import { serverStore } from '../store/serverStore'
import { perfMark } from '../utils/perf'
import { notifyReconnected, notifySessionIdle, notifySessionStarted } from '../hooks/useGlobalEvents'
import {
  getTrackedManagementProviders,
  receivePackageProgress,
  receiveProviderAuthEvent,
  receiveProviderAuthUpdated,
  receiveResourceRevision,
  subscribeManagementStreams,
  type PackageProgress,
} from './managementEventStore'
import type { SessionStatus } from '../types/session'
import { BrowserDiagnostics } from './browserDiagnostics'
import { markModelSettingsDisconnected, refreshModelSettings } from './modelSettingsSync'
import { retryDelay } from './networkRetry'
import { setEventStreamState } from '../api/events'
import { clearSubagentTranscripts } from './subagentTranscript'
import { bashPendingStore } from './bashPendingStore'
import { faultSocketOpened, faultSocketClosed, faultSocketUnused, reportRuntimeCrash, recordClientDiagnostic } from './faultAudit/controller'
import { loadPiSessionData, refreshPiBranch, refreshPiSessionState, settlePiLiveMessage } from './controllers/index.js'
import { SessionActivityWatchdog } from './sessionActivityWatchdog.js'

const PING_INTERVAL_MS = 25_000
const RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_PROBE_MS = 60_000
const REFRESH_DEBOUNCE_MS = 150

type PiEventPayload = {
  event:
    | AgentSessionEvent
    | { type: 'config_update'; model?: JsonObject; thinkingLevel?: string }
    | { type: 'irc_message'; message: JsonObject }
    | { type: 'command_output'; text: string; source?: string; isError?: boolean; level?: string; status?: string }
    | { type: 'prompt_result'; agentInvoked: boolean; status: 'completed' | 'aborted' | 'error'; error?: string | JsonObject }
    | { type: 'extension_error'; extensionPath: string; event: string; error: string }
    | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; source?: string }
    | { type: 'rpc_frame_error' | 'rpc_stream_error'; error: string; originalType?: string }
  meta: EventCursor & { liveMessage?: { id: string; revision: number } }
}

type CommandRecovery = {
  key: string
  cursor: EventCursor
  generation: number
  controller?: AbortController
}

type PiExtensionUiEvent =
  | { type: 'requested'; request: import('@ompiui/protocol').ExtensionUiDialogRequest }
  | { type: 'settled'; requestId: string; sessionId: string }
  | { type: 'state'; sessionId: string; patch: import('@ompiui/protocol').ExtensionUiStatePatch }
  | { type: 'notify'; sessionId: string; message: string; notifyType?: 'info' | 'warning' | 'error' }
  | { type: 'editor'; sessionId: string; command: import('@ompiui/protocol').ExtensionUiEditorCommand }
  | { type: 'tuiAttach'; sessionId: string; attach: import('@ompiui/protocol').ExtensionTuiAttach }
  | { type: 'tuiDetach'; sessionId: string; key: string }
  | { type: 'tuiFrame'; sessionId: string; data: string }

type SessionsUpdatedPayload = {
  sessionId?: string
  attached?: boolean
  detached?: boolean
  materialized?: boolean
  crashed?: boolean
  faultId?: string
  faultTime?: string
  errorCode?: string
  message?: string
  runtimeExit?: JsonObject
  /** 会话活跃期间 head 推进（新条目），节流后通知列表刷新 */
  updated?: boolean
  replaced?: boolean
  sourceSessionId?: string
  targetSessionId?: string
  targetCwd?: string
  /** runtime-reuse = server 复用空闲 runtime 的静默身份切换；空 = fork/new/import 等真实替换 */
  reason?: string
}

/**
 * WebSocket event stream client for /api/v1/events (multi-session).
 *
 * Panes connect/disconnect sessions with reference counting; the socket
 * resubscribes the full active set on every change (server subscribe is
 * replace-semantics). Events route to the owning session's keyed stores:
 * - message_update: update checkpoint.liveMessage locally (no request)
 * - entry/turn/agent events: debounced branch refresh (latest page merge)
 * - state-only events: debounced state.get refresh
 * - resync_required: full reload for that stream
 * - sessions.updated: reload global session list
 */
class PiEventStream {
  constructor() {
    queueMicrotask(() => this.ensureManagementWatch())
    const resume = () => {
      if (!navigator.onLine || document.visibilityState === 'hidden' || !this.hasSubscriptions() || this.ws) return
      this.reconnectAttempts = 0
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.ensureSocket()
    }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
  }

  private ws: PiSocket | null = null
  private readonly diagnostics = new BrowserDiagnostics(message => this.send(message))
  private lastCloseCode: number | undefined
  private lastProblemCode: string | undefined
  private refCounts = new Map<string, number>()
  private workspaceRefCounts = new Map<string, number>()
  private cursors = new Map<string, EventCursor>()
  private pendingLiveMessages = new Map<string, { liveMessage: PiLiveMessage; position: EventCursor }>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly activityWatchdog = new SessionActivityWatchdog(
    () => this.refCounts.keys(),
    async (sessionId, signal) => {
      await refreshPiSessionState(sessionId, signal)
      this.reconcileActivityFromState(sessionId)
    },
  )
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private branchRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stateRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private diskRefreshTimers = new Map<string, { timer: number; delay: number }>()
  private reconnectAttempts = 0
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private subscribeQueued = false
  private sentStreams = new Set<string>()
  private subagentSeen = new Set<string>()
  private liveRecoveryAt = new Map<string, number>()
  private liveRecoveryFlights = new Set<string>()
  private commandRecoveries = new Map<string, CommandRecovery>()
  private pendingResync = new Set<string>()
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  private resyncFlights = new Map<string, Promise<void>>()
  private resyncControllers = new Map<string, AbortController>()
  private incompleteResync = new Set<string>()
  private resyncRetries = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>()
  private resyncActive = 0
  private resyncGeneration = 0
  private readonly RESYNC_CONCURRENCY = 2

  /** Subscribe a session stream (reference counted). */
  connect(sessionId: string): void {
    piBranchStore.retain(sessionId)
    this.refCounts.set(sessionId, (this.refCounts.get(sessionId) ?? 0) + 1)
    if (this.refCounts.get(sessionId) === 1) {
      this.activityWatchdog.start()
      const poll = { timer: 0, delay: 1500 }
      const refresh = async () => {
        if (this.diskRefreshTimers.get(sessionId) !== poll) return
        const state = piSessionStateStore.getState(sessionId)
        if (
          navigator.onLine &&
          document.visibilityState !== 'hidden' &&
          (state?.readOnly === true || state?.diskPreview === true)
        ) {
          const cursor = piBranchStore.getData(sessionId)?.syncCursor
          try {
            await refreshPiBranch(sessionId)
            poll.delay =
              cursor !== piBranchStore.getData(sessionId)?.syncCursor ? 1500 : Math.min(10_000, poll.delay * 1.5)
          } catch {
            poll.delay = Math.min(30_000, poll.delay * 2)
          }
        }
        if (this.diskRefreshTimers.get(sessionId) === poll)
          poll.timer = window.setTimeout(() => void refresh(), retryDelay(0, poll.delay, poll.delay))
      }
      this.diskRefreshTimers.set(sessionId, poll)
      poll.timer = window.setTimeout(() => void refresh(), poll.delay)
      this.ensureSocket()
      if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
    }
  }

  /** Unsubscribe a session stream; closes the socket when nothing remains. */
  disconnect(sessionId: string): void {
    const count = this.refCounts.get(sessionId) ?? 0
    if (count <= 1) {
      this.refCounts.delete(sessionId)
      const resyncKey = eventStreamKey({ kind: 'session', id: sessionId })
      this.pendingResync.delete(resyncKey)
      this.incompleteResync.delete(resyncKey)
      this.clearResyncRetry(resyncKey)
      this.resyncControllers.get(sessionId)?.abort()
      this.resyncControllers.delete(sessionId)
      this.resyncFlights.delete(sessionId)
      piBranchStore.release(sessionId)
      // 暂时关掉 pane 仍保留游标；服务端切换时由 disconnectAll 统一清理。
      this.pendingLiveMessages.delete(sessionId)
      this.diagnostics.forget(sessionId)
      this.clearRefreshTimers(sessionId)
      liveToolOutputStore.clearSession(sessionId)
      toolInteractionStore.clearSession(sessionId)
      ompSubagentStore.clearSession(sessionId)
      extensionUiStore.remove(sessionId)
      bashPendingStore.clearSession(sessionId)
      piCommandStore.clearSession(sessionId)
      this.liveRecoveryAt.delete(sessionId)
      if (this.refCounts.size === 0) this.activityWatchdog.stop()
    } else {
      this.refCounts.set(sessionId, count - 1)
      return
    }
    if (!this.hasSubscriptions()) {
      this.closeSocket()
    } else if (this.ws?.readyState === PI_SOCKET_OPEN) {
      this.sendSubscribe()
    }
  }

  connectWorkspace(workspacePath: string): void {
    const count = (this.workspaceRefCounts.get(workspacePath) ?? 0) + 1
    this.workspaceRefCounts.set(workspacePath, count)
    if (count === 1) {
      this.ensureSocket()
      if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
    }
  }

  disconnectWorkspace(workspacePath: string): void {
    const count = this.workspaceRefCounts.get(workspacePath) ?? 0
    if (count <= 1) this.workspaceRefCounts.delete(workspacePath)
    else this.workspaceRefCounts.set(workspacePath, count - 1)
    if (!this.hasSubscriptions()) this.closeSocket()
    else if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
  }

  private managementWatched = false

  /**
   * Keep provider streams (auth flows) subscribed whenever providers are
   * tracked, even with no session connected — the socket stays up for them.
   */
  private ensureManagementWatch(): void {
    if (this.managementWatched) return
    this.managementWatched = true
    subscribeManagementStreams(() => {
      if (getTrackedManagementProviders().length > 0) {
        this.ensureSocket()
        if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
      } else if (!this.hasSubscriptions()) {
        this.closeSocket()
      }
    })
  }

  /** Drop everything (server switch etc.). */
  disconnectAll(): void {
    this.diagnostics.record('disconnect', { reason: 'server_switch_or_reset' })
    for (const sessionId of new Set([...this.refCounts.keys(), ...this.stateRefreshTimers.keys(), ...this.branchRefreshTimers.keys(), ...this.diskRefreshTimers.keys()])) this.clearRefreshTimers(sessionId)
    this.refCounts.clear()
    this.activityWatchdog.stop()
    piBranchStore.clearAll()
    clearSubagentTranscripts()
    this.subagentSeen.clear()
    this.workspaceRefCounts.clear()
    this.cursors.clear()
    this.reconnectAttempts = 0
    this.pendingLiveMessages.clear()
    piCommandStore.clearAll()
    ompSubagentStore.clearAll()
    for (const sessionId of this.refCounts.keys()) extensionUiStore.remove(sessionId)
    extensionUiStore.reset()
    extensionDiagnosticStore.reset()
    bashPendingStore.clearAll()
    liveToolOutputStore.clearAll()
    toolInteractionStore.clearAll()
    this.liveRecoveryAt.clear()
    this.liveRecoveryFlights.clear()
    for (const recovery of this.commandRecoveries.values()) recovery.controller?.abort()
    this.commandRecoveries.clear()
    this.resyncGeneration++
    for (const controller of this.resyncControllers.values()) controller.abort()
    this.resyncControllers.clear()
    this.incompleteResync.clear()
    for (const key of this.resyncRetries.keys()) this.clearResyncRetry(key)
    this.pendingResync.clear()
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
    this.resyncTimer = null
    this.resyncFlights.clear()
    this.resyncActive = 0
    this.closeSocket()
  }

  /** Replace every subscription when the active backend changes. */
  handleServerChange(): void {
    this.disconnectAll()
    this.knownActiveSessions.clear()
    if (getTrackedManagementProviders().length > 0) {
      this.ensureSocket()
      if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
    }
  }

  private clearRefreshTimers(sessionId: string): void {
    const diskTimer = this.diskRefreshTimers.get(sessionId)
    if (diskTimer) clearTimeout(diskTimer.timer)
    this.diskRefreshTimers.delete(sessionId)
    const branchTimer = this.branchRefreshTimers.get(sessionId)
    if (branchTimer) {
      clearTimeout(branchTimer)
      this.branchRefreshTimers.delete(sessionId)
    }
    const stateTimer = this.stateRefreshTimers.get(sessionId)
    if (stateTimer) {
      clearTimeout(stateTimer)
      this.stateRefreshTimers.delete(sessionId)
    }
  }

  private ensureSocket(): void {
    if (this.ws && this.ws.readyState !== PI_SOCKET_CLOSED && this.ws.readyState !== PI_SOCKET_CLOSING) return
    if (this.reconnectTimer || !navigator.onLine) return
    this.openSocket()
  }

  private closeSocket(reason = 'unsubscribe'): void {
    if (reason !== 'protocol_problem') this.lastProblemCode = undefined
    if (!this.hasSubscriptions()) {
      this.resyncGeneration++
      this.pendingResync.clear()
      if (this.resyncTimer) clearTimeout(this.resyncTimer)
      this.resyncTimer = null
      for (const controller of this.resyncControllers.values()) controller.abort()
      this.resyncControllers.clear()
      this.resyncFlights.clear()
      this.resyncActive = 0
      this.incompleteResync.clear()
      for (const key of this.resyncRetries.keys()) this.clearResyncRetry(key)
    }
    if (reason === 'protocol_problem') faultSocketClosed(1002)
    else faultSocketUnused()
    setEventStreamState(reason === 'protocol_problem' ? 'error' : 'unused')
    this.diagnostics.record('disconnect', { reason })
    const ws = this.ws
    this.ws = null
    this.clearPing()
    this.sentStreams.clear()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (ws && ws.readyState !== PI_SOCKET_CLOSED && ws.readyState !== PI_SOCKET_CLOSING) {
      ws.close()
    }
  }

  private openSocket(): void {
    setEventStreamState('connecting', this.reconnectAttempts)
    const url = new URL(wsEventsUrl())
    const token = getPiAuthToken()
    if (token) url.searchParams.set('token', token)

    const ws = openPiSocket(url.toString())
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      faultSocketOpened()
      setEventStreamState('connected')
      this.diagnostics.connected(this.lastCloseCode)
      this.sendSubscribe()
      for (const key of this.incompleteResync) {
        this.clearResyncRetry(key)
        this.queueResync(key)
      }
      notifyReconnected()
      this.stableTimer = setTimeout(() => {
        this.reconnectAttempts = 0
        this.lastProblemCode = undefined
      }, 30_000)
      if (this.lastCloseCode !== undefined) refreshModelSettings()
      this.pingTimer = setInterval(() => {
        this.send({ type: 'ping', protocolVersion: PROTOCOL_VERSION })
      }, PING_INTERVAL_MS)
    }
    ws.onmessage = e => {
      // A stale socket may still deliver buffered frames after closeSocket()
      // swapped this.ws (server switch). Ignore messages from any socket that
      // is no longer the active one, mirroring the onclose identity check.
      if (this.ws !== ws) return
      this.handleRaw(String(e.data), e.annotateTraffic)
    }
    ws.onclose = event => {
      if (this.ws !== ws) return
      faultSocketClosed(event.code)
      setEventStreamState('disconnected', this.reconnectAttempts)
      this.clearPing()
      this.ws = null
      this.sentStreams.clear()
      markModelSettingsDisconnected()
      this.lastCloseCode = event.code
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // close follows; reconnect handled there
    }
  }

  private scheduleReconnect(): void {
    if (!this.hasSubscriptions() || this.reconnectTimer || !navigator.onLine || document.visibilityState === 'hidden') return
    const delay = this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS
      ? retryDelay(0, RECONNECT_PROBE_MS, RECONNECT_PROBE_MS)
      : retryDelay(this.reconnectAttempts++, RECONNECT_DELAY_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.ws && this.hasSubscriptions() && navigator.onLine && document.visibilityState !== 'hidden') this.openSocket()
    }, delay)
  }

  private sendSubscribe(): void {
    if (this.subscribeQueued) return
    this.subscribeQueued = true
    queueMicrotask(() => {
      this.subscribeQueued = false
      if (this.ws?.readyState === PI_SOCKET_OPEN) this.flushSubscribe()
    })
  }

  private flushSubscribe(): void {
    const streams: EventStreamRef[] = [{ kind: 'server', id: 'server' }]
    const cursors: EventCursorMap = {}
    const serverCursor = this.cursors.get('server')
    if (serverCursor) cursors.server = serverCursor
    for (const sessionId of this.refCounts.keys()) {
      const stream = { kind: 'session' as const, id: sessionId }
      streams.push(stream)
      const key = eventStreamKey(stream)
      // A branch/open checkpoint predates the first prompt, even when the
      // pane subscribes after a fast native command has already completed.
      const cursor = this.cursors.get(key) ?? piBranchStore.getData(sessionId)?.checkpoint?.position
      if (cursor) {
        this.cursors.set(key, cursor)
        cursors[key] = cursor
      }
    }
    for (const workspacePath of this.workspaceRefCounts.keys()) {
      const stream = { kind: 'workspace' as const, id: workspacePath }
      streams.push(stream)
      const key = eventStreamKey(stream)
      const cursor = this.cursors.get(key)
      if (cursor) cursors[key] = cursor
    }
    for (const providerId of getTrackedManagementProviders()) {
      const stream = { kind: 'provider' as const, id: providerId }
      streams.push(stream)
      const cursor = this.cursors.get(eventStreamKey(stream))
      if (cursor) cursors[eventStreamKey(stream)] = cursor
    }
    this.send({ type: 'subscribe', protocolVersion: PROTOCOL_VERSION, streams, cursors })

    // 主动把订阅中 session 的运行时 state 拿回来：页面刷新 / ws 重连后
    // state store 是空的，而它只依赖“新事件到达后被动拉取” —— 活跃中的
    // worker 不推新事件（等待权限 / 单条消息在队列里）时 isStreaming、队列、
    // 上下文用量永远不恢复。每次订阅建立都主动 pull 一次（有防抖合并），
    // 让打开/刷新会话时立即拿到正在工作的 runtime 的真实状态。
    for (const sessionId of this.refCounts.keys()) {
      if (!this.sentStreams.has(eventStreamKey({ kind: 'session', id: sessionId })))
        this.scheduleStateRefresh(sessionId)
    }
    this.sentStreams = new Set(streams.map(eventStreamKey))
    for (const [commandId, recovery] of this.commandRecoveries) {
      if (this.sentStreams.has(recovery.key)) this.recoverCommand(commandId, recovery)
    }
  }

  private send(message: unknown): void {
    if (this.ws?.readyState === PI_SOCKET_OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  private handleRaw(raw: string, annotateTraffic?: (parsed: unknown) => void): void {
    let message: EventServerMessage
    try {
      message = JSON.parse(raw) as EventServerMessage
    } catch {
      return
    }
    annotateTraffic?.(message)
    if ('channel' in message && message.channel === 'control' && message.type === 'payload_omitted') {
      this.handleOmittedPayload(message)
      return
    }
    if ('channel' in message && message.channel === 'event') {
      this.handleEvent(message.event)
      return
    }
    if ('channel' in message && message.channel === 'control' && message.type === 'resync_required') {
      for (const key of Object.keys(message.streams)) {
        this.queueResync(key, message.streams[key as EventStreamKey]?.cursor)
      }
      return
    }
    if ('channel' in message && message.channel === 'control' && message.type === 'problem') {
      this.closeSocket('protocol_problem')
      this.lastCloseCode = 1002
      this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS
      this.scheduleReconnect()
      if (this.lastProblemCode !== message.problem.code) {
        this.lastProblemCode = message.problem.code
        notificationStore.push('error', i18n.t('common:eventStreamError'),
          `${message.problem.code}: ${message.problem.message}\n${i18n.t('common:eventStreamRecovery')}`, '')
      }
      window.dispatchEvent(new CustomEvent('ompiui:event-stream-error', { detail: message.problem }))
    }
  }

  private handleOmittedPayload(message: Extract<EventServerMessage, { type: 'payload_omitted' }>): void {
    const { stream, eventChannel, commandId } = message
    const key = eventStreamKey(stream)
    // 有序控制帧确认传输进度；HTTP 恢复的成败不能回退游标。
    this.advanceCursor(key, message.cursor)
    if (eventChannel === 'command.updated' && commandId) {
      let recovery = this.commandRecoveries.get(commandId)
      if (!recovery || recovery.key !== key || recovery.cursor.epoch !== message.cursor.epoch) {
        recovery?.controller?.abort()
        recovery = { key, cursor: message.cursor, generation: serverStore.getActiveServerGeneration() }
        this.commandRecoveries.set(commandId, recovery)
      } else if (message.cursor.sequence > recovery.cursor.sequence) {
        recovery.cursor = message.cursor
      }
      this.recoverCommand(commandId, recovery)
    } else {
      if (eventChannel.startsWith('terminal.')) {
        window.dispatchEvent(new CustomEvent('ompiui:terminals-changed'))
      } else if (eventChannel === 'omp.subagent') {
        // 实时子代理帧过大时服务端只发送控制帧；事件本身无法恢复，
        // 需要主动拉取权威 state（其中包含子代理快照），否则工具会永久停在旧状态。
        if (stream.kind === 'session') this.scheduleStateRefresh(stream.id)
        else for (const sessionId of this.refCounts.keys()) this.scheduleStateRefresh(sessionId)
      } else if (eventChannel === 'resources.updated') {
        receiveResourceRevision(stream.kind === 'workspace' || stream.kind === 'resources' ? stream.id : undefined, String(Date.now()))
      } else if (eventChannel === 'models.updated') {
        receiveProviderAuthUpdated()
        refreshModelSettings()
        // 供应商设置页直接持有 draft 副本，必须重读，否则过期草稿会把外部改动写回。
        window.dispatchEvent(new CustomEvent('ompiui:models-updated'))
      } else {
        if (stream.kind === 'session') this.scheduleBranchRefresh(stream.id)
        else this.queueResync(eventStreamKey(stream))
      }
    }
  }

  private recoverCommand(commandId: string, recovery: CommandRecovery): void {
    if (recovery.controller) return
    const controller = new AbortController()
    const cursor = recovery.cursor
    recovery.controller = controller
    void piFetch(
      `${getApiBase()}/api/v1/host/commands/${encodeURIComponent(commandId)}`,
      { signal: controller.signal },
    ).then(async response => {
      if (!response.ok) throw new Error(`Command recovery failed: ${response.status}`)
      const body: unknown = await response.json()
      if (!isJsonObject(body) || !isCommandRecord(body.command) || body.command.id !== commandId) {
        throw new Error('Invalid command recovery response')
      }
      return body.command
    }).then(command => {
      if (
        this.commandRecoveries.get(commandId) !== recovery || controller.signal.aborted ||
        serverStore.getActiveServerGeneration() !== recovery.generation ||
        this.cursors.get(recovery.key)?.epoch !== cursor.epoch || recovery.cursor !== cursor
      ) return
      this.commandRecoveries.delete(commandId)
      piCommandStore.upsert(command)
      window.dispatchEvent(new CustomEvent('ompiui:command-updated', { detail: command }))
    }).catch(() => {
      // 保留业务恢复项，下一次订阅重试 HTTP；不借旧传输游标重放已消费事件。
    }).finally(() => {
      if (recovery.controller !== controller) return
      recovery.controller = undefined
      if (this.commandRecoveries.get(commandId) === recovery && recovery.cursor !== cursor) {
        this.recoverCommand(commandId, recovery)
      }
    })
  }

  private advanceCursor(key: string, cursor: EventCursor): void {
    const previous = this.cursors.get(key)
    if (previous?.epoch === cursor.epoch && previous.sequence >= cursor.sequence) return
    this.cursors.set(key, cursor)
    if (!previous || previous.epoch === cursor.epoch) return
    for (const [commandId, recovery] of this.commandRecoveries) {
      if (recovery.key !== key) continue
      this.commandRecoveries.delete(commandId)
      recovery.controller?.abort()
    }
  }

  private handleEvent(envelope: EventEnvelope): void {
    const sessionId = envelope.stream.kind === 'session' ? envelope.stream.id : null
    this.advanceCursor(eventStreamKey(envelope.stream), envelope.cursor)
    switch (envelope.channel) {
      case 'payload.omitted':
        recordClientDiagnostic('worker_payload_omitted', { sessionId, errorCode: 'WORKER_EVENT_TOO_LARGE' })
        this.queueResync(eventStreamKey(envelope.stream))
        if (!sessionId && isJsonObject(envelope.payload) && envelope.payload.channel === 'models.updated') refreshModelSettings()
        break
      case 'omp.extension_error':
        if (envelope.stream.kind === 'server') extensionDiagnosticStore.addNativeEvent(envelope.payload)
        break
      case 'pi.event':
        if (sessionId) this.handlePiEvent(sessionId, envelope.payload as unknown as PiEventPayload)
        break
      case 'session.head':
        // head 移动 = 树形（undo/redo/导航）变化：branch（时间线）和
        // state（leafId/指纹）都过期了。state 不刷的话会话树面板和
        // redo 计划都感知不到别处的导航，双向联动就断了
        if (sessionId) {
          this.scheduleBranchRefresh(sessionId)
          this.scheduleStateRefresh(sessionId)
        }
        break
      case 'sessions.updated':
        this.handleSessionsUpdated(envelope.payload as SessionsUpdatedPayload | undefined)
        break
      case 'sessions.activity':
        this.handleActivitySnapshot(envelope.payload as unknown as SessionsActivitySnapshot)
        break
      case 'command.updated':
        if (isCommandRecord(envelope.payload)) {
          this.commandRecoveries.get(envelope.payload.id)?.controller?.abort()
          this.commandRecoveries.delete(envelope.payload.id)
          piCommandStore.upsert(envelope.payload)
          window.dispatchEvent(new CustomEvent('ompiui:command-updated', { detail: envelope.payload }))
        }
        break
      case 'extension.ui':
        if (sessionId) this.handleExtensionUiEvent(sessionId, envelope.payload as unknown as PiExtensionUiEvent)
        break
      case 'omp.subagent': {
        // 会话流上 sessionId 取 envelope；server 流上的注册帧镜像由 payload
        // 携带 sessionId（detached 后台子代理的父会话可能没有 pane 订阅）
        const mirrorPayload = envelope.payload as { sessionId?: unknown } | undefined
        const mirrorSessionId =
          isJsonObject(mirrorPayload) && typeof mirrorPayload.sessionId === 'string' ? mirrorPayload.sessionId : null
        const runSessionId = sessionId ?? mirrorSessionId
        if (runSessionId) this.handleOmpSubagentEvent(runSessionId, envelope.payload)
        break
      }
      case 'provider.auth':
        this.handleProviderAuthEvent(envelope.payload as unknown as ProviderAuthEvent)
        break
      case 'models.updated': {
        // models.yml 变更（手动加模型 / omp CLI 登录写入）：provider 配置与
        // 凭据同源，bump providerRevision 让管理页重拉；模型选择器的列表
        // store 直接刷新（有 flight 去重），不依赖某个组件恰好挂载
        receiveProviderAuthUpdated()
        refreshModelSettings()
        // 供应商设置页直接持有 draft 副本，必须重读，否则过期草稿会把外部改动写回。
        window.dispatchEvent(new CustomEvent('ompiui:models-updated'))
        break
      }
      case 'packages.progress':
        receivePackageProgress(envelope.payload as unknown as PackageProgress)
        break
      case 'resources.updated': {
        const payload = envelope.payload as { workspacePath?: string | null } | undefined
        receiveResourceRevision(payload?.workspacePath ?? undefined, String(envelope.cursor.sequence))
        break
      }
      case 'workspace.files':
        window.dispatchEvent(new CustomEvent('ompiui:workspace-files-changed', { detail: envelope.payload }))
        break
      case 'workspace.git':
        window.dispatchEvent(new CustomEvent('ompiui:workspace-git-updated', { detail: envelope.payload }))
        break
      case 'registry.updated': {
        const payload = envelope.payload as { sessionId?: string } | undefined
        if (sessionId || payload?.sessionId) {
          window.dispatchEvent(
            new CustomEvent('ompiui:registry-updated', {
              detail: { sessionId: sessionId ?? payload?.sessionId },
            }),
          )
        }
        break
      }
      case 'terminal.created':
      case 'terminal.updated':
      case 'terminal.exited':
      case 'terminal.deleted':
        window.dispatchEvent(
          new CustomEvent('ompiui:terminals-changed', {
            detail: { workspacePath: envelope.stream.kind === 'workspace' ? envelope.stream.id : undefined },
          }),
        )
        break
    }
  }

  private handleProviderAuthEvent(event: ProviderAuthEvent): void {
    receiveProviderAuthEvent(event)
    // Terminal auth states change providers.list — bump listeners to refetch
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
      receiveProviderAuthUpdated()
    }
  }

  private handleSessionsUpdated(payload: SessionsUpdatedPayload | undefined): void {
    if (payload?.crashed && payload.sessionId) {
      reportRuntimeCrash(payload.sessionId, payload.faultId, payload.faultTime, payload.errorCode)
      piSessionStateStore.patchState(payload.sessionId, { nativeAskDialog: false, askUi: { available: false, reason: 'runtime_unavailable' } })
      const error = payload.message?.trim() || (payload.errorCode ? `Runtime crashed: ${payload.errorCode}` : 'Runtime crashed before this tool returned a result')
      this.markSessionSettled(payload.sessionId, { kind: 'failed', error })
      ompSubagentStore.markSessionCrashed(payload.sessionId)
    }
    if (payload?.replaced && payload.sourceSessionId && payload.targetSessionId) {
      if (payload.sourceSessionId === payload.targetSessionId) {
        window.dispatchEvent(new CustomEvent('ompiui:session-relocated', { detail: payload }))
        window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
        return
      }
      if (payload.reason === 'runtime-reuse') {
        // runtime 复用（ensureAttached 偷同目录空闲 runtime）：源 session 的
        // 磁盘数据和 pane 绑定都不变，不做替换清理，只刷新会话列表。
        // 若按真实替换处理，paneLayoutStore.remapSession 会把所有绑定源
        // session 的 pane 全部切走（分屏互相串扰）。
        window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
        return
      }
      if (payload.sourceSessionId === payload.targetSessionId) {
        window.dispatchEvent(new CustomEvent('ompiui:session-relocated', { detail: payload }))
        window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
        return
      }
      // Runtime replacement (fork/new/import): the worker now owns a
      // different session id. Drop the old session's cursors and keyed
      // data; panes re-subscribe and reload under the new id when they
      // follow ompiui:session-replaced (their connect effect owns ref counts).
      this.cursors.delete(eventStreamKey({ kind: 'session', id: payload.sourceSessionId }))
      this.pendingLiveMessages.delete(payload.sourceSessionId)
      this.clearRefreshTimers(payload.sourceSessionId)
      const sourceKey = eventStreamKey({ kind: 'session', id: payload.sourceSessionId })
      this.pendingResync.delete(sourceKey)
      this.incompleteResync.delete(sourceKey)
      this.clearResyncRetry(sourceKey)
      this.resyncControllers.get(payload.sourceSessionId)?.abort()
      this.resyncControllers.delete(payload.sourceSessionId)
      this.resyncFlights.delete(payload.sourceSessionId)
      piBranchStore.clear(payload.sourceSessionId)
      piSessionStateStore.clear(payload.sourceSessionId)
      piCommandStore.clearSession(payload.sourceSessionId)
      ompSubagentStore.clearSession(payload.sourceSessionId)
      liveToolOutputStore.clearSession(payload.sourceSessionId)
      toolInteractionStore.clearSession(payload.sourceSessionId)
      extensionUiStore.remove(payload.sourceSessionId)
      activeSessionStore.removeSession(payload.sourceSessionId)
      this.liveRecoveryAt.delete(payload.sourceSessionId)
      // Invalidate reads started while the target belonged to an earlier runtime,
      // without deleting the target's own native history/resources.
      piSessionStateStore.invalidateRequests(payload.targetSessionId)
      piBranchStore.beginRequest(payload.targetSessionId)
      window.dispatchEvent(new CustomEvent('ompiui:session-replaced', { detail: payload }))
    }
    // 事件驱动刷新：SessionContext/useSessions 订阅 ompiui:sessions-changed 会
    // 各自重新拉列表（并更新 piSessionInfoStore），这里不需要再直接拉一次
    window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
  }

  private handleExtensionUiEvent(sessionId: string, event: PiExtensionUiEvent): void {
    sessionId = event.type === 'settled' ? event.sessionId : event.type === 'requested' ? event.request.sessionId : sessionId
    piSessionStateStore.invalidateRequests(sessionId)
    switch (event.type) {
      case 'requested':
        if (!extensionUiStore.requestOpened(event.request)) break
        // Surface as pending action on the sidebar (awaiting permission/answer)
        activeSessionStore.addPendingRequest(
          event.request.requestId,
          sessionId,
          event.request.kind === 'confirm' ? 'permission' : 'question',
          event.request.title,
        )
        break
      case 'settled':
        extensionUiStore.requestSettled(sessionId, event.requestId)
        activeSessionStore.resolvePendingRequest(event.requestId, sessionId)
        break
      case 'state':
        extensionUiStore.statePatched(sessionId, event.patch)
        break
      case 'editor':
        extensionUiStore.editorCommand(sessionId, event.command)
        break
      case 'notify': {
        // 扩展通知（ctx.ui.notify）是扩展命令的主要输出通道（如 /perm list 的
        // 规则列表）。完整文本进命令反馈日志；同时弹一条瞬时通知。
        // 该通知的内容只展示在右侧扩展面板里，因此点击后应跳转到对应
        // session 并打开扩展面板（target: 'extensions'）。
        const status = event.notifyType === 'error' ? 'error' : event.notifyType === 'warning' ? 'warning' : 'info'
        commandFeedbackStore.add({
          sessionId,
          command: '',
          kind: 'notify',
          source: 'Extension',
          status,
          message: event.message,
        })
        notificationStore.push(
          status,
          'Extension',
          event.message,
          sessionId,
          activeSessionStore.getSessionMeta(sessionId)?.directory,
          { target: 'extensions' },
        )
        break
      }
      case 'tuiAttach':
        extensionTuiStore.attach(event.sessionId, event.attach)
        break
      case 'tuiDetach':
        extensionTuiStore.detach(event.sessionId, event.key)
        break
      case 'tuiFrame':
        extensionTuiStore.frame(event.sessionId, event.data)
        break
    }
  }

  /**
   * Global session activity (worker-derived from SDK isStreaming/isRetrying).
   * Feeds activeSessionStore so the sidebar shows working/retrying dots.
   */
  private handleActivitySnapshot(snapshot: SessionsActivitySnapshot): void {
    const active = snapshot?.sessions ?? {}
    for (const [sessionId, status] of Object.entries(active)) {
      this.diagnostics.record('activity', { sessionId, status: status.type })
      if (!this.knownActiveSessions.has(sessionId)) notifySessionStarted(sessionId)
      activeSessionStore.updateStatus(sessionId, activityToSessionStatus(status))
    }
    // Sessions no longer active -> idle (clears their dot)
    const candidates = snapshot.delta
      ? new Set(snapshot.removed ?? [])
      : new Set([...this.knownActiveSessions, ...this.refCounts.keys()])
    for (const sessionId of candidates) {
      if (!(sessionId in active)) {
        this.diagnostics.record('activity', { sessionId, status: 'idle' })
        const state = piSessionStateStore.getState(sessionId)
        if (
          this.knownActiveSessions.has(sessionId) ||
          state?.isStreaming ||
          state?.isCompacting ||
          state?.isRetrying ||
          state?.hasPendingAsyncWork
        ) {
          // Activity is a sidebar projection, not the native settled predicate.
          // An omitted/idle agent may still have queued or async work.
          this.scheduleStateRefresh(sessionId)
        }
        activeSessionStore.updateStatus(sessionId, { type: 'idle' })
        notifySessionIdle(sessionId)
      }
    }
    if (snapshot.delta) {
      for (const id of snapshot.removed ?? []) this.knownActiveSessions.delete(id)
      for (const id of Object.keys(active)) this.knownActiveSessions.add(id)
    } else this.knownActiveSessions = new Set(Object.keys(active))
  }

  private markSessionSettled(sessionId: string, interruption?: { error: string; kind: 'failed' | 'cancelled' | 'unknown' }): void {
    this.activityWatchdog.cancel(sessionId)
    piBranchStore.interruptToolExecutions(sessionId, interruption?.error ?? 'Session settled before this tool returned a result; execution outcome is unknown', interruption?.kind ?? 'unknown')
    piSessionStateStore.patchState(sessionId, {
      isStreaming: false,
      isIdle: true,
      isRetrying: false,
      isCompacting: false,
      isBashRunning: false,
      hasPendingAsyncWork: false,
      retry: null,
      isSettled: true,
      compaction: null,
    })
    settlePiLiveMessage(sessionId)
    this.pendingLiveMessages.delete(sessionId)
  }

  private reconcileActivityFromState(sessionId: string): void {
    const state = piSessionStateStore.getState(sessionId)
    if (!state) return
    const active =
      state.isStreaming === true ||
      state.isCompacting === true ||
      state.isRetrying === true ||
      state.isBashRunning === true ||
      state.hasPendingAsyncWork === true
    if (active) {
      activeSessionStore.updateStatus(sessionId, state.isCompacting ? { type: 'compacting' } : { type: 'busy' })
      this.knownActiveSessions.add(sessionId)
      return
    }
    const queuedMessages = Number(state.pendingMessageCount ?? state.queuedMessageCount ?? 0)
    const settled = (state.isSettled === true || (state.isSettled === undefined && state.isIdle === true)) && queuedMessages === 0
    if (settled) {
      const interruption = isJsonObject(state.toolInterruption) ? state.toolInterruption : undefined
      this.markSessionSettled(sessionId, interruption && typeof interruption.error === 'string' ? { error: interruption.error, kind: interruption.kind === 'failed' || interruption.kind === 'cancelled' ? interruption.kind : 'unknown' } : undefined)
    }
    if (settled || (state.isStreaming === false && queuedMessages > 0)) {
      // Stopped foreground and a retained native queue are not full settle.
      // Clear only the executing projection; preserve queue/state and watchdog.
      activeSessionStore.updateStatus(sessionId, { type: 'idle' })
      this.knownActiveSessions.delete(sessionId)
    }
  }

  private knownActiveSessions = new Set<string>()

  /** OMP 子代理帧（lifecycle/progress/event）→ ompSubagentStore */
  private handleOmpSubagentEvent(sessionId: string, payload: unknown): void {
    if (!isJsonObject(payload)) return
    const kind = typeof payload.kind === 'string' ? payload.kind : ''
    const inner = payload.payload
    if (!isJsonObject(inner)) return
    if (typeof payload.eventId === 'string') {
      const key = JSON.stringify([sessionId, inner.runId, payload.eventId])
      if (this.subagentSeen.has(key)) return
      this.subagentSeen.add(key)
      if (this.subagentSeen.size > 1024) this.subagentSeen.delete(this.subagentSeen.values().next().value!)
    }
    switch (kind) {
      case 'observation':
        ompSubagentStore.applyObservation(sessionId, inner)
        break
      case 'lifecycle':
        ompSubagentStore.applyLifecycle(sessionId, inner)
        break
      case 'progress':
        ompSubagentStore.applyProgress(sessionId, inner)
        break
      case 'event':
        ompSubagentStore.applyEvent(sessionId, inner, typeof payload.eventId === 'string' ? payload.eventId : undefined)
        break
    }
  }

  private handlePiEvent(sessionId: string, payload: PiEventPayload): void {
    const { event, meta } = payload
    const patch = event as unknown as JsonObject
    if (patch.type === 'message_patch' && isJsonObject(patch.block)) {
      const current =
        this.pendingLiveMessages.get(sessionId)?.liveMessage ??
        piBranchStore.getData(sessionId)?.checkpoint?.liveMessage
      if (
        current?.id === meta.liveMessage?.id &&
        current &&
        meta.liveMessage &&
        (current.revision > meta.liveMessage.revision ||
          (current.complete && current.revision === meta.liveMessage.revision))
      )
        return
      const currentMessage = current?.message as unknown as JsonObject | undefined
      const content =
        current && current.id === meta.liveMessage?.id && Array.isArray(currentMessage?.content)
          ? [...currentMessage.content]
          : []
      const index = Number(patch.index)
      // 缺少前序块时先恢复快照，不能把带空位的数组交给聊天渲染。
      if (index > content.length) {
        this.recoverLiveMessage(sessionId)
        return
      }
      const block = patch.block
      if (patch.field === 'arguments' && typeof patch.argument === 'string') {
        const previous = isJsonObject(content[index]) ? content[index] : undefined
        const oldArgs = previous && isJsonObject(previous.arguments) ? previous.arguments : {}
        const args = { ...oldArgs }
        if (Array.isArray(patch.argumentKeys))
          for (const key of Object.keys(args)) {
            if (!patch.argumentKeys.includes(key)) delete args[key]
          }
        const before = typeof args[patch.argument] === 'string' ? String(args[patch.argument]) : ''
        if (typeof patch.delta === 'string') {
          const offset = Number(patch.offset)
          if (offset > before.length) {
            this.recoverLiveMessage(sessionId)
            return
          }
          Object.defineProperty(args, patch.argument, {
            value: before.slice(0, offset) + patch.delta,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        } else
          Object.defineProperty(args, patch.argument, {
            value: patch.value,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        content[index] = { ...block, arguments: args }
      } else if (typeof patch.field === 'string' && typeof patch.delta === 'string') {
        const previous = isJsonObject(content[index]) ? content[index] : undefined
        const previousText = previous?.[patch.field]
        const text = typeof previousText === 'string' ? previousText : ''
        const offset = Number(patch.offset)
        if (offset > text.length) {
          this.recoverLiveMessage(sessionId)
          return
        }
        content[index] = { ...block, [patch.field]: text.slice(0, offset) + patch.delta } as never
      } else content[index] = block as never
      // 总块数包含尚未到达的后续帧，只用于裁剪，不能提前扩长数组。
      if (typeof patch.blockCount === 'number' && patch.blockCount < content.length) content.length = patch.blockCount
      this.updateLiveMessage(
        sessionId,
        { ...(patch.metadata as JsonObject), content } as unknown as AgentMessage,
        meta,
        'streaming',
        Boolean(patch.complete),
      )
      return
    }
    switch (event.type) {
      case 'command_output':
      case 'extension_error':
      case 'prompt_result': {
        const feedback = commandFeedbackStore.addNativeEvent(sessionId, patch)
        if (feedback) notificationStore.push(feedback.status === 'ok' ? 'completed' : feedback.status, feedback.source ?? 'Native command', feedback.message, sessionId, activeSessionStore.getSessionMeta(sessionId)?.directory, { target: 'extensions' })
        // Manual native commands can enter compaction without auto-compaction
        // lifecycle events; read the native state instead of inferring activity.
        if (event.type === 'prompt_result' || event.type === 'command_output') this.scheduleStateRefresh(sessionId)
        break
      }
      case 'notice':
      case 'rpc_frame_error':
      case 'rpc_stream_error': {
        const message = event.type !== 'notice' && typeof patch.error === 'string' ? patch.error : typeof patch.text === 'string' ? patch.text : typeof patch.message === 'string' ? patch.message : typeof patch.error === 'string' ? patch.error : ''
        const source = typeof patch.source === 'string' ? patch.source : 'OMP runtime'
        const status = patch.level === 'error' || patch.type === 'rpc_frame_error' || patch.type === 'rpc_stream_error' ? 'error' : patch.level === 'warning' ? 'warning' : 'info'
        commandFeedbackStore.add({
          sessionId, command: '', kind: 'notify', status, source, message,
          originalType: typeof patch.originalType === 'string' ? patch.originalType : undefined,
          context: typeof patch.text === 'string' && patch.text !== message ? patch.text : undefined,
        })
        notificationStore.push(status, source, message, sessionId, activeSessionStore.getSessionMeta(sessionId)?.directory, { target: 'extensions' })
        break
      }
      case 'config_update': {
        const patch: JsonObject = {}
        if (isJsonObject(event.model)) patch.model = event.model
        if (typeof event.thinkingLevel === 'string') patch.thinkingLevel = event.thinkingLevel
        piSessionStateStore.patchState(sessionId, patch)
        this.scheduleStateRefresh(sessionId)
        break
      }
      case 'message_start':
      case 'message_update':
        this.updateLiveMessage(sessionId, event.message, meta)
        break
      case 'message_end':
        if (event.message.role === 'assistant') {
          this.updateLiveMessage(sessionId, event.message, meta, 'persisting')
        }
        if (event.message.role === 'toolResult') {
          piBranchStore.patchToolExecution(sessionId, event.message.toolCallId, { isRunning: false, result: event.message })
          liveToolOutputStore.delete(event.message.toolCallId)
          toolInteractionStore.delete(event.message.toolCallId, sessionId)
        }
        this.scheduleBranchRefresh(sessionId)
        break
      case 'turn_end':
      case 'entry_appended':
      case 'irc_message':
        this.scheduleBranchRefresh(sessionId)
        break
      case 'tool_execution_start':
        piBranchStore.patchToolExecution(sessionId, event.toolCallId, {
          isRunning: true,
          // Official start frames carry no timestamp; persisted custom data replaces this observation on refresh.
          startedAt: serverStore.getActiveCalibratedNow() ?? Date.now(),
          call: { type: 'toolCall', id: event.toolCallId, name: event.toolName, arguments: event.args },
        })
        this.scheduleBranchRefresh(sessionId)
        break
      case 'tool_execution_end':
        if ('toolCallId' in event && typeof event.toolCallId === 'string') {
          liveToolOutputStore.delete(event.toolCallId)
          toolInteractionStore.delete(event.toolCallId, sessionId)
          const timestamp = serverStore.getActiveCalibratedNow() ?? Date.now()
          piBranchStore.patchToolExecution(sessionId, event.toolCallId, {
            isRunning: false, completedAt: timestamp,
            call: piBranchStore.getData(sessionId)?.client?.toolExecutions?.[event.toolCallId]?.call ?? { type: 'toolCall', id: event.toolCallId, name: event.toolName, arguments: {} },
            ...(event.isError && !(isJsonObject(event.result) && Array.isArray(event.result.content)) ? { error: typeof event.result === 'string' ? event.result : 'Tool execution failed without a result payload' } : {}),
          })
          if (isJsonObject(event.result) && Array.isArray(event.result.content)) {
            piBranchStore.patchToolExecution(sessionId, event.toolCallId, {
              isRunning: false,
              result: {
                role: 'toolResult', toolCallId: event.toolCallId, toolName: event.toolName,
                content: event.result.content as unknown as ToolResultMessage['content'],
                details: event.result.details,
                isError: event.isError === true || event.result.isError === true,
                timestamp: typeof event.result.timestamp === 'number' ? event.result.timestamp : serverStore.getActiveCalibratedNow() ?? Date.now(),
              },
            })
          }
        }
        this.scheduleBranchRefresh(sessionId)
        this.scheduleStateRefresh(sessionId)
        break
      case 'tool_execution_update': {
        if ('toolCallId' in event && typeof event.toolCallId === 'string') {
          const accepted = piBranchStore.patchToolExecution(sessionId, event.toolCallId, {
            isRunning: true,
            ...(typeof event.toolName === 'string' && isJsonObject(event.args) ? { call: { type: 'toolCall' as const, id: event.toolCallId, name: event.toolName, arguments: event.args } } : {}),
          })
          if (!accepted) break
          const partial = 'partialResult' in event ? event.partialResult : undefined
          if (isJsonObject(partial) && isJsonObject(partial.details)) {
            toolInteractionStore.set(event.toolCallId, sessionId, partial.details.toolInteraction)
          }
          const text = extractToolExecutionText(partial)
          if (text) liveToolOutputStore.set(event.toolCallId, sessionId, text)
        }
        // 输出进度由事件直接更新；状态在工具结束等边界刷新，避免每帧再拉完整快照。
        break
      }
      case 'bash_execution_update': {
        // 用户 `!cmd`/`/bash` 的流式输出（pi TUI onChunk 的事件流对应物）。
        // id = worker 透传的 clientId，delta 是增量 chunk。
        if (
          'id' in event &&
          typeof event.id === 'string' &&
          event.id &&
          'delta' in event &&
          typeof event.delta === 'string'
        ) {
          liveToolOutputStore.append(event.id, sessionId, event.delta)
        }
        piSessionStateStore.patchState(sessionId, { isBashRunning: true, isIdle: false })
        break
      }
      case 'agent_settled':
        this.markSessionSettled(sessionId, isJsonObject(patch.toolInterruption) && typeof patch.toolInterruption.error === 'string' ? { error: patch.toolInterruption.error, kind: patch.toolInterruption.kind === 'failed' || patch.toolInterruption.kind === 'cancelled' ? patch.toolInterruption.kind : 'unknown' } : undefined)
        activeSessionStore.updateStatus(sessionId, { type: 'idle' })
        this.knownActiveSessions.delete(sessionId)
        this.scheduleBranchRefresh(sessionId)
        this.scheduleStateRefresh(sessionId)
        notifySessionIdle(sessionId)
        break
      case 'agent_end':
        if (patch.awaitingAsyncWork === true) {
          piSessionStateStore.patchState(sessionId, { isStreaming: false, isIdle: false, isSettled: false, hasPendingAsyncWork: true })
        } else if (patch.isTerminal !== false) piSessionStateStore.patchState(sessionId, { isStreaming: false })
        this.pendingLiveMessages.delete(sessionId)
        this.scheduleBranchRefresh(sessionId)
        this.scheduleStateRefresh(sessionId)
        if (patch.isTerminal !== false && patch.awaitingAsyncWork !== true) notifySessionIdle(sessionId)
        break
      case 'agent_start':
        piBranchStore.beginToolExecutions(sessionId)
        piSessionStateStore.patchState(sessionId, { isStreaming: true, isIdle: false, isSettled: false })
        activeSessionStore.updateStatus(sessionId, { type: 'busy' })
        this.knownActiveSessions.add(sessionId)
        notifySessionStarted(sessionId)
        this.scheduleStateRefresh(sessionId)
        break
      case 'turn_start':
      case 'model_changed':
      case 'thinking_level_changed':
      case 'session_info_changed':
      case 'queue_update':
      case 'compaction_start':
      case 'compaction_end':
        piSessionStateStore.beginRequest(sessionId)
        this.scheduleStateRefresh(sessionId)
        // 压缩结束会改写会话（插入 compaction 摘要条目）：强制刷新分支，
        // 让"上下文已压缩"分隔线出现在聊天流里，而不是等不可靠的
        // entry_appended 事件。
        if (event.type === 'compaction_end') this.scheduleBranchRefresh(sessionId)
        break
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
      case 'goal_updated':
        this.scheduleStateRefresh(sessionId)
        break
    }
  }

  private updateLiveMessage(
    sessionId: string,
    message: AgentMessage,
    meta: PiEventPayload['meta'],
    phase: PiLiveMessage['phase'] = 'streaming',
    complete = true,
  ): void {
    perfMark('ompiui:event-message-update')
    const liveMessage: PiLiveMessage = {
      id: meta.liveMessage?.id ?? `live-${meta.sequence}`,
      revision: meta.liveMessage?.revision ?? meta.sequence,
      phase,
      message,
      complete,
    }
    const data = piBranchStore.getData(sessionId)
    if (!data) {
      // On a page refresh the socket can replay frames before session.preview
      // hydrates the keyed branch store. Keep the newest frame and hydrate it
      // through the same branch refresh instead of dropping the live turn.
      this.pendingLiveMessages.set(sessionId, { liveMessage, position: { epoch: meta.epoch, sequence: meta.sequence } })
      this.scheduleBranchRefresh(sessionId)
      return
    }
    this.applyLiveMessage(sessionId, liveMessage, meta)
  }

  private applyLiveMessage(sessionId: string, liveMessage: PiLiveMessage, position: EventCursor): void {
    // checkpoint 可随首个流式帧创建；游标必须来自事件，不能使用历史 head 的版本。
    piBranchStore.setLiveCheckpoint(sessionId, {
      position: { epoch: position.epoch, sequence: position.sequence },
      liveMessage,
    })
  }

  private flushPendingLiveMessage(sessionId: string): void {
    const pending = this.pendingLiveMessages.get(sessionId)
    const data = piBranchStore.getData(sessionId)
    if (!pending || !data) return
    this.pendingLiveMessages.delete(sessionId)
    const current = data.checkpoint?.position
    const live = data.checkpoint?.liveMessage
    if (live?.id === pending.liveMessage.id && live.complete && live.revision >= pending.liveMessage.revision) return
    if (current && (current.epoch !== pending.position.epoch || current.sequence >= pending.position.sequence)) return
    this.applyLiveMessage(sessionId, pending.liveMessage, pending.position)
  }
  private handleResync(key: string): Promise<void> {
    const stream = parseEventStreamKey(key)
    if (!stream) return Promise.resolve()
    if (stream.kind !== 'session') this.incompleteResync.delete(key)
    if (stream.kind === 'session') {
      const existing = this.resyncFlights.get(stream.id)
      if (existing) return existing
      const generation = this.resyncGeneration
      const controller = new AbortController()
      this.resyncControllers.set(stream.id, controller)
      // Preview includes the checkpoint for an attached runtime. External
      // histories stay disk-only; neither refresh is allowed to spawn a writer.
      const refresh = piBranchStore.getData(stream.id)
        ? refreshPiBranch(stream.id, controller.signal, { includeLiveMessage: true })
        : loadPiSessionData(stream.id, controller.signal)
      const flight = refresh
        .then(() => {
          if (this.resyncGeneration !== generation || controller.signal.aborted) return
          this.incompleteResync.delete(key)
          this.clearResyncRetry(key)
          return this.diagnostics.state(stream.id, piSessionStateStore.getState(stream.id))
        })
        .catch(error => {
          if (this.resyncGeneration !== generation || controller.signal.aborted) return
          this.incompleteResync.add(key)
          this.retryResync(key, generation)
          return this.diagnostics.error('branch_error', stream.id, error)
        })
        .then(() => {
          if (this.resyncGeneration === generation && !controller.signal.aborted && !this.incompleteResync.has(key))
            this.flushPendingLiveMessage(stream.id)
        })
        .finally(() => {
          if (this.resyncFlights.get(stream.id) === flight) this.resyncFlights.delete(stream.id)
          if (this.resyncControllers.get(stream.id) === controller) this.resyncControllers.delete(stream.id)
        })
      this.resyncFlights.set(stream.id, flight)
      // 状态刷新不能挂在 branch 请求之后：branch 慢或挂起时，实时消息的
      // streaming→persisting 收敛会被无限推迟（恢复顺序契约要求 state 可以先落地）。
      this.scheduleStateRefresh(stream.id)
      return flight
    } else if (stream.kind === 'server') {
      window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
    } else if (stream.kind === 'provider') {
      receiveProviderAuthUpdated()
    } else if (stream.kind === 'workspace') {
      window.dispatchEvent(
        new CustomEvent('ompiui:workspace-files-changed', {
          detail: { workspacePath: stream.id, changes: [], rescan: true },
        }),
      )
      window.dispatchEvent(
        new CustomEvent('ompiui:workspace-git-updated', {
          detail: { workspacePath: stream.id },
        }),
      )
    }
    return Promise.resolve()
  }

  private queueResync(key: string, cursor?: EventCursor): void {
    if (cursor) this.advanceCursor(key, cursor)
    this.incompleteResync.add(key)
    this.pendingResync.add(key)
    if (this.resyncTimer) return
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null
      this.drainResync()
    }, REFRESH_DEBOUNCE_MS)
  }

  private clearResyncRetry(key: string): void {
    clearTimeout(this.resyncRetries.get(key)?.timer)
    this.resyncRetries.delete(key)
  }

  private retryResync(key: string, generation: number): void {
    const retry = this.resyncRetries.get(key) ?? { attempts: 0 }
    if (retry.timer || retry.attempts >= 3) return
    retry.attempts++
    retry.timer = setTimeout(() => {
      retry.timer = undefined
      if (this.resyncGeneration === generation && this.incompleteResync.has(key)) this.queueResync(key)
    }, 1000 * 2 ** (retry.attempts - 1))
    this.resyncRetries.set(key, retry)
  }

  private drainResync(): void {
    const generation = this.resyncGeneration
    while (this.resyncActive < this.RESYNC_CONCURRENCY && this.pendingResync.size > 0) {
      const key = this.pendingResync.values().next().value!
      this.pendingResync.delete(key)
      this.resyncActive++
      void this.handleResync(key).finally(() => {
        if (this.resyncGeneration !== generation) return
        this.resyncActive--
        this.drainResync()
      })
    }
  }

  private scheduleBranchRefresh(sessionId: string): void {
    if (this.branchRefreshTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.branchRefreshTimers.delete(sessionId)
      void refreshPiBranch(sessionId)
        .then(() => this.flushPendingLiveMessage(sessionId))
        .catch(error => this.diagnostics.error('branch_error', sessionId, error))
    }, REFRESH_DEBOUNCE_MS)
    this.branchRefreshTimers.set(sessionId, timer)
  }

  private recoverLiveMessage(sessionId: string): void {
    if (this.liveRecoveryFlights.has(sessionId) || Date.now() < (this.liveRecoveryAt.get(sessionId) ?? 0)) return
    this.liveRecoveryAt.set(sessionId, Date.now() + 5000)
    this.liveRecoveryFlights.add(sessionId)
    void refreshPiBranch(sessionId, undefined, { includeLiveMessage: true })
      .catch(() => {})
      .finally(() => this.liveRecoveryFlights.delete(sessionId))
  }

  private scheduleStateRefresh(sessionId: string): void {
    if (this.stateRefreshTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.stateRefreshTimers.delete(sessionId)
      const serverGeneration = serverStore.getActiveServerGeneration()
      void refreshPiSessionState(sessionId)
        .then(() => {
          if (serverStore.getActiveServerGeneration() !== serverGeneration) return
          this.reconcileActivityFromState(sessionId)
          this.diagnostics.state(sessionId, piSessionStateStore.getState(sessionId))
        })
        .catch(error => this.diagnostics.error('state_error', sessionId, error))
    }, REFRESH_DEBOUNCE_MS)
    this.stateRefreshTimers.set(sessionId, timer)
  }

  private clearPing(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private hasSubscriptions(): boolean {
    return this.refCounts.size > 0 || this.workspaceRefCounts.size > 0 || getTrackedManagementProviders().length > 0
  }
}

export const piEventStream = new PiEventStream()
serverStore.onServerChange(() => piEventStream.handleServerChange())

function isCommandRecord(value: unknown): value is CommandRecord {
  if (!isJsonObject(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    (value.status === 'accepted' ||
      value.status === 'running' ||
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'cancelled' ||
      value.status === 'unknown_after_crash') &&
    typeof value.submittedAt === 'string'
  )
}

function activityToSessionStatus(status: SessionActivityStatus): SessionStatus {
  if (status.type === 'retry') {
    return { type: 'retry', attempt: status.attempt, message: status.message, next: status.next }
  }
  // compacting 保留独立类型（信息流指示/停止按钮靠它驱动），busy 算工作中
  if (status.type === 'compacting') {
    return { type: 'compacting' }
  }
  return { type: 'busy' }
}

function wsEventsUrl(): string {
  const base = getApiBase()
  if (base) return base.replace(/^http/, 'ws') + '/api/v1/events'
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/api/v1/events`
}
