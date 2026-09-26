import type { JsonObject } from '@ompiui/protocol'

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
  startedAt: number
  endedAt?: number
}

export type OmpSubagentTranscriptItem = {
  kind: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  isError?: boolean
  timestamp: number
}

export type OmpSubagentSnapshot = {
  runs: OmpSubagentRun[]
  revision: number
}

const MAX_TRANSCRIPT_ITEMS = 200
const MAX_OUTPUT_CHARS_PER_ITEM = 4000

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

/** 子代理 session 事件 → 轻量转录行（贴近 OpenCodeUI SubSessionView 的显示粒度） */
function appendTranscriptEvent(event: JsonObject, into: OmpSubagentTranscriptItem[]): OmpSubagentTranscriptItem[] {
  const type = str(event.type)
  const message = asRecord(event.message)
  if ((type === 'message_start' || type === 'message_update' || type === 'message_end') && message) {
    const role = str(message.role)
    const content = message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => {
          const record = asRecord(block)
          return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
        }).filter(Boolean).join('\n')
        : ''
    if (!text || (role !== 'user' && role !== 'assistant')) return into
    const last = into.at(-1)
    // 流式增量：合并进最后一行（message_end 落定则新起一行）
    if (role === 'assistant' && last?.kind === 'assistant' && type !== 'message_end') {
      const updated = [...into.slice(0, -1), { ...last, text: text.slice(0, MAX_OUTPUT_CHARS_PER_ITEM) }]
      return updated
    }
    const next = [...into, { kind: role, text: text.slice(0, MAX_OUTPUT_CHARS_PER_ITEM), timestamp: Date.now() } as OmpSubagentTranscriptItem]
    return next.length > MAX_TRANSCRIPT_ITEMS ? next.slice(next.length - MAX_TRANSCRIPT_ITEMS) : next
  }
  if (type === 'tool_execution_end') {
    const toolName = str(event.toolName) ?? 'tool'
    const next = [...into, { kind: 'tool', text: '', toolName, isError: event.isError === true, timestamp: Date.now() } as OmpSubagentTranscriptItem]
    return next.length > MAX_TRANSCRIPT_ITEMS ? next.slice(next.length - MAX_TRANSCRIPT_ITEMS) : next
  }
  return into
}

class OmpSubagentStore {
  /** run.id → run；全局扁平（run.id 在单个 omp 进程内唯一，跨进程冲突时后写者胜） */
  private runs = new Map<string, OmpSubagentRun>()
  /** parentToolCallId → run.id（TaskRenderer 内联查找索引） */
  private byToolCall = new Map<string, string>()
  /** sessionId → run.id[]（会话级面板用） */
  private bySession = new Map<string, string[]>()
  private revision = 0
  private listeners = new Set<() => void>()
  /** useSyncExternalStore 要求 getSnapshot 返回稳定引用：按 revision 缓存 */
  private cachedSnapshot: OmpSubagentSnapshot = { runs: [], revision: 0 }

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

  /** TaskRenderer 按 task 工具调用的 call.id 查内联转录 */
  getByToolCall = (toolCallId: string | undefined): OmpSubagentRun | undefined => {
    if (!toolCallId) return undefined
    const id = this.byToolCall.get(toolCallId)
    return id ? this.runs.get(id) : undefined
  }

  runsForSession(sessionId: string): OmpSubagentRun[] {
    const ids = this.bySession.get(sessionId) ?? []
    return ids.map(id => this.runs.get(id)).filter((run): run is OmpSubagentRun => Boolean(run))
  }

  clearSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId)
    if (!ids) return
    for (const id of ids) {
      const run = this.runs.get(id)
      if (run?.parentToolCallId) this.byToolCall.delete(run.parentToolCallId)
      this.runs.delete(id)
    }
    this.bySession.delete(sessionId)
    this.bump()
  }

  clearAll(): void {
    this.runs.clear()
    this.byToolCall.clear()
    this.bySession.clear()
    this.bump()
  }

  private bump(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  private upsert(sessionId: string, runId: string, fn: (run: OmpSubagentRun) => OmpSubagentRun): void {
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
    if (next.parentToolCallId) this.byToolCall.set(next.parentToolCallId, runId)
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
        description: str(payload.description) ?? run.description,
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
      id = this.getSnapshot().runs.find(run => run.index === payload.index && run.sessionId === sessionId)?.id
    }
    if (!id) return
    this.upsert(sessionId, id, run => {
      const progress = normalizeProgress(payload.progress)
      return {
        ...run,
        task: str(payload.task) ?? run.task,
        description: str(payload.assignment) ?? run.description,
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
        description: str(record.description) ?? run.description,
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
