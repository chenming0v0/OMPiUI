import type { JsonObject } from '@ompiui/protocol'
import { subagentDisplayTitle } from './ompSubagentFormat'

/**
 * OMP 子代理实时状态（来源：`omp --mode rpc` 的 subagent_lifecycle /
 * subagent_progress / subagent_event 帧，经 worker 的 omp.subagent 通道转发）。
 *
 * OMP 在每个子代理帧上带 parentToolCallId —— 正好对应主时间线里 task 工具
 * 调用的 call.id，TaskRenderer 据此把实时转录内联到对应工具行
 * （OpenCodeUI 的 SubSessionView 语义）。查找走全局 toolCallId 索引，
 * 与"消息列表属于哪个 session"解耦（分屏场景下也正确）。
 *
 * 更新一律不可变替换 run 对象（useSyncExternalStore 按 Object.is 判变化）。
 */

export type OmpSubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

export type OmpSubagentToolBadge = {
  tool: string
  args: string
  endMs: number
}

export type OmpSubagentProgress = {
  status?: OmpSubagentStatus
  currentTool?: string
  currentToolArgs?: string
  currentToolStartMs?: number
  recentTools: OmpSubagentToolBadge[]
  recentOutput: string[]
  toolCount: number
  requests: number
  tokens: number
  contextTokens?: number
  contextWindow?: number
  cost: number
  durationMs: number
  resolvedModel?: string
  lastIntent?: string
}

export type OmpSubagentRun = {
  id: string
  sessionId: string
  parentToolCallId?: string
  agent: string
  description?: string
  task: string
  status: OmpSubagentStatus
  sessionFile?: string
  index: number
  detached: boolean
  progress?: OmpSubagentProgress
  /** 子代理会话事件转出的轻量转录（subagent_event 帧） */
  transcript: OmpSubagentTranscriptItem[]
  /** 已尝试过磁盘转录回填（get_subagent_messages），避免重复拉取 */
  historyLoaded?: boolean
  startedAt: number
  endedAt?: number
}

export type OmpSubagentTranscriptItem = {
  kind: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  isError?: boolean
  timestamp: number
  /** 内部标记：该气泡对应的消息仍在流式推进（下一帧更新它的文本而非新增一行） */
  streaming?: boolean
}

export type OmpSubagentSnapshot = {
  runs: OmpSubagentRun[]
  revision: number
}

const MAX_TRANSCRIPT_ITEMS = 200
const MAX_OUTPUT_CHARS_PER_ITEM = 4000

// HUD 里被用户清掉的 run（终态）：localStorage 持久化，防止刷新后
// state.get 快照把已清除的条目带回来（OpenCodeUI pinned 列表的同款语义）
const DISMISSED_STORAGE_KEY = 'ompiui-omp-subagent-hud-dismissed'
const MAX_DISMISSED_IDS = 200

function loadDismissedIds(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string').slice(-MAX_DISMISSED_IDS)
  } catch {
    return []
  }
}

function saveDismissedIds(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_DISMISSED_IDS)))
  } catch {
    // 持久化失败只影响刷新后的记忆，不影响本次会话
  }
}

/**
 * 全局 HUD 列表（detached 后台子代理）：运行中在前（按启动时间），
 * 已结束的按结束时间倒序排在下面。
 */
export function selectHudRuns(snapshot: OmpSubagentSnapshot): OmpSubagentRun[] {
  const detached = snapshot.runs.filter(run => run.detached)
  const running = detached.filter(run => run.status === 'running' || run.status === 'pending')
  const finished = detached.filter(run => run.status !== 'running' && run.status !== 'pending')
  running.sort((a, b) => a.startedAt - b.startedAt)
  finished.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...running, ...finished]
}

function asRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeStatus(value: unknown): OmpSubagentStatus {
  switch (value) {
    case 'started':
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'aborted'
    default:
      return 'pending'
  }
}

