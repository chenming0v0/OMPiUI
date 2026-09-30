import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync } from "node:fs"
import path from "node:path"
import type {
  ImageInput,
  JsonObject,
  JsonValue,
  RegistrySnapshot,
  SessionActivityStatus,
} from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"
import { entriesPageFromEntries, sessionHeadFromParts, type BranchCheckpoint, type EntriesPage, type LiveMessage, type SessionHead } from "../runtime/pagination.js"
import { buildSessionTreeFromEntries } from "../runtime/session-tree.js"
import type { PiEventMeta, SessionRuntime, Unsubscribe } from "../runtime.js"
import { normalizeCwd, resolveUserPath } from "./omp-catalog.js"
import { OmpExtensionUiBridge } from "./omp-extension-ui.js"
import { OMP_SDK_VERSION } from "./constants.js"
import { detectOmpVersion, isOmpVersionSupported, ompTooOldError } from "./omp-version.js"
import { OmpRpcClient, OmpRpcError, unwrapResponse, type OmpRpcFrame } from "./rpc-client.js"

/**
 * OmpRpcSession —— SessionRuntime 契约的 OMP 实现。
 *
 * 与 RealPiSession（进程内 Pi SDK）不同，这里每个会话 runtime 对应一个
 * `omp --mode rpc` 子进程，通过官方 RPC 协议（docs/rpc.md）驱动：
 *
 * - 事件：子进程 stdout 上的 AgentSessionEvent 帧原样转发为 pi.event，
 *   仅做 OMP↔Pi 命名适配（auto_compaction_* → compaction_*、
 *   session_settled → agent_settled），前端 store 零改动。
 * - 历史：get_entries 维护内存态 append-history（播种 + since 增量），
 *   branch 页 = 从 leafId 沿 parentId 回溯的活跃路径。
 * - 子代理：set_subagent_subscription events 订阅 subagent_* 帧，
 *   经 onSubagentFrame 抛给 worker 转发到 omp.subagent 通道。
 * - 扩展 UI：extension_ui_request 帧桥接到 OMPiUI 的 ExtensionUiDialogHost。
 */
export interface OmpSessionOptions {
  bin?: string
}

interface EntryRecord {
  id: string
  parentId: string | null
  timestamp: string
  [key: string]: JsonValue | undefined
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString()
    if (typeof item === "function" || typeof item === "symbol") return undefined
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack }
    return item
  })) as JsonValue
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value)
  if (!isJsonObject(json)) {
    throw Object.assign(new Error("OMP native data is not a JSON object"), { code: "NATIVE_DATA_NOT_JSON" })
  }
  return json
}

/** OMP model_change 条目用合并的 "provider/modelId"，Pi 前端读 provider+modelId —— 双写兼容 */
function adaptEntry(entry: JsonObject): JsonObject {
  if (entry.type === "model_change" && typeof entry.model === "string") {
    const slash = entry.model.indexOf("/")
    const provider = slash > 0 ? entry.model.slice(0, slash) : entry.model
    const modelId = slash > 0 ? entry.model.slice(slash + 1) : entry.model
    return { ...entry, provider, modelId }
  }
  // OMP 的 title/model_usage/session 条目是元数据噪声（session 头常见于子代理
  // jsonl 开头，get_entries 会原样返回），Pi 前端会渲染成 unknown 行 —— 丢弃。
  // 保留 id/parentId 占位（omp.dropped），分支回溯的父子链不断。
  if (entry.type === "title" || entry.type === "model_usage" || entry.type === "session" || entry.type === "session_init") {
    return { type: "omp.dropped", id: String(entry.id ?? ""), parentId: (entry.parentId as string) ?? null, timestamp: String(entry.timestamp ?? ""), droppedType: entry.type as string }
  }
  return entry
}

function unsupported(action: string): never {
  throw Object.assign(new Error(`OMP RPC does not support ${action}`), { code: "CAPABILITY_DISABLED" })
}

export class OmpRpcSession implements SessionRuntime {
  private client!: OmpRpcClient
  private readonly extensionUi = new OmpExtensionUiBridge()
  private ompOptions: OmpSessionOptions = {}
  /** 探测到的真实 omp 版本；探测失败时为 null（展示回退 OMP_SDK_VERSION） */
  private ompVersion: string | null = null

  private sessionId = ""
  private sessionFile: string | undefined
  private cwd = ""
  private sessionName: string | null = null
  private closed = false

  private readonly piEventListeners = new Set<(event: JsonObject, meta: PiEventMeta) => void>()
  private readonly headListeners = new Set<(head: SessionHead) => void>()
  private readonly activityListeners = new Set<(status: SessionActivityStatus | null) => void>()
  private readonly subagentListeners = new Set<(event: JsonObject) => void>()
  private readonly crashListeners = new Set<(error: Error) => void>()
  private readonly closeListeners = new Set<() => void>()

  // 历史条目（append 顺序）+ 活跃分支缓存
  private entries: EntryRecord[] = []
  private leafId: string | null = null
  private entriesSeeded = false
  private syncInFlight: Promise<void> = Promise.resolve()
  private syncDirty = false
  private syncTimer: NodeJS.Timeout | undefined

  private nativeRevision = 1
  private nativeFingerprint = ""
  private eventEpoch = randomUUID()
  private eventSequence = 0
  private liveMessage?: { value: LiveMessage; messageId: string | undefined; phase: "streaming" | "persisting" }

  private retryShadow: JsonObject = { phase: "idle" }
  private compactionShadow: JsonObject = { autoEnabled: true, operation: { type: "none" } }
  private lastActivity = { streaming: false, retrying: false, compacting: false }

