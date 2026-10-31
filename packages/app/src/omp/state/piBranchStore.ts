import type { PiBranchCheckpoint, PiBranchPage, PiToolExecutionState } from '../domain/index.js'
import { windowBranch } from '../branchWindow'
import { cachePiBranch } from '../branchCache'

interface BranchEntry {
  data: PiBranchPage | null
  loading: boolean
  error: Error | null
  requestVersion: number
  pendingToolExecutions?: Record<string, PiToolExecutionState>
  toolInterruption?: { error: string; kind: NonNullable<PiToolExecutionState['interruption']> }
}

const EMPTY_ENTRY: BranchEntry = { data: null, loading: false, error: null, requestVersion: 0 }

/**
 * Raw branch page store, keyed by session id (multi-pane safe).
 * Follows app store convention: subscribe/notify + stable snapshots.
 */
class PiBranchStore {
  private bySessionId = new Map<string, BranchEntry>()
  private listeners = new Set<() => void>()
  private nextVersion = 0
  private activeSessions = new Set<string>()

  retain(sessionId: string): void {
    this.activeSessions.add(sessionId)
    const entry = this.bySessionId.get(sessionId)
    if (entry) {
      this.bySessionId.delete(sessionId)
      this.bySessionId.set(sessionId, entry)
    }
  }

  release(sessionId: string): void {
    this.activeSessions.delete(sessionId)
    // 已关闭的 pane 只保留最新一页；主动阅读的活动 pane 不丢历史。
    const entry = this.bySessionId.get(sessionId)
    if (
      entry?.data &&
      (entry.data.items.length > 100 ||
        new TextEncoder().encode(JSON.stringify(entry.data)).byteLength > 8 * 1024 * 1024)
    ) {
      this.clear(sessionId)
    }
    this.trimInactive()
  }