function normalizeProgress(raw: unknown): OmpSubagentProgress | undefined {
  const record = asRecord(raw)
  if (!record) return undefined
  const recentTools = Array.isArray(record.recentTools)
    ? record.recentTools.map(item => {
      const tool = asRecord(item)
      return {
        tool: str(tool?.tool) ?? '',
        args: str(tool?.args) ?? '',
        endMs: typeof tool?.endMs === 'number' ? tool.endMs : 0,
      }
    }).filter(item => item.tool)
    : []
  return {
    status: normalizeStatus(record.status),
    currentTool: str(record.currentTool),
    currentToolArgs: str(record.currentToolArgs),
    currentToolStartMs: typeof record.currentToolStartMs === 'number' ? record.currentToolStartMs : undefined,
    recentTools,
    recentOutput: Array.isArray(record.recentOutput) ? record.recentOutput.map(String).slice(-12) : [],
    toolCount: typeof record.toolCount === 'number' ? record.toolCount : recentTools.length,
    requests: typeof record.requests === 'number' ? record.requests : 0,
    tokens: typeof record.tokens === 'number' ? record.tokens : 0,
    contextTokens: typeof record.contextTokens === 'number' ? record.contextTokens : undefined,
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
    cost: typeof record.cost === 'number' ? record.cost : 0,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    resolvedModel: str(record.resolvedModel),
    lastIntent: str(record.lastIntent),
  }
}

/** 提取消息文本块（assistant 消息常带 thinking 块，只取 text） */
function extractMessageText(message: JsonObject): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    const record = asRecord(block)
    return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).filter(Boolean).join('\n')
}

function appendTranscriptItem(
  into: OmpSubagentTranscriptItem[],
  item: Omit<OmpSubagentTranscriptItem, 'timestamp'>,
): OmpSubagentTranscriptItem[] {
  const next = [...into, { ...item, timestamp: Date.now() }]
  return next.length > MAX_TRANSCRIPT_ITEMS ? next.slice(next.length - MAX_TRANSCRIPT_ITEMS) : next
}

/**
 * 子代理 session 事件 → 轻量转录行（贴近 OpenCodeUI SubSessionView 的显示粒度）。
 *
 * OMP 的消息事件语义（对真实 RPC 帧抓包确认）：message_start / message_update /
 * message_end 每一帧都带顶层 message —— assistant 的 update 帧携带的是累计
 * 快照，不是增量。因此不能"见 message 就追加一行"：否则 user 消息会在
 * start + end 各渲染一条、assistant 流式文本在首个 text update 和 end 各渲染
 * 一条，同一条消息变成重复气泡（ping 测试里"两条一样的 prompt + 两条 pong"）。
 * 规则：assistant 用 streaming 标记的"打开气泡"推进，user 只在 end 落定成行。
 */
function appendTranscriptEvent(event: JsonObject, into: OmpSubagentTranscriptItem[]): OmpSubagentTranscriptItem[] {
  const type = str(event.type)
  const message = asRecord(event.message)
  if ((type === 'message_start' || type === 'message_update' || type === 'message_end') && message) {
    const role = str(message.role)
    if (role !== 'user' && role !== 'assistant') return into
    const text = extractMessageText(message).slice(0, MAX_OUTPUT_CHARS_PER_ITEM)
    const last = into.at(-1)

    if (role === 'assistant' && type !== 'message_end') {
      // 流式推进：合并进当前打开的气泡；没有打开的气泡则新开一个
      if (!text) return into
      if (last?.kind === 'assistant' && last.streaming) {
        return [...into.slice(0, -1), { ...last, text }]
      }
      return appendTranscriptItem(into, { kind: 'assistant', text, streaming: true })
    }

    if (type === 'message_end') {
      if (role === 'assistant') {
        // 收口当前打开的气泡；空落定（纯 thinking + 工具调用）不留空行
        if (last?.kind === 'assistant' && last.streaming) {
          if (!text) return last.text ? [...into.slice(0, -1), { ...last, streaming: false }] : [...into.slice(0, -1)]
          return [...into.slice(0, -1), { ...last, text, streaming: false }]
        }
        if (!text) return into
        return appendTranscriptItem(into, { kind: 'assistant', text })
      }
      // user：只在 end 落定（start 的全文与 end 相同，追加会重复）
      if (last?.kind === 'user' && last.text === text) return into
      if (!text) return into
      return appendTranscriptItem(into, { kind: 'user', text })
    }

    // user 的 start/update：忽略（等 end 落定）
    return into
  }
  if (type === 'tool_execution_end') {
    const toolName = str(event.toolName) ?? 'tool'
    return appendTranscriptItem(into, { kind: 'tool', text: '', toolName, isError: event.isError === true })
  }
  return into
}