  private modelsCache: JsonObject[] = []
  private thinkingLevelsCache: string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
  private availableCommandsCache: JsonValue = []

  private constructor() {}

  static async open(cwd: string, sessionFile?: string, options: OmpSessionOptions = {}): Promise<OmpRpcSession> {
    const session = new OmpRpcSession()
    session.cwd = normalizeCwd(cwd)
    session.ompOptions = options
    if (sessionFile) session.sessionFile = resolveUserPath(sessionFile)
    await session.start()
    return session
  }

  private async start(): Promise<void> {
    // 会话 cwd 可能已被清理（如 OMP 的子代理探针临时目录）：快速失败，给出可读错误
    if (!existsSync(this.cwd)) {
      throw Object.assign(new Error(`Session workspace no longer exists: ${this.cwd}`), { code: "SESSION_CWD_GONE" })
    }
    // 版本探测与 RPC 进程拉起并行，不增加启动延迟；探测通常已被 worker
    // 启动时的同步探测填充缓存，直接命中
    const versionProbe = detectOmpVersion(this.ompOptions.bin)
    this.client = new OmpRpcClient({
      cwd: this.cwd,
      bin: this.ompOptions.bin,
      env: { PIUI_EMBEDDED: "1" },
    })
    this.client.on("frame", frame => this.handleFrame(frame))
    this.client.on("exit", () => {
      if (this.closed) return
      const error = this.client.exitInfo.error ?? new Error("omp RPC process exited unexpectedly")
      for (const listener of this.crashListeners) listener(error)
      for (const listener of this.closeListeners) listener()
    })

    try {
      // ready 帧由协议保证是第一个 stdout 帧；协商 v2 以支持 >1MiB 分帧
      await this.client.waitForReady(30_000)
      // 版本门禁：< 18.2.11 缺 get_entries 等命令且错误响应不带 id，只能烧
      // 超时（打开会话卡 ~150s）——立刻失败并提示升级（issue #5）
      const detected = await versionProbe
      if (detected && !isOmpVersionSupported(detected)) {
        throw ompTooOldError(detected)
      }
      this.ompVersion = detected
      await this.client.request({ type: "negotiate_protocol", protocolVersion: 2 })
      // 子代理帧：lifecycle + progress + 完整事件
      await this.client.request({ type: "set_subagent_subscription", level: "events" })
      if (this.sessionFile) {
        // 绑定到指定会话文件（等价 CLI --resume <file> 的 RPC 形式）
        await this.client.request({ type: "switch_session", sessionPath: this.sessionFile }, 120_000)
      }
      await this.refreshIdentity()
      await Promise.all([this.refreshModels(), this.refreshThinkingLevels(), this.refreshAvailableCommands()])
      await this.syncEntriesNow()
      this.extensionUi.bind(this.sessionId, response => this.client.writeExtensionUiResponse(response))
    } catch (error) {
      // 启动中途失败：杀掉子进程，避免留下孤儿 omp 进程
      this.client.kill()
      throw error
    }
  }

  private async refreshIdentity(): Promise<void> {
    const state = await this.fetchState()
    this.sessionId = typeof state.sessionId === "string" ? state.sessionId : `omp-${randomUUID()}`
    this.sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined
    this.sessionName = typeof state.sessionName === "string" ? state.sessionName : null
    if (typeof state.cwd === "string") this.cwd = state.cwd
  }

  private async fetchState(): Promise<JsonObject> {
    const response = await this.client.request({ type: "get_state" }, 30_000)
    const data = unwrapResponse<JsonObject>(response)
    return isJsonObject(data) ? data : {}
  }

  private async refreshModels(): Promise<void> {
    try {
      const response = await this.client.request({ type: "get_available_models" }, 60_000)
      const data = unwrapResponse<JsonValue>(response)
      const list = isJsonObject(data) && Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : []
      this.modelsCache = list.filter(isJsonObject)
    } catch {
      this.modelsCache = []
    }
  }

  private async refreshThinkingLevels(): Promise<void> {
    try {
      const response = await this.client.request({ type: "get_available_thinking_levels" }, 30_000)
      const data = unwrapResponse<JsonValue>(response)
      const levels = isJsonObject(data) && Array.isArray(data.levels) ? data.levels : []
      const mapped = levels.map(String).filter(Boolean)
      if (mapped.length > 0) this.thinkingLevelsCache = mapped
    } catch {
      /* keep default */
    }
  }

  private async refreshAvailableCommands(): Promise<void> {
    try {
      const response = await this.client.request({ type: "get_available_commands" }, 30_000)
      const data = unwrapResponse<JsonValue>(response)
      this.availableCommandsCache = isJsonObject(data) && Array.isArray(data.commands) ? data.commands : []
    } catch {
      this.availableCommandsCache = []
    }
  }

  // ------------------------------------------------------------------ events