  private trimInactive(): void {
    const inactive = [...this.bySessionId.keys()].filter(id => !this.activeSessions.has(id))
    for (const id of inactive.slice(0, Math.max(0, inactive.length - 4))) this.bySessionId.delete(id)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const id of this.activeSessions) {
      const data = this.bySessionId.get(id)?.data
      if (data) cachePiBranch(id, data)
    }
    this.listeners.forEach(l => l())
  }

  private entry(sessionId: string): BranchEntry {
    let entry = this.bySessionId.get(sessionId)
    if (!entry) {
      entry = { data: null, loading: false, error: null, requestVersion: ++this.nextVersion }
      this.bySessionId.set(sessionId, entry)
    }
    return entry
  }

  setLoading(sessionId: string, loading: boolean): void {
    this.entry(sessionId).loading = loading
    this.notify()
  }

  setData(sessionId: string, data: PiBranchPage): void {
    const entry = this.entry(sessionId)
    entry.requestVersion = ++this.nextVersion
    const executions = { ...data.client?.toolExecutions, ...entry.pendingToolExecutions }
    const visibleCallIds = new Set<string>()
    const results = new Map<string, NonNullable<PiToolExecutionState['result']>>()
    for (const item of data.items) {
      if (item.type === 'message' && item.message.role === 'assistant') {
        for (const block of item.message.content) if (block.type === 'toolCall') visibleCallIds.add(block.id)
      } else if (item.type === 'message' && item.message.role === 'toolResult') {
        results.set(item.message.toolCallId, item.message)
      } else if (item.type === 'custom' && item.customType === 'tool_execution_start') {
        const start = item.data as { toolCallId?: unknown } | undefined
        if (typeof start?.toolCallId === 'string') visibleCallIds.add(start.toolCallId)
      }
    }
    const live = data.checkpoint?.liveMessage?.message
    if (live?.role === 'assistant') for (const block of live.content) if (block.type === 'toolCall') visibleCallIds.add(block.id)
    // A reconnect may replace the event epoch. Keep terminal evidence for calls
    // still in this branch, but never leak it into an unrelated navigated branch.
    for (const [id, execution] of Object.entries(entry.data?.client?.toolExecutions ?? {})) {
      if ((execution.error || execution.completedAt !== undefined || execution.result) && visibleCallIds.has(id) && !executions[id]?.result) executions[id] = execution
    }
    for (const [id, result] of results) {
      if (executions[id]) executions[id] = { ...executions[id], result, isRunning: false, error: undefined, interruption: undefined, endedAt: undefined }
    }
    entry.data = windowBranch(Object.keys(executions).length > 0 ? { ...data, client: { ...data.client, toolExecutions: executions } } : data, data.client?.historyWindowed)
    entry.pendingToolExecutions = undefined
    if (entry.toolInterruption) this.interruptToolExecutions(sessionId, entry.toolInterruption.error, entry.toolInterruption.kind)
    entry.error = null
    entry.loading = false
    this.trimInactive()
    this.notify()
  }

  /** 流式内容不使历史请求失效；响应合并时按事件游标保留较新的 checkpoint。 */
  setLiveCheckpoint(sessionId: string, checkpoint: PiBranchCheckpoint): void {
    const entry = this.bySessionId.get(sessionId)
    if (!entry?.data) return
    entry.data = { ...entry.data, checkpoint }
    this.notify()
  }
  /** Live tool evidence shares the branch projection and survives checkpoint replacement. */
  patchToolExecution(sessionId: string, toolCallId: string, patch: PiToolExecutionState): boolean {
    const entry = this.entry(sessionId)
    const previous = entry.data?.client?.toolExecutions?.[toolCallId] ?? entry.pendingToolExecutions?.[toolCallId]
    if ((previous?.result || previous?.completedAt !== undefined || previous?.error) && !patch.result) return false
    const next = { ...previous, ...patch, awaitingSnapshot: undefined }
    if (patch.result) {
      next.error = undefined
      next.interruption = undefined
      next.endedAt = undefined
      next.isRunning = false
    }
    if (previous?.startedAt !== undefined && patch.startedAt !== undefined) next.startedAt = previous.startedAt
    if (!previous && entry.toolInterruption && !next.result && next.completedAt === undefined && (next.isRunning ?? next.startedAt !== undefined)) {
      next.isRunning = false
      next.error = entry.toolInterruption.error
      next.interruption = entry.toolInterruption.kind
      next.endedAt = Date.now()
    }
    if (previous && !previous.awaitingSnapshot && Object.keys(patch).every(key => previous[key as keyof PiToolExecutionState] === next[key as keyof PiToolExecutionState])) return true
    if (!entry.data) {
      entry.pendingToolExecutions = { ...entry.pendingToolExecutions, [toolCallId]: next }
      return !next.error || Boolean(patch.result)
    }
    entry.data = {
      ...entry.data,
      client: { ...entry.data.client, toolExecutions: { ...entry.data.client?.toolExecutions, [toolCallId]: next } },
    }
    this.notify()
    return !next.error || Boolean(patch.result)
  }

  /** Only a genuine new native run clears the prehydration terminal boundary. */
  beginToolExecutions(sessionId: string): void {
    const entry = this.bySessionId.get(sessionId)
    if (entry) entry.toolInterruption = undefined
  }

  /** Only a crash, completed abort, or authoritative settled state can seal unfinished executions. */
  interruptToolExecutions(sessionId: string, error: string, kind: NonNullable<PiToolExecutionState['interruption']> = 'failed'): void {
    const entry = this.entry(sessionId)
    if (!entry.toolInterruption || (entry.toolInterruption.kind === 'unknown' && kind !== 'unknown')) {
      entry.toolInterruption = { error, kind }
    }
    const interruption = entry.toolInterruption
    const executions = { ...(entry.data?.client?.toolExecutions ?? entry.pendingToolExecutions) }
    const resultIds = new Set<string>()
    for (const item of entry.data?.items ?? []) {
      if (item.type === 'message' && item.message.role === 'toolResult') resultIds.add(item.message.toolCallId)
      if (item.type !== 'custom' || item.customType !== 'tool_execution_start') continue
      const data = item.data
      if (!data || typeof data !== 'object' || !('toolCallId' in data) || typeof data.toolCallId !== 'string') continue
      executions[data.toolCallId] ??= { isRunning: true }
    }
    let changed = false
    for (const [id, execution] of Object.entries(executions)) {
      if (resultIds.has(id) || execution.result || execution.completedAt !== undefined) continue
      // Stronger exit evidence may replace an unknown settled outcome, never a real tool failure/result.
      if (execution.error) {
        if (execution.interruption !== 'unknown' || interruption.kind === 'unknown') continue
      } else if (!(execution.isRunning ?? execution.startedAt !== undefined)) continue
      executions[id] = { ...execution, isRunning: false, error: interruption.error, interruption: interruption.kind, endedAt: execution.endedAt ?? Date.now() }
      changed = true
    }
    if (!changed) return
    entry.requestVersion = ++this.nextVersion
    if (!entry.data) entry.pendingToolExecutions = executions
    else entry.data = { ...entry.data, client: { ...entry.data.client, toolExecutions: executions } }
    this.notify()
  }

  /** 保留崩溃前收到的正文，但停止流式动画，旧的历史响应不能再将它变回运行中。 */
  settleLiveMessage(sessionId: string): void {
    const entry = this.bySessionId.get(sessionId)
    const checkpoint = entry?.data?.checkpoint
    const liveMessage = checkpoint?.liveMessage
    if (!entry?.data || !checkpoint || liveMessage?.phase !== 'streaming') return
    entry.requestVersion = ++this.nextVersion
    entry.data = {
      ...entry.data,
      checkpoint: { ...checkpoint, liveMessage: { ...liveMessage, phase: 'persisting' } },
    }
    this.notify()
  }

  beginRequest(sessionId: string): number {
    const entry = this.entry(sessionId)
    entry.requestVersion = ++this.nextVersion
    return entry.requestVersion
  }

  isRequestCurrent(sessionId: string, version: number): boolean {
    return this.bySessionId.get(sessionId)?.requestVersion === version
  }

  setDataIfCurrent(sessionId: string, data: PiBranchPage, version: number): void {
    if (this.isRequestCurrent(sessionId, version)) this.setData(sessionId, data)
  }

  setError(sessionId: string, error: Error): void {
    const entry = this.entry(sessionId)
    entry.error = error
    entry.loading = false
    this.notify()
  }

  getData(sessionId: string): PiBranchPage | null {
    return this.bySessionId.get(sessionId)?.data ?? null
  }

  isLoading(sessionId: string): boolean {
    return this.bySessionId.get(sessionId)?.loading ?? false
  }

  getError(sessionId: string): Error | null {
    return this.bySessionId.get(sessionId)?.error ?? null
  }

  clear(sessionId: string): void {
    this.bySessionId.delete(sessionId)
    this.notify()
  }

  clearAll(): void {
    this.bySessionId.clear()
    this.activeSessions.clear()
    this.notify()
  }
}

export const piBranchStore = new PiBranchStore()
export type { BranchEntry }
export { EMPTY_ENTRY as EMPTY_BRANCH_ENTRY }
