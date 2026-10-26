import type { ThinkingLevel } from '../vendor/pi-agent-core'
import { goalMessagePreview } from '@ompiui/protocol'
import type { AssistantMessage } from '../vendor/pi-ai'
import type { SessionEntry } from '../vendor/pi-coding-agent'
import type {
  PiBranchPage,
  PiSessionRow,
  PiTimelineItem,
  PiAssistantMessageItem,
  PiBashExecutionItem,
  PiBashExecutionGroupItem,
  PiCompactionItem,
  PiBranchSummaryItem,
  PiCustomMessageItem,
  PiModeChangeItem,
  PiUnknownItem,
} from '../domain/index.js'
import type { PiToolExecutionState } from '../domain/index.js'
import { piSessionInfoStore } from '../state/index.js'

/**
 * Select Pi session rows from raw session info.
 * Transforms SessionInfo to UI-ready session rows.
 */
export function selectPiSessionRows(): PiSessionRow[] {
  const sessions = piSessionInfoStore.getAll()
  return sessions
    .filter(session => session.id && session.cwd && session.path)
    .map(session => ({
      id: session.id,
      sessionFile: session.path,
      cwd: session.cwd,
      title: session.name || goalMessagePreview(session.firstMessage || '') || 'New chat',
      preview: goalMessagePreview(session.firstMessage || ''),
      createdAt: parseTime(session.created),
      modifiedAt: parseTime(session.modified) || parseTime(session.created),
      messageCount: session.messageCount ?? 0,
      parentSessionPath: session.parentSessionPath,
    }))
}

/**
 * Select timeline items from the branch page.
 * Tool results are paired back into their owning assistant item so each
 * message keeps its embedded tool calls. The live streaming message (from
 * the branch checkpoint) is appended as a streaming assistant item.
 * Entries without a conversation representation still surface as items.
 */
export function selectPiTimelineItems(branch: PiBranchPage): PiTimelineItem[] {
  const items = buildPiHistoryItems(branch)
  const liveItems = buildPiLiveItems(branch)
  for (const item of liveItems) items.push(item)
  return items
}

/** A retained render-key mapping is not proof that its entry is still loaded. */
function visibleLiveMessage(branch: PiBranchPage) {
  const live = branch.checkpoint?.liveMessage
  if (!live) return undefined
  const persistedVisible = branch.items.some(entry => entry.type === 'message'
    && entry.message.role === live.message.role
    && (entry.id === live.id || branch.client?.stableEntryIds?.[entry.id] === live.id))
  return persistedVisible ? undefined : live
}

/**
 * History part of the timeline (persisted branch entries, tool results
 * paired back). Excludes the live streaming message — see buildPiLiveItems.
 * Exported for the reference-stable cached selector, which reuses this array
 * (stable item references keep memoized rows from re-rendering) while the
 * live item is rebuilt per streaming chunk.
 */