  private handleFrame(frame: OmpRpcFrame): void {
    const type = frame.type
    switch (type) {
      case "ready":
        return
      case "message_start":
      case "message_update":
      case "message_end": {
        this.trackLiveMessage(frame)
        this.emitPiEvent(frame)
        if (type === "message_end") this.scheduleEntrySync()
        this.emitActivityIfChanged()
        return
      }
      case "turn_start":
      case "turn_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "agent_start":
      case "agent_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "retry_fallback_applied":
      case "retry_fallback_succeeded":
      case "model_changed":
      case "thinking_level_changed":
      case "todo_reminder":
      case "todo_auto_clear":
      case "ttsr_triggered":
      case "irc_message":
      case "notice":
      case "goal_updated":
      case "bash_execution_update":
      case "session_info_changed":
      case "queue_update": {
        this.trackShadowState(frame)
        this.emitPiEvent(frame)
        if (type === "agent_end" || type === "turn_end") this.scheduleEntrySync()
        this.emitActivityIfChanged()
        return
      }
      // OMP 用 auto_compaction_*，Pi 前端监听 compaction_start/end —— 改名转发
      case "auto_compaction_start":
      case "auto_compaction_end": {
        this.trackShadowState({ ...frame, type: type === "auto_compaction_start" ? "compaction_start" : "compaction_end" })
        this.emitPiEvent({
          ...frame,
          type: type === "auto_compaction_start" ? "compaction_start" : "compaction_end",
        })
        if (type === "auto_compaction_end") this.scheduleEntrySync()
        this.emitActivityIfChanged()
        return
      }
      // OMP 的终态信号 → Pi 的 agent_settled（前端 idle/刷新依赖）
      case "session_settled": {
        // 终态时 omp 不再单独发 isStreaming=false 的状态帧：必须在事件侧复位，
        // 否则 activity 一直 busy，前端停止按钮要等下一次 state.get 轮询才解除
        this.currentStreaming = false
        this.scheduleEntrySync()
        this.emitPiEvent({ type: "agent_settled" })
        this.emitActivityIfChanged()
        return
      }
      case "prompt_result": {
        this.emitPiEvent(frame)
        return
      }
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event": {
        const kind = type === "subagent_lifecycle" ? "lifecycle" : type === "subagent_progress" ? "progress" : "event"
        const payload = toJsonObject(frame.payload ?? {})
        this.trackSubagentFrame(kind, payload)
        const event: JsonObject = { kind, payload }
        for (const listener of this.subagentListeners) listener(event)
        return
      }
      case "extension_ui_request": {
        this.extensionUi.handleOmpRequest(frame)
        return
      }
      case "extension_error":
      case "available_commands_update":
      case "command_output":
      case "session_info_update":
      case "config_update":
      case "advisor_cost_changed":
      case "host_tool_call":
      case "host_tool_cancel":
      case "host_uri_request":
      case "host_uri_cancel":
      default: {
        // 未识别/宿主侧帧：统一透传（前端 switch 未命中即忽略）
        this.emitPiEvent(frame)
        if (type === "available_commands_update") {
          this.availableCommandsCache = Array.isArray(frame.commands) ? frame.commands : []
          this.nativeFingerprint = "" // 触发 head 刷新
        }
        return
      }
    }
  }

  private emitPiEvent(event: JsonObject): void {
    const meta: PiEventMeta = {
      epoch: this.eventEpoch,
      sequence: ++this.eventSequence,
      liveMessage: this.liveMessage
        ? { id: this.liveMessage.value.id, revision: this.liveMessage.value.revision }
        : undefined,
    }
    for (const listener of this.piEventListeners) listener(event, meta)
    this.emitHeadIfChanged()
  }

  private trackLiveMessage(frame: OmpRpcFrame): void {
    const nativeMessage = isJsonObject(frame.message) ? frame.message : undefined
    const role = nativeMessage?.role
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return
    const messageId = typeof frame.messageId === "string" ? frame.messageId : undefined
    const isStart = frame.type === "message_start"
    const current = this.liveMessage
    // 同一条消息（messageId 稳定）沿用 checkpoint，前端流式行不跳 key
    const reused = current && current.messageId && messageId && current.messageId === messageId
    this.liveMessage = {
      value: {
        id: reused ? current.value.id : messageId ?? randomUUID(),
        revision: reused ? current.value.revision + 1 : 1,
        phase: frame.type === "message_end" ? "persisting" : "streaming",
        message: nativeMessage ?? null,
      },
      messageId,
      phase: frame.type === "message_end" ? "persisting" : "streaming",
    }
    if (frame.type === "message_end") {
      // 持久化交接：branch refresh 完成后清除 live 行（message_end 的
      // microtask 语义与 RealPiSession 对齐）
      queueMicrotask(() => {
        if (this.closed) return
        void this.syncEntriesNow().then(() => {
          if (this.liveMessage?.phase === "persisting") this.liveMessage = undefined
          this.emitHeadIfChanged()
        })
      })
    }
    void isStart
  }

  private trackShadowState(frame: OmpRpcFrame): void {
    switch (frame.type) {
      case "compaction_start": {
        this.compactionShadow = {
          autoEnabled: this.compactionShadow.autoEnabled,
          operation: { type: "compaction", phase: "running", reason: toJson(frame.reason) ?? null },
          lastAborted: null, lastError: null, lastNotice: null,
        }
        break
      }
      case "compaction_end": {
        this.compactionShadow = {
          ...this.compactionShadow,
          operation: { type: "none" },
          lastResult: toJson(frame.result) ?? this.compactionShadow.lastResult ?? null,
          lastAborted: Boolean(frame.aborted),
          lastError: toJson(frame.errorMessage) ?? null,
        }
        break
      }
      case "auto_retry_start": {
        const delayMs = Number(frame.delayMs) || 0
        this.retryShadow = {
          phase: "waiting",
          autoEnabled: true,
          attempt: Number(frame.attempt) || 1,
          maxAttempts: Number(frame.maxAttempts) || 0,
          delayMs,
          nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
          errorMessage: toJson(frame.errorMessage) ?? null,
        }
        break
      }
      case "agent_start": {
        if (this.retryShadow.phase === "waiting") {
          this.retryShadow = { ...this.retryShadow, phase: "running" }
        } else if (this.retryShadow.phase === "finished") {
          this.retryShadow = { phase: "idle" }
        }
        break
      }
      case "auto_retry_end": {
        this.retryShadow = {
          phase: "finished",
          success: Boolean(frame.success),
          attempt: Number(frame.attempt) || 0,
          finalError: toJson(frame.finalError) ?? null,
        }
        break
      }
      default:
        break
    }
  }

  private emitActivityIfChanged(): void {
    const streaming = this.liveMessage?.phase === "streaming" || this.lastActivity.streaming
    // 流式状态的权威判断依赖 get_state 的 isStreaming；事件驱动下用
    // agent_start/agent_end 推导（与 RealPiSession 读 SDK 同步状态等价）
    let status: SessionActivityStatus | null = null
    if (this.retryShadow.phase === "waiting" || this.retryShadow.phase === "running") {
      const nextAtIso = typeof this.retryShadow.nextAttemptAt === "string" ? this.retryShadow.nextAttemptAt : undefined
      const nextAt = nextAtIso ? Date.parse(nextAtIso) : 0
      status = {
        type: "retry",
        attempt: typeof this.retryShadow.attempt === "number" ? this.retryShadow.attempt : 1,
        message: typeof this.retryShadow.errorMessage === "string" ? this.retryShadow.errorMessage : "",
        next: Number.isFinite(nextAt) ? nextAt : 0,
      }
    } else if (this.currentStreaming) {
      status = { type: "busy" }
    } else if (isJsonObject(this.compactionShadow.operation) && this.compactionShadow.operation.type === "compaction") {
      status = { type: "compacting" }
    }
    const next = {
      streaming: status?.type === "busy",
      retrying: status?.type === "retry",
      compacting: status?.type === "compacting",
    }
    if (next.streaming === this.lastActivity.streaming && next.retrying === this.lastActivity.retrying &&
      next.compacting === this.lastActivity.compacting) {
      void streaming
      return
    }
    this.lastActivity = next
    for (const listener of this.activityListeners) listener(status)
  }

  private currentStreaming = false

  // ---------------------------------------------------------------- entries

  private scheduleEntrySync(): void {
    this.syncDirty = true
    if (this.syncTimer) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      void this.syncEntriesNow()
    }, 150)
    this.syncTimer.unref?.()
  }

  private async syncEntriesNow(): Promise<void> {
    if (this.closed) return
    this.syncDirty = false
    this.syncInFlight = this.syncInFlight.then(() => this.doSyncEntries())
    await this.syncInFlight
  }

  private async doSyncEntries(): Promise<void> {
    if (this.closed) return
    try {
      const command: JsonObject = this.entriesSeeded && this.entries.length > 0
        ? { type: "get_entries", since: this.entries[this.entries.length - 1]!.id }
        : { type: "get_entries" }
      const response = await this.client.request(command, 120_000)
      const data = unwrapResponse<JsonObject>(response)
      if (!isJsonObject(data) || !Array.isArray(data.entries)) return
      const rawEntries = data.entries.filter(isJsonObject)
      if (!this.entriesSeeded || command === ({} as JsonObject)) {
        this.entries = rawEntries.map(entry => this.recordEntry(entry))
        this.entriesSeeded = true
      } else if (rawEntries.length > 0) {
        const known = new Set(this.entries.map(entry => entry.id))
        for (const raw of rawEntries) {
          const record = this.recordEntry(raw)
          if (!known.has(record.id)) {
            this.entries.push(record)
            known.add(record.id)
          }
        }
      }
      if (typeof data.leafId === "string" || data.leafId === null) {
        this.leafId = data.leafId as string | null
      }
      this.emitHeadIfChanged()
    } catch (error) {
      if (error instanceof OmpRpcError && error.code === "unknown_since") {
        // 历史被改写（压缩/切换）：全量重播种
        this.entriesSeeded = false
        this.entries = []
        await this.doSyncEntries()
        return
      }
      throw error
    }
  }

  private recordEntry(entry: JsonObject): EntryRecord {
    const adapted = adaptEntry(entry)
    return {
      id: String(adapted.id ?? ""),
      parentId: typeof adapted.parentId === "string" ? adapted.parentId : null,
      timestamp: typeof adapted.timestamp === "string" ? adapted.timestamp : "",
      ...adapted,
    } as EntryRecord
  }

  private branchEntries(): EntryRecord[] {
    if (!this.leafId) return this.entries
    const byId = new Map(this.entries.map(entry => [entry.id, entry]))
    const path: EntryRecord[] = []
    let cursor: string | null = this.leafId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const entry = byId.get(cursor)
      if (!entry) break
      path.push(entry)
      cursor = entry.parentId
    }
    path.reverse()
    // append 顺序对齐（叶子链可能与 append 顺序不同，按 entries 里的位置排序）
    const position = new Map(this.entries.map((entry, index) => [entry.id, index]))
    path.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
    return path
  }

  private getNativeFingerprint(): string {
    const last = this.entries.at(-1)
    return `${this.entries.length}:${this.leafId ?? ""}:${last?.id ?? ""}:${last?.timestamp ?? ""}`
  }

  private emitHeadIfChanged(): void {
    const fingerprint = this.getNativeFingerprint()
    if (fingerprint === this.nativeFingerprint) return
    this.nativeFingerprint = fingerprint
    this.nativeRevision += 1
    const head = this.getHead()
    for (const listener of this.headListeners) listener(head)
  }

  getHead(): SessionHead {
    const header: JsonObject = {
      version: 3,
      id: this.sessionId,
      cwd: this.cwd,
      name: this.sessionName,
    }
    return sessionHeadFromParts({
      sdkVersion: this.ompVersion ?? OMP_SDK_VERSION,
      revision: this.nativeRevision,
      sessionFormatVersion: 3,
      header,
      leafId: this.leafId,
      entryCount: this.entries.length,
    }, [this.sessionId, header, this.entries.length])
  }

  async ensureSynced(): Promise<void> {
    if (this.syncDirty) await this.syncEntriesNow()
    await this.syncInFlight
  }

  async getEntriesPage(cursor: string | undefined, limit: number, maxBytes: number): Promise<EntriesPage> {
    await this.ensureSynced()
    return entriesPageFromEntries(this.getHead(), this.entries, { cursor, limit, maxBytes }, toJsonObject)
  }

  async getBranchPage(cursor: string | undefined, limit: number, maxBytes: number): Promise<EntriesPage> {
    await this.ensureSynced()
    const checkpoint: BranchCheckpoint | undefined = cursor ? undefined : {
      position: { epoch: this.eventEpoch, sequence: this.eventSequence },
      liveMessage: this.liveMessage?.value,
    }
    return entriesPageFromEntries(this.getHead(), this.branchEntries(), { cursor, limit, maxBytes, checkpoint }, toJsonObject)
  }

  async getTree(): Promise<JsonValue> {
    await this.ensureSynced()
    // SDK getTree() 语义：整棵树（含所有分支）的嵌套 { entry, children }，
    // 前端 sessionTreeGraph 按该形状消费（issue #10）
    return buildSessionTreeFromEntries(this.entries.map(entry => toJsonObject(entry)))
  }

  async getAttachment(entryId: string, blockIndex: number): Promise<JsonObject> {
    await this.ensureSynced()
    const entry = this.entries.find(item => item.id === entryId)
    if (!entry) throw Object.assign(new Error("entry not found"), { code: "NOT_FOUND" })
    const serialized = toJsonObject(entry)
    const message = isJsonObject(serialized.message) ? serialized.message : {}
    const content = Array.isArray(message.content) ? message.content : []
    const block = content[blockIndex]
    if (!isJsonObject(block) || block.type !== "image" || typeof block.mimeType !== "string" || typeof block.data !== "string") {
      throw Object.assign(new Error("image block not found"), { code: "NOT_FOUND" })
    }
    return { mimeType: block.mimeType, data: block.data, etag: `"${entryId}:${blockIndex}"` }
  }

  async getState(): Promise<JsonObject> {
    const [native] = await Promise.all([this.fetchState(), this.ensureSynced()])
    this.currentStreaming = Boolean(native.isStreaming)
    const model = this.resolveModelDescriptor(native.model)
    const contextUsage = isJsonObject(native.contextUsage) ? native.contextUsage : null
    let sessionStats: JsonValue = null
    try {
      const statsResponse = await this.client.request({ type: "get_session_stats" }, 15_000)
      sessionStats = toJson(unwrapResponse<JsonValue>(statsResponse) ?? null) ?? null
    } catch {
      /* stats 是增强信息 */
    }
    const head = this.getHead()
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile ?? null,
      sessionName: this.sessionName,
      cwd: this.cwd,
      model: toJson(model) ?? null,
      thinkingLevel: typeof native.thinkingLevel === "string" ? native.thinkingLevel : "off",
      isStreaming: Boolean(native.isStreaming),
      isCompacting: Boolean(native.isCompacting) ||
        (isJsonObject(this.compactionShadow.operation) && this.compactionShadow.operation.type === "compaction"),
      steeringMode: typeof native.steeringMode === "string" ? native.steeringMode : "one-at-a-time",
      followUpMode: typeof native.followUpMode === "string" ? native.followUpMode : "one-at-a-time",
      autoCompactionEnabled: Boolean(native.autoCompactionEnabled),
      autoRetryEnabled: true,
      messageCount: typeof native.messageCount === "number" ? native.messageCount : this.entries.length,
      pendingMessageCount: typeof native.queuedMessageCount === "number" ? native.queuedMessageCount : 0,
      availableThinkingLevels: this.thinkingLevelsCache,
      isIdle: !native.isStreaming && (native.isSettled !== false),
      isBashRunning: false,
      hasPendingBashMessages: false,
      isRetrying: this.retryShadow.phase === "waiting" || this.retryShadow.phase === "running",
      retryAttempt: typeof this.retryShadow.attempt === "number" ? this.retryShadow.attempt : 0,
      queue: {
        steering: [],
        followUp: [],
        steeringMode: typeof native.steeringMode === "string" ? native.steeringMode : "one-at-a-time",
        followUpMode: typeof native.followUpMode === "string" ? native.followUpMode : "one-at-a-time",
      },
      pendingExtensionUiRequests: this.extensionUi.listPending(),
      extensionUiState: this.extensionUi.getStateMirror(),
      extensionTuiPanels: [],
      supportsThinking: this.resolveSupportsThinking(native.model),
      activeTools: Array.isArray(native.dumpTools)
        ? native.dumpTools.filter(isJsonObject).map(tool => String(tool.name ?? "")).filter(Boolean)
        : [],
      scopedModels: [],
      contextUsage,
      sessionStats,
      retry: this.retryShadow,
      compaction: this.compactionShadow,
      head,
      // OMP 扩展：子代理注册表快照 + todo 阶段（前端子代理面板重连恢复用）
      subagents: this.getSubagentsSnapshot(),
      todoPhases: Array.isArray(native.todoPhases) ? native.todoPhases : [],
    }
  }

  private getSubagentsSnapshot(): JsonValue {
    // 同步快照：从 lifecycle/progress 帧累计的注册表（前端重连恢复用）
    return [...this.subagentRuns.values()]
  }

  private readonly subagentRuns = new Map<string, JsonObject>()

  private trackSubagentFrame(kind: string, payload: JsonObject): void {
    const id = typeof payload.id === "string" ? payload.id : undefined
    if (!id) return
    if (kind === "event") return
    const existing = this.subagentRuns.get(id) ?? {}
    const merged: JsonObject = { ...existing, id }
    if (kind === "lifecycle") {
      for (const key of ["agent", "agentSource", "description", "status", "sessionFile", "parentToolCallId", "index", "detached"]) {
        if (payload[key] !== undefined) merged[key] = payload[key]
      }
      if (payload.status === "started") merged.progressStatus = "running"
    } else if (kind === "progress") {
      for (const key of ["agent", "task", "assignment", "sessionFile", "parentToolCallId", "index", "detached"]) {
        if (payload[key] !== undefined) merged[key] = payload[key]
      }
      merged.progress = payload.progress ?? merged.progress
      if (isJsonObject(payload.progress) && typeof payload.progress.status === "string") {
        merged.status = payload.progress.status
      }
    }
    this.subagentRuns.set(id, merged)
  }

  private resolveModelDescriptor(model: JsonValue | undefined): JsonValue | undefined {
    if (!isJsonObject(model)) return undefined
    const provider = typeof model.provider === "string" ? model.provider : ""
    const id = typeof model.id === "string" ? model.id : ""
    const found = this.modelsCache.find(item =>
      (item.provider === provider || item.provider === undefined) && item.id === id)
    if (found) return { ...found, provider: found.provider ?? provider }
    // get_state 的 model 没有完整描述符时，用缓存的最小形状补齐
    if (provider || id) return { provider, id, name: id, reasoning: false, input: ["text"] }
    return undefined
  }

  private resolveSupportsThinking(model: JsonValue | undefined): boolean {
    if (!isJsonObject(model)) return true
    const provider = typeof model.provider === "string" ? model.provider : ""
    const id = typeof model.id === "string" ? model.id : ""
    const found = this.modelsCache.find(item =>
      (item.provider === provider || item.provider === undefined) && item.id === id)
    return Boolean(found?.reasoning ?? true)
  }

  listSkills(): JsonValue {
    return []
  }

  listPrompts(): JsonValue {
    return []
  }

  listAgentsFiles(): JsonValue {
    return []
  }

  async getRegistry(): Promise<RegistrySnapshot> {
    const native = await this.fetchState()
    const tools: RegistrySnapshot["tools"] = Array.isArray(native.dumpTools)
      ? native.dumpTools.filter(isJsonObject).map(tool => ({
        name: String(tool.name ?? ""),
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: isJsonObject(tool.parameters) ? tool.parameters : {},
      }))
      : []
    const commands: RegistrySnapshot["commands"] = Array.isArray(this.availableCommandsCache)
      ? this.availableCommandsCache.filter(isJsonObject).map(command => ({
        name: String(command.name ?? ""),
        description: typeof command.description === "string" ? command.description : "",
        sourceInfo: { source: typeof command.source === "string" ? command.source : "omp" },
      }))
      : []
    return {
      sdkVersion: this.ompVersion ?? OMP_SDK_VERSION,
      tools,
      activeTools: tools.map(tool => tool.name),
      commands,
      extensions: [],
      eventHandlers: [],
    }
  }

  // ---------------------------------------------------------------- prompting

  private assertImageSupport(images: ImageInput[] | undefined): void {
    if (!images?.length) return
    // OMP 侧 prompt 带图：模型不支持时由 OMP 报错；这里不再前置拦截
  }

  async prompt(text: string, images?: ImageInput[], options: { expandPromptTemplates?: boolean; streamingBehavior?: "steer" | "followUp" } = {}): Promise<void> {
    this.assertImageSupport(images)
    this.currentStreaming = true
    this.emitActivityIfChanged()
    try {
      const command: JsonObject = { type: "prompt", message: text }
      if (options.streamingBehavior) command.streamingBehavior = options.streamingBehavior
      if (images?.length) {
        command.images = images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }))
      }
      await this.client.request(command, 30_000)
      // prompt 只立即 ACK；完成由 prompt_result/session_settled 事件驱动
    } finally {
      this.scheduleEntrySync()
    }
  }

  async steer(text: string, images?: ImageInput[]): Promise<void> {
    this.assertImageSupport(images)
    const command: JsonObject = { type: "steer", message: text }
    if (images?.length) command.images = images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }))
    await this.client.request(command, 30_000)
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    this.assertImageSupport(images)
    const command: JsonObject = { type: "follow_up", message: text }
    if (images?.length) command.images = images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }))
    await this.client.request(command, 30_000)
  }

  async sendUserMessage(text: string, images?: ImageInput[], deliverAs?: "steer" | "followUp"): Promise<void> {
    if (deliverAs === "steer") return this.steer(text, images)
    if (deliverAs === "followUp") return this.followUp(text, images)
    return this.prompt(text, images)
  }

  async abort(): Promise<JsonValue | undefined> {
    const response = await this.client.request({ type: "abort" }, 30_000)
    return toJson(unwrapResponse(response)) ?? undefined
  }

  async newSession(parentSession?: string): Promise<JsonObject> {
    const sourceSessionId = this.sessionId
    const command: JsonObject = { type: "new_session" }
    if (parentSession) command.parentSession = parentSession
    await this.client.request(command, 60_000)
    await this.refreshIdentity()
    this.resetHistory()
    await Promise.all([this.refreshModels(), this.refreshThinkingLevels()])
    await this.syncEntriesNow()
    this.emitHeadIfChanged()
    return {
      operation: "new",
      sourceSessionId,
      targetSessionId: this.sessionId,
      targetSessionFile: this.sessionFile ?? null,
      targetCwd: this.cwd,
      cancelled: false,
    }
  }

  async switchSession(sessionPath: string, _cwdOverride?: string): Promise<JsonObject> {
    const sourceSessionId = this.sessionId
    const target = resolveUserPath(sessionPath)
    await this.client.request({ type: "switch_session", sessionPath: target }, 120_000)
    await this.refreshIdentity()
    this.resetHistory()
    await Promise.all([this.refreshModels(), this.refreshThinkingLevels()])
    await this.syncEntriesNow()
    this.emitHeadIfChanged()
    return {
      operation: "switch",
      sourceSessionId,
      targetSessionId: this.sessionId,
      targetSessionFile: this.sessionFile ?? null,
      targetCwd: this.cwd,
      cancelled: false,
    }
  }

  private resetHistory(): void {
    this.entries = []
    this.leafId = null
    this.entriesSeeded = false
    this.liveMessage = undefined
    this.eventEpoch = randomUUID()
    this.eventSequence = 0
    this.retryShadow = { phase: "idle" }
    this.compactionShadow = { autoEnabled: true, operation: { type: "none" } }
    this.extensionUi.cancelAll("session_replaced")
  }

  async fork(entryId: string, _position: "before" | "at"): Promise<JsonObject> {
    // OMP 的 branch(entryId) = 从指定条目开新分支（Pi fork 的对应物）
    const sourceSessionId = this.sessionId
    await this.client.request({ type: "branch", entryId }, 120_000)
    await this.refreshIdentity()
    this.resetHistory()
    await this.syncEntriesNow()
    this.emitHeadIfChanged()
    return {
      operation: "fork",
      sourceSessionId,
      targetSessionId: this.sessionId,
      targetSessionFile: this.sessionFile ?? null,
      targetCwd: this.cwd,
      selectedText: null,
      cancelled: false,
    }
  }

  async importSession(_inputPath: string, _cwdOverride?: string): Promise<JsonObject> {
    unsupported("session import")
  }

  async setSessionName(name: string): Promise<void> {
    await this.client.request({ type: "set_session_name", name }, 30_000)
    this.sessionName = name
    this.nativeFingerprint = ""
    this.emitHeadIfChanged()
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.client.request({ type: "set_model", provider, modelId }, 60_000)
    await Promise.all([this.refreshModels(), this.refreshThinkingLevels()])
  }

  async cycleModel(direction?: "forward" | "backward"): Promise<void> {
    await this.client.request({ type: "cycle_model" }, 60_000)
    void direction
    await Promise.all([this.refreshModels(), this.refreshThinkingLevels()])
  }

  async setScopedModels(_patterns: string[]): Promise<JsonValue | undefined> {
    // OMP RPC 无 scoped models 命令：静默接受（模型选择走 setModel）
    return undefined
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.client.request({ type: "set_thinking_level", level }, 30_000)
  }

  async cycleThinkingLevel(): Promise<JsonValue | undefined> {
    const response = await this.client.request({ type: "cycle_thinking_level" }, 30_000)
    const data = unwrapResponse<JsonValue>(response)
    return data === undefined ? undefined : toJson(data)
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.client.request({ type: "set_steering_mode", mode }, 30_000)
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.client.request({ type: "set_follow_up_mode", mode }, 30_000)
  }

  async clearQueue(): Promise<JsonValue | undefined> {
    // OMP RPC 无独立 clearQueue：返回空结果（abort 会清队列）
    return { cleared: 0 }
  }

  async compact(customInstructions?: string): Promise<JsonValue | undefined> {
    const command: JsonObject = { type: "compact" }
    if (customInstructions) command.customInstructions = customInstructions
    try {
      const response = await this.client.request(command, 300_000)
      const result = toJson(unwrapResponse(response))
      return { status: "completed", result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/nothing to compact/i.test(message)) {
        return { status: "skipped", reason: "session_too_small", message }
      }
      throw error
    }
  }

  async abortCompaction(): Promise<void> {
    // OMP RPC 无独立 abort compaction：abort 会话运行（含压缩）
    await this.abort()
  }

  async abortBranchSummary(): Promise<void> {
    await this.abort()
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.client.request({ type: "set_auto_compaction", enabled }, 30_000)
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.client.request({ type: "set_auto_retry", enabled }, 30_000)
  }

  async abortRetry(): Promise<void> {
    await this.client.request({ type: "abort_retry" }, 30_000)
  }

  async bash(command: string, _excludeFromContext = false, clientId?: string): Promise<JsonValue | undefined> {
    const normalized = command.trim()
    if (!normalized) throw Object.assign(new Error("empty bash command"), { code: "INVALID_REQUEST" })
    try {
      const response = await this.client.request({ type: "bash", command: normalized }, 600_000)
      return toJson(unwrapResponse(response)) ?? undefined
    } finally {
      void clientId
      this.scheduleEntrySync()
    }
  }

  async abortBash(): Promise<void> {
    await this.client.request({ type: "abort_bash" }, 30_000)
  }

  async setActiveTools(_toolNames: string[]): Promise<void> {
    unsupported("runtime tool activation")
  }

  async invokeTool(_name: string, _args?: JsonObject): Promise<JsonValue | undefined> {
    unsupported("direct tool invocation")
  }

  async invokeCommand(name: string, args?: string): Promise<JsonValue | undefined> {
    // OMP 的 slash 命令通过 prompt 触发；command_output 事件帧承载输出
    const message = args ? `/${name} ${args}` : `/${name}`
    await this.client.request({ type: "prompt", message }, 30_000)
    return undefined
  }

  async getCommandCompletions(_name: string, _prefix: string): Promise<JsonValue | undefined> {
    return undefined
  }

  async navigateTree(entryId: string, options: { summarize?: boolean } = {}): Promise<JsonObject> {
    if (options.summarize) unsupported("branch summary navigation")
    await this.client.request({ type: "branch", entryId }, 120_000)
    await this.refreshIdentity()
    this.resetHistory()
    await this.syncEntriesNow()
    this.emitHeadIfChanged()
    return { editorText: null, cancelled: false, aborted: false, summaryEntry: null }
  }

  async setLabel(_entryId: string, _label?: string): Promise<void> {
    // OMP RPC 无 label 条目：静默 no-op
  }

  async sendCustomMessage(customType: string, _content: never, _options: unknown): Promise<void> {
    void customType
    unsupported("custom message delivery")
  }

  async appendCustomEntry(_customType: string, _data?: JsonValue): Promise<void> {
    unsupported("custom entry append")
  }

  async exportHtml(outputPath: string): Promise<JsonValue | undefined> {
    const response = await this.client.request({ type: "export_html", outputPath }, 120_000)
    const data = unwrapResponse<JsonValue>(response)
    return toJson({ path: isJsonObject(data) && typeof data.path === "string" ? data.path : outputPath })
  }

  async exportJsonl(outputPath: string): Promise<JsonValue | undefined> {
    // 会话文件本身就是 JSONL：直接复制
    if (!this.sessionFile) throw Object.assign(new Error("session file not persisted yet"), { code: "NOT_FOUND" })
    copyFileSync(this.sessionFile, outputPath)
    return { path: outputPath }
  }

  async waitForIdle(): Promise<void> {
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      if (this.closed) return
      try {
        const native = await this.fetchState()
        const settled = native.isSettled === true ||
          (native.isStreaming === false && native.hasPendingAsyncWork === false && native.isSettled !== false)
        if (settled) return
      } catch {
        return
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }

  async reload(): Promise<void> {
    // OMP 扩展发现由子进程自管：刷新缓存即可
    await Promise.all([this.refreshModels(), this.refreshThinkingLevels(), this.refreshAvailableCommands()])
    this.nativeFingerprint = ""
    this.emitHeadIfChanged()
  }

  respondExtensionUi(requestId: string, response: JsonObject): Promise<boolean> {
    return Promise.resolve(this.extensionUi.respond(requestId, response))
  }

  async setExtensionEditorState(_text: string): Promise<void> {
    // host→extension 编辑器状态在 OMP RPC 中无对应帧：no-op
  }

  extensionTuiInput(_data: string): void {
    /* offscreen 扩展 TUI 不支持 */
  }

  extensionTuiResize(_cols: number, _rows: number): void {
    /* offscreen 扩展 TUI 不支持 */
  }

  extensionTuiRedraw(): void {
    /* offscreen 扩展 TUI 不支持 */
  }

  // ---------------------------------------------------------------- subagents

  /** 子代理帧监听（worker 转发到 omp.subagent 通道） */
  onSubagentFrame(listener: (event: JsonObject) => void): Unsubscribe {
    this.subagentListeners.add(listener)
    return () => this.subagentListeners.delete(listener)
  }

  async listSubagents(): Promise<JsonValue> {
    try {
      const response = await this.client.request({ type: "get_subagents" }, 30_000)
      const data = unwrapResponse<JsonValue>(response)
      const list = isJsonObject(data) && Array.isArray(data.subagents) ? data.subagents : Array.isArray(data) ? data : []
      for (const item of list) {
        if (isJsonObject(item) && typeof item.id === "string") {
          this.subagentRuns.set(item.id, { ...this.subagentRuns.get(item.id), ...item })
        }
      }
      return list
    } catch {
      return [...this.subagentRuns.values()]
    }
  }

  async getSubagentMessages(params: { subagentId?: string; sessionFile?: string; fromByte?: number }): Promise<JsonValue> {
    const command: JsonObject = { type: "get_subagent_messages" }
    if (params.subagentId) command.subagentId = params.subagentId
    if (params.sessionFile) command.sessionFile = params.sessionFile
    if (typeof params.fromByte === "number") command.fromByte = params.fromByte
    const response = await this.client.request(command, 60_000)
    return unwrapResponse<JsonValue>(response) ?? {}
  }

  onCrash(listener: (error: Error) => void): Unsubscribe {
    this.crashListeners.add(listener)
    return () => this.crashListeners.delete(listener)
  }

  onClose(listener: () => void): Unsubscribe {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  getCwd(): string {
    return this.cwd
  }

  /** 崩溃诊断用：omp 子进程 stderr 末尾 */
  get stderrTail(): string {
    return this.client?.stderrTail ?? ""
  }

  getSessionId(): string {
    return this.sessionId
  }

  getSessionFile(): string | undefined {
    return this.sessionFile
  }

  onPiEvent(listener: (event: JsonObject, meta: PiEventMeta) => void): Unsubscribe {
    this.piEventListeners.add(listener)
    return () => this.piEventListeners.delete(listener)
  }

  onHead(listener: (head: SessionHead) => void): Unsubscribe {
    this.headListeners.add(listener)
    // 迟到订阅者立即拿到当前 head
    listener(this.getHead())
    return () => this.headListeners.delete(listener)
  }

  onActivity(listener: (status: SessionActivityStatus | null) => void): Unsubscribe {
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }

  onExtensionUi(listener: (event: JsonObject) => void): Unsubscribe {
    return this.extensionUi.onEvent(listener as never)
  }

  onResourcesChanged(_listener: () => void): Unsubscribe {
    return () => undefined
  }

  async dispose(): Promise<void> {
    this.closed = true
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.extensionUi.cancelAll("runtime_disposed")
    this.piEventListeners.clear()
    this.headListeners.clear()
    this.activityListeners.clear()
    this.subagentListeners.clear()
    this.crashListeners.clear()
    this.closeListeners.clear()
    await this.client.close()
  }
}

export { OMP_SDK_VERSION }
