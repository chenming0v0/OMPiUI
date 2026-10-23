import type { PiBranchPage, PiTimelineItem } from '../domain/index.js'
import { buildPiHistoryItems, buildPiLiveItems } from './index.js'

/**
 * Reference-stable timeline selection.
 *
 * The plain `selectPiTimelineItems` rebuilds a fresh object for every entry on
 * every call. During a streaming token storm the event stream calls
 * `setData` with a new branch page each chunk (updateLiveMessage shallow-
 * copies the page and replaces only `checkpoint.liveMessage`), so the
 * selector would re-create the whole timeline and every memoized row would
 * re-render — O(n) per chunk instead of O(1).
 *
 * The cache keys on the *items array reference* and reuses the **history**
 * items (persisted entries) verbatim while only the live message changes
 * (token storm): history item references stay identical, so memoized rows
 * hold and only the live row re-renders. The live item itself is rebuilt per
 * chunk from the checkpoint — caching it too would freeze the streaming text
 * (the "content pops out only at the end" bug), because updateLiveMessage
 * keeps `items` identity while updating `checkpoint.liveMessage`.
 * 分页后按原生条目引用复用未变的渲染对象；工具结果补齐时只替换对应助手。
 */
let historyCache = new WeakMap<readonly unknown[], {
  items: PiTimelineItem[]
  stableEntryIds: NonNullable<PiBranchPage['client']>['stableEntryIds']
  toolExecutions: NonNullable<PiBranchPage['client']>['toolExecutions']
  liveCallKey: string
}>()
let entryCache = new WeakMap<object, PiTimelineItem>()

function reuseHistoryItem(item: PiTimelineItem): PiTimelineItem {
  if (item.kind === 'bash_execution_group') return item
  if (!item.rawEntry) return item
  const previous = entryCache.get(item.rawEntry)
  if (previous?.kind === item.kind && previous.renderKey === item.renderKey) {
    if (previous.kind === 'tool_result' && item.kind === 'tool_result') {
      const a = previous.execution
      const b = item.execution
      if (a.result === b.result && a.error === b.error && a.completedAt === b.completedAt && a.endedAt === b.endedAt && a.isRunning === b.isRunning && a.startedAt === b.startedAt) return previous
      entryCache.set(item.rawEntry, item)
      return item
    }
    if (previous.kind !== 'assistant_message' || item.kind !== 'assistant_message') return previous
    const ids = Object.keys(item.toolResults)
    const executionIds = Object.keys(item.toolExecutions ?? {})
    if (
      ids.length === Object.keys(previous.toolResults).length &&
      ids.every(id => previous.toolResults[id] === item.toolResults[id]) &&
      executionIds.length === Object.keys(previous.toolExecutions ?? {}).length &&
      executionIds.every(id => {
        const a = previous.toolExecutions?.[id]
        const b = item.toolExecutions![id]
        return a?.startedAt === b.startedAt && a?.isRunning === b.isRunning && a?.result === b.result && a?.error === b.error && a?.completedAt === b.completedAt && a?.endedAt === b.endedAt
      })
    ) return previous
  }
  entryCache.set(item.rawEntry, item)
  return item
}

/**
 * Select timeline items for a session with stable references while the
 * underlying branch page reference stays unchanged.
 * @param sessionId - Session identity for the cache key.
 * @param branch - Branch page (null when no session).
 * @returns Timeline items; history item references are stable across chunks,
 *          the live streaming item is fresh per chunk.
 */
export function selectPiTimelineItemsCached(
  sessionId: string | null,
  branch: PiBranchPage | null,
): PiTimelineItem[] {
  if (!branch || !sessionId) {
    if (branch) return buildPiHistoryItems(branch).concat(buildPiLiveItems(branch))
    return []
  }

  const live = branch.checkpoint?.liveMessage?.message
  const liveCallKey = live?.role === 'assistant' ? live.content.flatMap(block => block.type === 'toolCall' ? [block.id] : []).join('\u0000') : ''
  const cached = historyCache.get(branch.items)
  let history: PiTimelineItem[]
  if (cached && cached.stableEntryIds === branch.client?.stableEntryIds && cached.toolExecutions === branch.client?.toolExecutions && cached.liveCallKey === liveCallKey) {
    history = cached.items
  } else {
    history = buildPiHistoryItems(branch).map(reuseHistoryItem)
    historyCache.set(branch.items, { items: history, stableEntryIds: branch.client?.stableEntryIds, toolExecutions: branch.client?.toolExecutions, liveCallKey })
  }

  const liveItems = buildPiLiveItems(branch)
  if (liveItems.length === 0) return history
  return history.concat(liveItems)
}

/** Drop all cached timeline items (server switch / logout). */
export function clearPiTimelineItemCache(): void {
  historyCache = new WeakMap()
  entryCache = new WeakMap()
}
