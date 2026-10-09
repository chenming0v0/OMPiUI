import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
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
import { normalizeCwd, readChildSessionMessages, resolveUserPath } from "./omp-catalog.js"
import { OmpExtensionUiBridge } from "./omp-extension-ui.js"
import { OMP_SDK_VERSION } from "./constants.js"
import { detectOmpVersion, isOmpVersionSupported, ompTooOldError } from "./omp-version.js"
import { OmpRpcClient, OmpRpcError, unwrapResponse, type OmpRpcFrame } from "./rpc-client.js"
import { assertManagedSessionFile, managedSessionDirectory } from "./managed-sessions.js"

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

type QueuedUserMessage = {
  text: string
  images?: ImageInput[]
}

type SubmittedUserMessage = {
  id: string
  message: JsonObject
  accepted: boolean
  nativeTimestamp?: number
}

// goal 续跑循环的护栏：单个目标最多自动续跑轮数 / settle 后等 entries 落地的宽限
const GOAL_MAX_CONTINUATIONS = 50
const GOAL_SETTLE_GRACE_MS = 1_000
const GOAL_COMPLETE_MARKER = "GOAL_COMPLETE"

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
  // OMP 的 title/title_change/model_usage/session 条目是元数据噪声
  // （title_change 是 18.x 的自动标题写入，标题住在侧栏/session 列表；
  // session 头常见于子代理 jsonl 开头，get_entries 会原样返回），
  // Pi 前端会渲染成 unknown 行 —— 丢弃。保留 id/parentId 占位
  // （omp.dropped），分支回溯的父子链不断。
  if (entry.type === "title" || entry.type === "title_change" || entry.type === "model_usage" || entry.type === "session" || entry.type === "session_init") {
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
  // OMP 18.x 的 RPC 没有 clear_queue。用户消息先住在 worker，回合结束后
  // 再逐条以普通 prompt 发送，因此编辑/删除不会留下已经发给 OMP 的幽灵消息。
  private userQueue: { steering: QueuedUserMessage[]; followUp: QueuedUserMessage[] } = {
    steering: [],
    followUp: [],
  }
  private userQueueDrain: Promise<void> | undefined
  private queueSubmissionInFlight = false
  private submittedMessages: SubmittedUserMessage[] = []
  // OMPiUI 轻量 goal 运行时的注册表：RPC 模式的 OMP 不注册 goal 隐藏工具、
  // 也没有 goal RPC 命令（实测 18.3.x），目标状态只能住 worker 这里。
  // 未来 OMP 若在 RPC 透出真实 goal_updated，trackShadowState 的透传仍以
  // 事件帧为准覆写本状态。经 state.get 的 goal 字段 + goal 命令到达前端。
  private goal: JsonValue = null
  private goalContinuations = 0
  private goalTurnStartedAt: number | null = null
  private lastActivity = { streaming: false, retrying: false, compacting: false }
  private abortInFlight: Promise<JsonValue | undefined> | undefined

  private modelsCache: JsonObject[] = []
  private thinkingLevelsCache: string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
  private availableCommandsCache: JsonValue = []

  private constructor() {}

  static async open(cwd: string, sessionFile?: string, options: OmpSessionOptions = {}): Promise<OmpRpcSession> {
    const session = new OmpRpcSession()
    session.cwd = normalizeCwd(cwd)
    session.ompOptions = options
    if (sessionFile) {
      session.sessionFile = resolveUserPath(sessionFile)
      assertManagedSessionFile(session.sessionFile)
    }
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
    const sessionDirectory = managedSessionDirectory(this.cwd)
    mkdirSync(sessionDirectory, { recursive: true })
    this.client = new OmpRpcClient({
      cwd: this.cwd,
      bin: this.ompOptions.bin,
      args: ["--session-dir", sessionDirectory],
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
      this.extensionUi.bind(this.sessionId, response => this.client.writeExtensionUiResponse(response))
      await Promise.all([this.refreshModels(), this.refreshThinkingLevels(), this.refreshAvailableCommands()])
      await this.syncEntriesNow()
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
        this.trackSubmittedMessage(frame)
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
        if (type === "agent_start") {
          this.currentStreaming = true
          this.onGoalTurnStart()
        }
        if (type === "agent_end") {
          this.currentStreaming = false
          this.onGoalTurnEnd()
        }
        this.trackShadowState(frame)
        // 原生队列可能包含内部 goal/扩展消息，UI 只展示可编辑的用户队列。
        const queue = this.getUserQueueSnapshot()
        this.emitPiEvent(type === "queue_update" ? { ...frame, ...queue } : frame)
        if (type === "agent_end" || type === "turn_end") this.scheduleEntrySync()
        this.emitActivityIfChanged()
        if (type === "agent_end") this.scheduleUserQueueDrain()
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
        this.onGoalSettled()
        this.scheduleUserQueueDrain()
        return
      }
      case "prompt_result": {
        if (frame.sessionSettled === true || frame.agentInvoked === false) this.currentStreaming = false
        this.emitPiEvent(frame)
        this.scheduleEntrySync()
        this.emitActivityIfChanged()
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
        }).catch(error => this.reportEntrySyncError(error))
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
      case "goal_updated": {
        this.goal = toJson(frame.goal) ?? null
        break
      }
      default:
        break
    }
  }

  private getUserQueueSnapshot() {
    return {
      steering: this.userQueue.steering.map(item => item.text),
      followUp: this.userQueue.followUp.map(item => item.text),
      steeringEntries: structuredClone(this.userQueue.steering),
      followUpEntries: structuredClone(this.userQueue.followUp),
    }
  }

  private emitUserQueueSnapshot(): void {
    const queue = this.getUserQueueSnapshot()
    this.emitPiEvent({ type: "queue_update", ...queue })
    this.emitActivityIfChanged()
  }

  private trackSubmittedMessage(frame: OmpRpcFrame): void {
    if (frame.type !== "message_start" || !isJsonObject(frame.message) || frame.message.role !== "user") return
    const message = frame.message
    const content = message.content
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(isJsonObject).filter(block => block.type === "text").map(block => block.text).join("")
      : ""
    const pending = this.submittedMessages.find(item => item.nativeTimestamp === undefined &&
      Array.isArray(item.message.content) &&
      item.message.content.filter(isJsonObject).filter(block => block.type === "text").map(block => block.text).join("") === text)
    if (!pending || typeof message.timestamp !== "number") return
    pending.nativeTimestamp = message.timestamp
    pending.message = structuredClone(message)
    if (pending.accepted) this.emitUserQueueSnapshot()
  }

  private reconcileSubmittedMessages(): void {
    const previousLength = this.submittedMessages.length
    this.submittedMessages = this.submittedMessages.filter(item => item.nativeTimestamp === undefined ||
      !this.entries.some(entry => isJsonObject(entry.message) &&
        entry.message.role === "user" && entry.message.timestamp === item.nativeTimestamp))
    if (this.submittedMessages.length !== previousLength) this.emitUserQueueSnapshot()
  }

  private async submitUserMessageNow(text: string, images?: ImageInput[]): Promise<void> {
    const pending: SubmittedUserMessage = {
      id: `submitted:${randomUUID()}`,
      message: {
        role: "user",
        content: [{ type: "text", text }, ...(images?.map(image => ({ ...image })) ?? [])],
        timestamp: Date.now(),
      },
      accepted: false,
    }
    // 原生 ACK 早于用户消息持久化；这里只记录展示快照，不额外写入模型上下文。
    this.submittedMessages.push(pending)
    try {
      if (this.currentStreaming) {
        const command: JsonObject = { type: "steer", message: text }
        if (images?.length) command.images = images.map(image => ({ ...image }))
        unwrapResponse(await this.client.request(command, 30_000))
        this.scheduleEntrySync()
      } else {
        await this.prompt(text, images)
      }
      pending.accepted = true
      this.reconcileSubmittedMessages()
    } catch (error) {
      this.submittedMessages = this.submittedMessages.filter(item => item !== pending)
      throw error
    }
    this.emitUserQueueSnapshot()
  }

  private scheduleUserQueueDrain(): void {
    if (this.closed || this.currentStreaming || this.userQueueDrain || this.queueSubmissionInFlight) return
    const next = this.userQueue.steering[0] ?? this.userQueue.followUp[0]
    if (!next) return

    this.userQueueDrain = (async () => {
      try {
        // 不携带 streamingBehavior：此时会话已空闲，普通 prompt 才会真正
        // 开始新回合。等待 prompt 被 OMP 接受后再从可编辑队列中移除。
        await this.prompt(next.text, next.images)
        const steeringIndex = this.userQueue.steering.indexOf(next)
        if (steeringIndex >= 0) this.userQueue.steering.splice(steeringIndex, 1)
        const followUpIndex = this.userQueue.followUp.indexOf(next)
        if (followUpIndex >= 0) this.userQueue.followUp.splice(followUpIndex, 1)
        this.emitUserQueueSnapshot()
      } catch (error) {
        // 保留失败消息，静默丢弃会重现“发送成功但消息消失”的问题。
        console.error("Failed to drain queued user message:", error)
      } finally {
        this.userQueueDrain = undefined
      }
    })()
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
      void this.syncEntriesNow().catch(error => this.reportEntrySyncError(error))
    }, 150)
    this.syncTimer.unref?.()
  }

  private reportEntrySyncError(error: unknown): void {
    if (this.closed) return
    console.error("Failed to synchronize OMP session history:", error)
    this.syncDirty = true
  }

  private async syncEntriesNow(): Promise<void> {
    if (this.closed) return
    this.syncDirty = false
    this.syncInFlight = this.syncInFlight.catch(() => undefined).then(() => this.doSyncEntries())
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
      if (!this.entriesSeeded) {
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
      this.reconcileSubmittedMessages()
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
      // 上游 get_state 的两个「还会被唤醒」信号，宿主回收空闲 runtime 时依赖：
      // hasPendingAsyncWork 覆盖后台 bash / async task / eval 尚未回灌的长尾，
      // isSettled 是 session_settled 的同一谓词。isBashRunning 在 OMP RPC 下
      // 恒为 false（那是 pi SDK 的用户 bang-bash 语义），后台作业只能靠这里透出。
      hasPendingAsyncWork: Boolean(native.hasPendingAsyncWork),
      isBashRunning: false,
      hasPendingBashMessages: false,
      isRetrying: this.retryShadow.phase === "waiting" || this.retryShadow.phase === "running",
      retryAttempt: typeof this.retryShadow.attempt === "number" ? this.retryShadow.attempt : 0,
      queue: {
        ...this.getUserQueueSnapshot(),
        steeringMode: typeof native.steeringMode === "string" ? native.steeringMode : "one-at-a-time",
        followUpMode: typeof native.followUpMode === "string" ? native.followUpMode : "one-at-a-time",
      },
      submittedMessages: this.submittedMessages.filter(item => item.accepted)
        .map(item => ({ id: item.id, message: structuredClone(item.message) })),
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
      // goal 运行时快照（前端目标栏用；worker 侧注册表，见 manageGoal）
      goal: this.goal,
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


  async prompt(text: string, images?: ImageInput[], options: { expandPromptTemplates?: boolean; streamingBehavior?: "steer" | "followUp" } = {}): Promise<void> {
    await this.abortInFlight
    const command: JsonObject = { type: "prompt", message: text }
    // OMP only accepts streamingBehavior while a turn is active. Treat a
    // stale follow-up/steer hint on an idle session as a normal prompt so the
    // message starts a turn instead of being parked forever.
    if (options.streamingBehavior && this.currentStreaming) command.streamingBehavior = options.streamingBehavior
    if (images?.length) command.images = images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }))
    try {
      unwrapResponse(await this.client.request(command, 30_000))
    } finally {
      this.scheduleEntrySync()
    }
  }

  async steer(text: string, images?: ImageInput[]): Promise<void> {
    await this.prompt(text, images, { streamingBehavior: "steer" })
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    await this.prompt(text, images, { streamingBehavior: "followUp" })
  }

  async sendUserMessage(text: string, images?: ImageInput[], deliverAs?: "steer" | "followUp"): Promise<void> {
    // An idle session must start a normal prompt. Forcing followUp here makes
    // OMP acknowledge the RPC but place the text in a queue with no active turn
    // to consume it — the exact "sent and swallowed" failure seen in the UI.
    if (!this.currentStreaming) {
      await this.prompt(text, images)
      return
    }

    const target = deliverAs === "steer" ? this.userQueue.steering : this.userQueue.followUp
    target.push({ text, ...(images ? { images: structuredClone(images) } : {}) })
    this.emitUserQueueSnapshot()
  }

  async sendQueuedMessage(kind: "steering" | "followUp", index: number): Promise<void> {
    if (this.queueSubmissionInFlight || this.userQueueDrain) {
      throw Object.assign(new Error("A queued message is already being submitted"), { code: "SESSION_BUSY" })
    }
    const queue = this.userQueue[kind]
    const entry = queue[index]
    if (!entry) throw Object.assign(new Error(`no ${kind} message queued at index ${index}`), { code: "NOT_FOUND" })
    this.queueSubmissionInFlight = true
    try {
      await this.submitUserMessageNow(entry.text, entry.images)
      const position = queue.indexOf(entry)
      if (position >= 0) queue.splice(position, 1)
      this.emitUserQueueSnapshot()
    } finally {
      this.queueSubmissionInFlight = false
    }
  }

  // ---------------------------------------------------------------- goal

  /**
   * OMPiUI 轻量 goal 运行时（`goal` 命令的落点）。RPC 模式的 OMP 不暴露
   * goal 工具/命令，目标注册表住在这里：active 目标在会话 settle 后自动
   * 发一条续跑 prompt（有上限），模型以 GOAL_COMPLETE 行尾标记完成；abort
   * 自动暂停。状态经 state.get 的 goal 字段 + 合成 goal_updated 事件到达
   * 前端目标栏。goal 只随 worker 进程存活（RPC 无自定义条目可持久化）。
   */
  async manageGoal(params: { op: "set" | "pause" | "resume" | "drop"; objective?: string }): Promise<JsonObject> {
    const now = Date.now()
    if (params.op === "set") {
      const objective = (params.objective ?? "").trim()
      if (!objective) {
        throw Object.assign(new Error("params.objective is required for op=set"), { code: "INVALID_REQUEST" })
      }
      this.goal = {
        id: randomUUID(),
        objective,
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      }
      this.goalContinuations = 0
    } else if (isJsonObject(this.goal)) {
      const goal = { ...this.goal }
      if (params.op === "pause") {
        if (goal.status === "active") goal.status = "paused"
      } else if (params.op === "resume") {
        if (goal.status === "paused" || goal.status === "budget-limited") goal.status = "active"
        this.goalContinuations = 0
      } else {
        this.goal = null
      }
      if (isJsonObject(this.goal)) {
        goal.updatedAt = now
        this.goal = goal
      }
    }
    this.emitGoalUpdated()
    if (params.op === "set" || params.op === "resume") this.pumpGoalContinuation()
    return { goal: this.goal }
  }

  private emitGoalUpdated(): void {
    this.emitPiEvent({ type: "goal_updated", goal: this.goal })
  }

  private goalStatus(): string | null {
    return isJsonObject(this.goal) && typeof this.goal.status === "string" ? this.goal.status : null
  }

  private setGoalStatus(status: string): void {
    if (!isJsonObject(this.goal)) return
    this.goal = { ...this.goal, status, updatedAt: Date.now() }
    this.emitGoalUpdated()
  }

  private onGoalTurnStart(): void {
    if (this.goalStatus() !== "active" || this.goalTurnStartedAt !== null) return
    this.goalTurnStartedAt = Date.now()
  }

  private onGoalTurnEnd(): void {
    if (this.goalTurnStartedAt === null) return
    const elapsedSeconds = (Date.now() - this.goalTurnStartedAt) / 1000
    this.goalTurnStartedAt = null
    if (!isJsonObject(this.goal)) return
    const previous = typeof this.goal.timeUsedSeconds === "number" ? this.goal.timeUsedSeconds : 0
    this.goal = {
      ...this.goal,
      timeUsedSeconds: previous + Math.max(0, Math.round(elapsedSeconds)),
    }
  }

  private onGoalSettled(): void {
    this.onGoalTurnEnd()
    if (this.goalStatus() !== "active") return
    // entries 落盘是异步的：等同步落地后判定完成标记，避免把已完成的目标再续跑一轮
    setTimeout(() => {
      if (this.closed || this.currentStreaming || this.goalStatus() !== "active") return
      if (this.lastAssistantTextEndsWith(GOAL_COMPLETE_MARKER)) {
        this.setGoalStatus("complete")
        return
      }
      this.pumpGoalContinuation()
    }, GOAL_SETTLE_GRACE_MS)
  }

  private pauseGoalForAbort(): void {
    if (this.goalStatus() !== "active") return
    this.setGoalStatus("paused")
  }

  private pumpGoalContinuation(): void {
    if (!isJsonObject(this.goal) || typeof this.goal.objective !== "string") return
    if (this.goal.status !== "active" || this.currentStreaming || this.closed) return
    this.goalContinuations += 1
    if (this.goalContinuations > GOAL_MAX_CONTINUATIONS) {
      this.setGoalStatus("budget-limited")
      return
    }
    const objective = this.goal.objective
    const message =
      `[goal continuation ${this.goalContinuations}/${GOAL_MAX_CONTINUATIONS}] Session goal: "${objective}". ` +
      `Continue working toward it. If it is already fully achieved, end your reply with the exact marker ${GOAL_COMPLETE_MARKER} and do nothing else.`
    void this.prompt(message, undefined, { streamingBehavior: "followUp" }).catch(() => undefined)
  }

  private lastAssistantTextEndsWith(marker: string): boolean {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]
      if (!entry || entry.type !== "message") continue
      const message = entry.message
      if (!isJsonObject(message) || message.role !== "assistant") return false
      const content = message.content
      if (!Array.isArray(content)) return false
      const text = content
        .filter(block => isJsonObject(block) && block.type === "text" && typeof block.text === "string")
        .map(block => String((block as JsonObject).text))
        .join("\n")
        .trimEnd()
      return text.endsWith(marker)
    }
    return false
  }

  async abort(): Promise<JsonValue | undefined> {
    if (this.abortInFlight) return this.abortInFlight
    this.pauseGoalForAbort()
    const flight = (async () => {
      const result = unwrapResponse(await this.client.request({ type: "abort" }, 30_000))
      this.currentStreaming = false
      this.userQueue = { steering: [], followUp: [] }
      this.submittedMessages = []
      this.retryShadow = { phase: "idle" }
      this.liveMessage = undefined
      this.emitUserQueueSnapshot()
      this.emitActivityIfChanged()
      await this.syncEntriesNow()
      this.emitPiEvent({ type: "agent_settled" })
      return toJson(result) ?? undefined
    })()
    this.abortInFlight = flight
    try {
      return await flight
    } finally {
      if (this.abortInFlight === flight) this.abortInFlight = undefined
    }
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
    assertManagedSessionFile(target)
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
    this.userQueue = { steering: [], followUp: [] }
    this.submittedMessages = []
    // Settle old dialogs with their original identity before publishing any
    // extension events from the refreshed session (including entry sync).
    this.extensionUi.cancelAll("session_replaced")
    this.extensionUi.bind(this.sessionId, response => this.client.writeExtensionUiResponse(response))
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
    const cleared = this.getUserQueueSnapshot()
    this.userQueue = { steering: [], followUp: [] }
    this.emitUserQueueSnapshot()
    return cleared
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
    await this.waitForIdle()
    const response = await this.client.request({ type: "export_html", outputPath }, 120_000)
    const data = unwrapResponse<JsonValue>(response)
    return toJson({ path: isJsonObject(data) && typeof data.path === "string" ? data.path : outputPath })
  }

  async exportJsonl(outputPath: string): Promise<JsonValue | undefined> {
    // 会话文件本身就是 JSONL：直接复制
    if (!this.sessionFile) throw Object.assign(new Error("session file not persisted yet"), { code: "NOT_FOUND" })
    await this.waitForIdle()
    await this.syncEntriesNow()
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
    try {
      const response = await this.client.request(command, 60_000)
      return unwrapResponse<JsonValue>(response) ?? {}
    } catch (error) {
      // OMP 的子代理注册表是进程内的：worker/omp 重启后旧 run 的
      // sessionFile 一律 "Unknown subagent session file"。转录落盘在
      // 子会话 jsonl 里——读磁盘兜底（返回形状与 RPC 一致），重开
      // 会话/换实例后内联转录仍能回填。
      if (params.sessionFile) {
        const messages = await readChildSessionMessages(params.sessionFile)
        return {
          sessionFile: params.sessionFile,
          fromByte: 0,
          nextByte: 0,
          reset: false,
          entries: [],
          messages,
        }
      }
      throw error
    }
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