export function buildPiHistoryItems(branch: PiBranchPage): PiTimelineItem[] {
  const items: PiTimelineItem[] = []
  const assistantByCallId = new Map<string, PiAssistantMessageItem>()
  const toolExecutions: Record<string, PiToolExecutionState> = { ...branch.client?.toolExecutions }
  const orphanResults = new Map<string, Extract<PiTimelineItem, { kind: 'tool_result' }>>()
  const live = visibleLiveMessage(branch)
  const liveCallIds = new Set(live?.message.role === 'assistant'
    ? live.message.content.flatMap(block => block.type === 'toolCall' ? [block.id] : []) : [])
  // 相邻 bash 执行合并为工具组：遇到非 bash 条目时重置，保证只有连续
  // 的 bash（`!cmd` / `/bash cmd`）才会并组，与 AI 连续工具调用一致。
  let lastBashGroup: PiBashExecutionGroupItem | undefined

  for (const entry of branch.items) {
    const timestamp = parseTime(entry.timestamp)
    const renderKey = branch.client?.stableEntryIds?.[entry.id]

    if (entry.type === 'message') {
      const message = entry.message

      if (message.role === 'user') {
        items.push({
          kind: 'user_message',
          entryId: entry.id,
          timestamp,
          rawEntry: entry,
          message,
          blocks: Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }],
          renderKey,
        })
        lastBashGroup = undefined
      } else if (message.role === 'assistant') {
        const item: PiAssistantMessageItem = {
          kind: 'assistant_message',
          entryId: entry.id,
          timestamp,
          rawEntry: entry,
          message,
          blocks: message.content,
          toolResults: {},
          renderKey,
        }
        items.push(item)
        for (const block of message.content) {
          if (block.type === 'toolCall') assistantByCallId.set(block.id, item)
        }
        lastBashGroup = undefined
      } else if (message.role === 'toolResult') {
        const owner = assistantByCallId.get(message.toolCallId)
        if (owner) owner.toolResults[message.toolCallId] = message
        else {
          const previous = orphanResults.get(message.toolCallId)
          if (previous) items.splice(items.indexOf(previous), 1)
          const execution = toolExecutions[message.toolCallId]
          const orphan: Extract<PiTimelineItem, { kind: 'tool_result' }> = {
            kind: 'tool_result', entryId: entry.id, timestamp, rawEntry: entry,
            execution: { ...execution, call: execution?.call ?? { type: 'toolCall', id: message.toolCallId, name: message.toolName || 'tool', arguments: {} }, argumentsUnknown: !execution?.call, result: message },
          }
          orphanResults.set(message.toolCallId, orphan)
          items.push(orphan)
        }
      } else if (message.role === 'bashExecution') {
        // 相邻 bash 执行并入当前工具组；非连续时开新组
        const bashItem: PiBashExecutionItem = {
          kind: 'bash_execution',
          entryId: entry.id,
          timestamp,
          rawEntry: entry,
          message,
        }
        if (lastBashGroup) {
          lastBashGroup.items.push(bashItem)
        } else {
          lastBashGroup = {
            kind: 'bash_execution_group',
            entryId: entry.id,
            timestamp,
            items: [bashItem],
          }
          items.push(lastBashGroup)
        }
      } else {
        // The vendored union may not include future runtime message roles.
        const unknownMessage: { role: string } = message
        items.push({ kind: 'unknown', entryId: entry.id, timestamp, rawEntry: entry, entryType: `message:${unknownMessage.role}` })
      }
      // Preserve future message roles rather than silently losing their content.
    } else if (entry.type === 'custom' && entry.customType === 'tool_execution_start') {
      const data = entry.data as { toolCallId?: unknown; startedAt?: unknown } | undefined
      if (typeof data?.toolCallId === 'string') {
        const startedAt = parseTime(data.startedAt)
        toolExecutions[data.toolCallId] = { ...toolExecutions[data.toolCallId], isRunning: toolExecutions[data.toolCallId]?.isRunning ?? true, ...(startedAt > 0 ? { startedAt } : {}) }
      }
    } else if (entry.type === 'compaction') {
      items.push({
        kind: 'compaction',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        firstKeptEntryId: entry.firstKeptEntryId,
        details: entry.details,
      } as PiCompactionItem)
      lastBashGroup = undefined
    } else if (entry.type === 'branch_summary') {
      items.push({
        kind: 'branch_summary',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        summary: entry.summary,
        fromId: entry.fromId,
        details: entry.details,
      } as PiBranchSummaryItem)
      lastBashGroup = undefined
    } else if (entry.type === 'custom_message') {
      items.push({
        kind: 'custom_message',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
      } as PiCustomMessageItem)
      lastBashGroup = undefined
    } else if ((entry as { type?: string }).type === 'mode_change') {
      // OMP 扩展条目（vendored Pi union 没有该变体，按结构读取）：agent
      // 模式切换标记（goal / plan 等，"none" 表示退出）——渲染为模式分隔条
      const modeChange = entry as unknown as { id: string; mode?: unknown; data?: unknown }
      items.push({
        kind: 'mode_change',
        entryId: modeChange.id,
        timestamp,
        rawEntry: entry,
        mode: typeof modeChange.mode === 'string' ? modeChange.mode : '',
        data: modeChange.data,
      } as PiModeChangeItem)
      lastBashGroup = undefined
    } else if (
      entry.type === 'thinking_level_change' ||
      entry.type === 'model_change' ||
      entry.type === 'label' ||
      entry.type === 'custom' ||
      entry.type === 'session_info' ||
      // OMP 18.x 扩展的记账/元数据条目（同样不在 vendored Pi union 里）：
      // service_tier_change 是服务层级元数据；ttsr_injection / credential_pin
      // 是会话内部簿记；reset_boundary 随重置出现、旧历史已被裁剪；
      // title_change 是自动标题写入（标题住在侧栏）—— worker 通常已把
      // title_change 丢弃为 omp.dropped，这里兜底。均无会话流展示价值，
      // 与 model_change 一致静默跳过。
      (entry as { type?: string }).type === 'service_tier_change' ||
      (entry as { type?: string }).type === 'ttsr_injection' ||
      (entry as { type?: string }).type === 'credential_pin' ||
      (entry as { type?: string }).type === 'reset_boundary' ||
      (entry as { type?: string }).type === 'title_change' ||
      // omp.dropped isn't part of the Pi union: every SessionEntry variant is
      // already matched above, so entry is narrowed to never here — cast first
      (entry as { type?: string }).type === 'omp.dropped'
    ) {
      // Not consumed in the conversation flow: model and thinking level
      // live in the header model selector / composer level selector
      // (repeated model_change entries are just noise here), labels are
      // markers on their target entries, plain custom entries are
      // extension state for reload reconstruction, session_info is
      // metadata (name lives in the header/session list). omp.dropped is
      // the OMP worker's placeholder for metadata it strips from the
      // timeline (title / model_usage / session headers) — it only exists
      // to keep the parent chain intact for branch walking.
      continue
    } else {
      // Unknown entry type (future SDK additions) — keep visible, never drop
      const unknown = entry as { id: string; type: string }
      items.push({
        kind: 'unknown',
        entryId: unknown.id,
        timestamp,
        rawEntry: entry,
        entryType: unknown.type,
      } as PiUnknownItem)
      lastBashGroup = undefined
    }
  }
  for (const [callId, orphan] of orphanResults) {
    const owner = assistantByCallId.get(callId)
    // A result encountered after the owner is newer than an earlier fallback.
    if (owner && !owner.toolResults[callId]) owner.toolResults[callId] = orphan.execution.result!
    if (owner || liveCallIds.has(callId)) items.splice(items.indexOf(orphan), 1)
  }
  // 无所属条目的执行兜底行只覆盖「比已加载历史更新、尚未落盘」或仍在运行的调用。
  // 所属助手消息滑出加载窗口的旧调用不能再追加到时间线末尾（会显示成任务结束后才出现）。
  const newestLoaded = branch.items.reduce((max, entry) => Math.max(max, parseTime(entry.timestamp)), 0)
  for (const [callId, execution] of Object.entries(toolExecutions)) {
    if (assistantByCallId.has(callId) || liveCallIds.has(callId) || orphanResults.has(callId) || !execution.call) continue
    const at = execution.startedAt ?? execution.result?.timestamp ?? 0
    const running = execution.isRunning === true && !execution.result && execution.completedAt === undefined && !execution.error
    if (!running && at <= newestLoaded) continue
    items.push({ kind: 'tool_result', entryId: `tool:${callId}`, timestamp: at, execution: { ...execution, call: execution.call } })
  }
  for (const [callId, owner] of assistantByCallId) {
    const execution = toolExecutions[callId]
    if (!execution) continue
    owner.toolExecutions ??= {}
    owner.toolExecutions[callId] = execution
    if (!owner.toolResults[callId] && execution.result) owner.toolResults[callId] = execution.result
  }

  return items
}

