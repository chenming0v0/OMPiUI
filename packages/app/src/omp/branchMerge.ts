import type { PiBranchPage } from './domain/index.js'

function matchesLiveMessage(
  entry: PiBranchPage['items'][number],
  live: NonNullable<NonNullable<PiBranchPage['checkpoint']>['liveMessage']>,
): boolean {
  if (entry.type !== 'message' || entry.message.role !== live.message.role) return false
  if (entry.id === live.id) return true
  // 流式参数可能还没生成完整，调用 ID 比内容比较更可靠。
  if (entry.message.role === 'assistant' && live.message.role === 'assistant') {
    const callIds = new Set(live.message.content.filter(block => block.type === 'toolCall').map(block => block.id))
    if (entry.message.content.some(block => block.type === 'toolCall' && callIds.has(block.id))) return true
  }
  if (!('content' in entry.message) || !('content' in live.message)) return false
  const a = entry.message.content
  const b = live.message.content
  // 快速预筛：长度不同直接不等，避免深序列化（流式落盘时内容通常完全一致）
  if (a === b) return true
  const aLen = typeof a === 'string' ? a.length : (a as unknown[]).length
  const bLen = typeof b === 'string' ? b.length : (b as unknown[]).length
  if (aLen !== bLen) return false
  // 内容结构相同时再做深比较（仅在长度相等时触发，成本可控）
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Merge a freshly-fetched latest page with locally held branch data.
 *
 * Local data may contain older items loaded via pagination. Rules:
 * - 历史 epoch 变化：丢弃旧分页；同一事件流内保留较新的实时消息。
 * - Local leaf no longer in the latest page: branch moved (tree
 *   navigation/undo) — local data is stale, take latest wholesale.
 *   TUI parity: navigateTree rebuilds the context wholesale.
 * - Overlapping items (by entry id): latest page wins; older local items
 *   not in the latest page are kept in front.
 * - No overlap at all: branch structure changed (fork/tree navigation) —
 *   local history is stale, take latest wholesale.
 * - When older items survive, keep local beforeCursor/hasMore (they
 *   describe the oldest local edge); otherwise take latest page's.
 */
export function mergeLatestBranchPage(current: PiBranchPage | null, latest: PiBranchPage): PiBranchPage {
  if (!current) return latest

  const withClientState = (page: PiBranchPage): PiBranchPage => {
    const stableEntryIds = { ...page.client?.stableEntryIds, ...current.client?.stableEntryIds }
    const liveMessage = current.checkpoint?.liveMessage
    const persistedMatch = liveMessage
      ? [...page.items].reverse().find(entry => matchesLiveMessage(entry, liveMessage))
      : undefined

    if (persistedMatch && liveMessage) stableEntryIds[persistedMatch.id] = liveMessage.id

    // 较旧快照保留新思考；同序号或更新的快照没有 live 时，旧消息已结束。
    const localPosition = current.checkpoint?.position
    const remotePosition = page.checkpoint?.position
    const sameStream = !remotePosition || localPosition?.epoch === remotePosition.epoch
    const localIsNewer =
      sameStream && localPosition && remotePosition && localPosition.sequence > remotePosition.sequence
    const checkpoint =
      liveMessage &&
      !persistedMatch &&
      sameStream &&
      (localIsNewer || !remotePosition || page.checkpoint?.liveMessageOmitted)
        ? localIsNewer || !remotePosition
          ? current.checkpoint
          : { ...current.checkpoint!, position: remotePosition }
        : page.checkpoint

    if (checkpoint === page.checkpoint && Object.keys(stableEntryIds).length === 0) return page
    return {
      ...page,
      checkpoint,
      client: Object.keys(stableEntryIds).length > 0 ? { ...page.client, stableEntryIds } : page.client,
    }
  }

  if (current.client?.historyWindowed) {
    return withClientState({
      ...current,
      head: latest.head,
      checkpoint: latest.checkpoint,
      syncCursor: latest.syncCursor,
    })
  }

  if (latest.deltaFrom) {
    // 增量只对匹配的基线有效；控制器在竞争导致失配时重新读取完整页。
    if (current.syncCursor !== latest.deltaFrom) return current
    const seenIds = new Set(current.items.map(item => item.id))
    const appended = latest.items.filter(item => {
      if (seenIds.has(item.id)) return false
      seenIds.add(item.id)
      return true
    })
    return withClientState({
      ...latest,
      deltaFrom: undefined,
      items: [...current.items, ...appended],
    })
  }

  if (current.head.epoch !== latest.head.epoch) {
    // OMP 历史 epoch 随条目数量变化；同一事件流仍需交接较新的 live 消息。
    return current.checkpoint &&
      latest.checkpoint &&
      current.checkpoint.position.epoch === latest.checkpoint.position.epoch
      ? withClientState(latest)
      : latest
  }

  const latestIds = new Set(latest.items.map(item => item.id))

  const localLeaf = current.items[current.items.length - 1]
  if (localLeaf && !latestIds.has(localLeaf.id)) return latest

  const olderKept = current.items.filter(item => !latestIds.has(item.id))

  if (olderKept.length === 0) return withClientState(latest)
  if (olderKept.length === current.items.length) return withClientState(latest)

  return withClientState({
    ...latest,
    items: [...olderKept, ...latest.items],
    beforeCursor: current.beforeCursor ?? latest.beforeCursor,
    hasMore: current.hasMore || latest.hasMore,
  })
}