/**
 * 子代理会话磁盘消息（get_subagent_messages 的 messages）→ 轻量转录行。
 * 与实时流同粒度：user / assistant 文本一行，toolResult 一枚工具徽标，
 * developer/system-reminder 与纯工具调用轮次不留空行。
 */
export function transcriptItemsFromMessages(messages: unknown[]): OmpSubagentTranscriptItem[] {
  const items: OmpSubagentTranscriptItem[] = []
  for (const raw of messages) {
    const message = asRecord(raw)
    if (!message) continue
    const role = str(message.role)
    if (role === 'user' || role === 'assistant') {
      const text = extractMessageText(message).slice(0, MAX_OUTPUT_CHARS_PER_ITEM)
      if (!text) continue
      items.push({ kind: role, text, timestamp: Date.now() })
      continue
    }
    if (role === 'toolResult') {
      const toolName = str(message.toolName) ?? 'tool'
      items.push({ kind: 'tool', text: '', toolName, isError: message.isError === true, timestamp: Date.now() })
    }
  }
  return items
}

const EMPTY_RUNS: OmpSubagentRun[] = []

class OmpSubagentStore {
  /** run.id → run；全局扁平（run.id 在单个 omp 进程内唯一，跨进程冲突时后写者胜） */
  private runs = new Map<string, OmpSubagentRun>()
  /** sessionId → run.id[]（会话级面板用） */
  private bySession = new Map<string, string[]>()
  /** parentToolCallId → run.id[]（TaskRenderer 分片索引；不扫整表） */
  private byToolCall = new Map<string, string[]>()
  /** 用户从 HUD 清掉的终态 run：后续帧与快照恢复一律忽略 */
  private dismissed = new Set<string>(loadDismissedIds())
  private revision = 0
  private listeners = new Set<() => void>()
  /** useSyncExternalStore 要求 getSnapshot 返回稳定引用：按 revision 缓存 */
  private cachedSnapshot: OmpSubagentSnapshot = { runs: [], revision: 0 }
  /** 查询键（toolCallId+parentSessionId）→ 版本号：只有该键涉及的 run 变化才递增 */
  private keyVersions = new Map<string, number>()
  /** 查询键 → 按版本缓存的分片（TaskRenderer 的 useSyncExternalStore 快照） */
  private keyCache = new Map<string, { version: number; runs: OmpSubagentRun[] }>()
  /** 通知合并：同一帧内的高频子代理帧只触发一轮 listener（rAF 对齐绘制） */
  private notifyScheduled = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): OmpSubagentSnapshot => {
    if (this.cachedSnapshot.revision !== this.revision) {
      this.cachedSnapshot = {
        runs: [...this.runs.values()].sort((a, b) => a.index - b.index),
        revision: this.revision,
      }
    }
    return this.cachedSnapshot
  }

  runsForSession(sessionId: string): OmpSubagentRun[] {
    const ids = this.bySession.get(sessionId) ?? []
    return ids.map(id => this.runs.get(id)).filter((run): run is OmpSubagentRun => Boolean(run))
  }

  /**
   * 按 task 工具调用 call.id 查内联转录分片（TaskRenderer 的订阅快照）。
   * 引用稳定性按查询键维护：别的 run 刷帧不会让本键的分片换引用，
   * 否则长会话里每个 TaskRenderer 都跟着每一个子代理帧重渲染（卡死根因）。
   */
  getRunsForToolCall = (toolCallId: string | undefined, parentSessionId: string | null | undefined): OmpSubagentRun[] => {
    if (!toolCallId) return EMPTY_RUNS
    const key = `${parentSessionId ?? ''}\u0000${toolCallId}`
    const version = this.keyVersions.get(key) ?? 0
    const cached = this.keyCache.get(key)
    if (cached && cached.version === version) return cached.runs
    const ids = this.byToolCall.get(toolCallId) ?? []
    const runs = ids
      .map(id => this.runs.get(id))
      .filter((run): run is OmpSubagentRun => {
        if (!run) return false
        return !parentSessionId || run.sessionId === parentSessionId
      })
      .sort((a, b) => a.index - b.index)
    this.keyCache.set(key, { version, runs })
    return runs
  }

  clearSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId)
    if (!ids) return
    for (const id of ids) {
      const run = this.runs.get(id)
      if (run) {
        this.touchKey(run)
        this.unlinkToolCall(run)
      }
      this.runs.delete(id)
    }
    this.bySession.delete(sessionId)
    this.bump()
  }

  clearAll(): void {
    this.runs.clear()
    this.bySession.clear()
    this.byToolCall.clear()
    this.keyCache.clear()
    this.keyVersions.clear()
    this.bump()
  }

  /** 从 HUD 清除一个 run（通常已是终态）：删除并记录，后续帧不再恢复 */
  dismiss(runId: string): void {
    const run = this.runs.get(runId)
    if (run) {
      this.touchKey(run)
      this.unlinkToolCall(run)
    }
    const sessionIds = this.bySession.get(run?.sessionId ?? '')
    if (sessionIds && run) {
      const next = sessionIds.filter(id => id !== runId)
      if (next.length > 0) this.bySession.set(run.sessionId, next)
      else this.bySession.delete(run.sessionId)
    }
    this.runs.delete(runId)
    this.dismissed.add(runId)
    saveDismissedIds(this.dismissed)
    this.bump()
  }

  private unlinkToolCall(run: OmpSubagentRun): void {
    const callId = run.parentToolCallId
    if (!callId) return
    const ids = this.byToolCall.get(callId)
    if (!ids) return
    const next = ids.filter(id => id !== run.id)
    if (next.length > 0) this.byToolCall.set(callId, next)
    else this.byToolCall.delete(callId)
  }

  private linkToolCall(run: OmpSubagentRun): void {
    const callId = run.parentToolCallId
    if (!callId) return
    const ids = this.byToolCall.get(callId) ?? []
    if (!ids.includes(run.id)) this.byToolCall.set(callId, [...ids, run.id])
  }

  /** run 的查找键（旧值 + 新值）全部标脏：受影响的 TaskRenderer 分片换引用 */
  private touchKey(...runs: (OmpSubagentRun | undefined)[]): void {
    const keys = new Set<string>()
    for (const run of runs) {
      if (!run) continue
      const callId = run.parentToolCallId
      if (!callId) continue
      keys.add(`${run.sessionId}\u0000${callId}`)
      // parentSessionId 为空的订阅（分屏/导航态切换）匹配任意会话
      keys.add(`\u0000${callId}`)
    }
    for (const key of keys) this.keyVersions.set(key, (this.keyVersions.get(key) ?? 0) + 1)
  }

  private bump(): void {
    this.revision += 1
    this.scheduleNotify()
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    const flush = () => {
      this.notifyScheduled = false
      for (const listener of this.listeners) listener()
    }
    // 子代理流式帧的到达率远高于绘制率；合并到下一帧前只通知一轮。
    // revision 在 bump 时已同步递增，任何 getSnapshot 读到的都是最新数据。
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => flush())
    else setTimeout(flush, 16)
  }

  private upsert(sessionId: string, runId: string, fn: (run: OmpSubagentRun) => OmpSubagentRun): void {
    if (this.dismissed.has(runId)) return
    const existing = this.runs.get(runId)
    const base: OmpSubagentRun = existing ?? {
      id: runId,
      sessionId,
      agent: 'task',
      task: '',
      status: 'pending',
      index: this.runs.size,
      detached: false,
      transcript: [],
      startedAt: Date.now(),
    }
    const next = fn({ ...base, transcript: [...base.transcript] })
    this.runs.set(runId, next)
    if (existing && existing.parentToolCallId && existing.parentToolCallId !== next.parentToolCallId) {
      this.unlinkToolCall(existing)
    }
    this.linkToolCall(next)
    if (existing !== next) this.touchKey(existing, next)
    const sessionIds = this.bySession.get(next.sessionId) ?? []
    if (!sessionIds.includes(runId)) this.bySession.set(next.sessionId, [...sessionIds, runId])
    this.bump()
  }

  applyLifecycle(sessionId: string, payload: JsonObject): void {
    const id = str(payload.id)
    if (!id) return
    this.upsert(sessionId, id, run => {
      const status = normalizeStatus(payload.status)
      const terminal = status === 'completed' || status === 'failed' || status === 'aborted'
      return {
        ...run,
        parentToolCallId: str(payload.parentToolCallId) ?? run.parentToolCallId,
        agent: str(payload.agent) ?? run.agent,
        description: subagentDisplayTitle(str(payload.description)) ?? run.description,
        status,
        sessionFile: str(payload.sessionFile) ?? run.sessionFile,
        index: typeof payload.index === 'number' ? payload.index : run.index,
        detached: payload.detached === true,
        endedAt: terminal ? Date.now() : run.endedAt,
      }
    })
  }

  applyProgress(sessionId: string, payload: JsonObject): void {
    // progress 帧没有 id 时按 index 归位
    let id = str(payload.id)
    if (!id && typeof payload.index === 'number') {
      id = this.runsForSession(sessionId).find(run => run.index === payload.index)?.id
    }
    if (!id) return
    this.upsert(sessionId, id, run => {
      const progress = normalizeProgress(payload.progress)
      return {
        ...run,
        task: str(payload.task) ?? run.task,
        description: subagentDisplayTitle(str(payload.description), str(payload.assignment)) ?? run.description,
        parentToolCallId: str(payload.parentToolCallId) ?? run.parentToolCallId,
        sessionFile: str(payload.sessionFile) ?? run.sessionFile,
        agent: str(payload.agent) ?? run.agent,
        progress,
        status: progress?.status && progress.status !== 'pending' ? progress.status : run.status,
      }
    })
  }

  applyEvent(sessionId: string, payload: JsonObject): void {
    const id = str(payload.id)
    const event = asRecord(payload.event)
    if (!id || !event) return
    this.upsert(sessionId, id, run => ({
      ...run,
      transcript: appendTranscriptEvent(event, run.transcript),
    }))
  }

  /**
   * 磁盘转录回填（get_subagent_messages）：导航离开/页面刷新期间错过的
   * subagent_event 帧从子会话文件补回来。只在当前转录为空时生效——
   * 非空说明实时帧已在推进（回填响应晚到的竞态），保持现状即可。
   */
  applyHistory(sessionId: string, runId: string, messages: unknown[]): void {
    // 回填只作用于已存在的 run（回填不负责凭空创建）
    if (!this.runs.has(runId)) return
    this.upsert(sessionId, runId, run => ({
      ...run,
      historyLoaded: true,
      transcript: run.transcript.length > 0 ? run.transcript : transcriptItemsFromMessages(messages),
    }))
  }

  /** state.get 恢复快照（worker 从最近 lifecycle/progress 帧累计的注册表） */
  applySnapshot(sessionId: string, runs: unknown[]): void {
    for (const raw of runs) {
      const record = asRecord(raw)
      const id = str(record?.id)
      if (!record || !id) continue
      this.upsert(sessionId, id, run => ({
        ...run,
        parentToolCallId: str(record.parentToolCallId) ?? run.parentToolCallId,
        agent: str(record.agent) ?? run.agent,
        description: subagentDisplayTitle(str(record.description)) ?? run.description,
        task: str(record.task) ?? run.task,
        status: normalizeStatus(record.status ?? run.status),
        sessionFile: str(record.sessionFile) ?? run.sessionFile,
        index: typeof record.index === 'number' ? record.index : run.index,
        detached: record.detached === true || run.detached,
        progress: normalizeProgress(record.progress) ?? run.progress,
      }))
    }
  }
}

export const ompSubagentStore = new OmpSubagentStore()