/**
 * Live streaming message items (from the branch checkpoint).
 * Rebuilt per streaming chunk — only the live row re-renders; the cached
 * history array keeps every other row's references stable.
 */
/** Live 消息的原始条目（id 用 live.id，保证 live→持久化交接时 React key 连续） */
function liveRawEntry(live: NonNullable<NonNullable<PiBranchPage['checkpoint']>['liveMessage']>): SessionEntry {
  const timestamp = live.message.timestamp || Date.now()
  return {
    type: 'message',
    id: live.id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: live.message,
  }
}

/**
 * Live streaming message items (from the branch checkpoint).
 * Rebuilt per streaming chunk — only the live row re-renders; the cached
 * history array keeps every other row's references stable.
 */
export function buildPiLiveItems(branch: PiBranchPage): PiTimelineItem[] {
  const items: PiTimelineItem[] = []
  // Keep the live row until its matching persisted entry is actually loaded.
  const live = visibleLiveMessage(branch)
  if (live && live.message.role === 'user' && live.phase === 'streaming') {
    const message = live.message
    const text = typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map(block => block.text)
          .join('')
    if (text.trim()) {
      items.push({
        kind: 'user_message',
        entryId: live.id,
        timestamp: message.timestamp || Date.now(),
        rawEntry: liveRawEntry(live),
        message,
        blocks: Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }],
      })
    }
  }
  if (live && live.message.role === 'assistant' && live.message.content.length > 0) {
    const message = live.message as AssistantMessage
    const toolExecutions = { ...branch.client?.toolExecutions }
    const callIds = new Set(message.content.flatMap(block => block.type === 'toolCall' ? [block.id] : []))
    if (callIds.size > 0) {
      for (const entry of branch.items) {
        if (entry.type === 'custom' && entry.customType === 'tool_execution_start') {
          const data = entry.data as { toolCallId?: unknown; startedAt?: unknown } | undefined
          if (typeof data?.toolCallId !== 'string' || !callIds.has(data.toolCallId)) continue
          const startedAt = parseTime(data.startedAt)
          toolExecutions[data.toolCallId] = { ...toolExecutions[data.toolCallId], isRunning: toolExecutions[data.toolCallId]?.isRunning ?? true, ...(startedAt > 0 ? { startedAt } : {}) }
        } else if (entry.type === 'message' && entry.message.role === 'toolResult' && callIds.has(entry.message.toolCallId)) {
          toolExecutions[entry.message.toolCallId] = { ...toolExecutions[entry.message.toolCallId], result: entry.message }
        }
      }
    }
    items.push({
      kind: 'assistant_message',
      entryId: live.id,
      timestamp: message.timestamp || Date.now(),
      rawEntry: liveRawEntry(live),
      message,
      blocks: message.content,
      toolResults: Object.fromEntries(message.content.flatMap(block => {
        if (block.type !== 'toolCall') return []
        const result = toolExecutions[block.id]?.result
        return result ? [[block.id, result]] : []
      })),
      toolExecutions,
      isStreaming: live.phase === 'streaming',
    })
  }

  return items
}

/**
 * Select composer mode from session runtime state.
 */
export function selectPiComposerMode(state: { isStreaming?: boolean; steeringMode?: string; followUpMode?: string } | null): { type: 'idle' } | { type: 'streaming'; mode: 'steering' | 'followUp'; queueMode: 'all' | 'one-at-a-time' } {
  if (!state) return { type: 'idle' }
  if (state.isStreaming) {
    return {
      type: 'streaming',
      mode: state.steeringMode === 'one-at-a-time' ? 'steering' : 'followUp',
      queueMode: (state.steeringMode === 'one-at-a-time' ? state.steeringMode : state.followUpMode) as 'all' | 'one-at-a-time' || 'all',
    }
  }
  return { type: 'idle' }
}

/**
 * Select current model info from session runtime state.
 */
export function selectPiCurrentModel(state: { model?: { provider: string; modelId: string }; thinkingLevel?: string } | null): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } | null {
  if (!state?.model) return null
  return {
    provider: state.model.provider,
    modelId: state.model.modelId,
    thinkingLevel: state.thinkingLevel as ThinkingLevel | undefined,
  }
}

function parseTime(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}
