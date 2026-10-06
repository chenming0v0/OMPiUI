import type { PiAssistantMessageItem, PiTimelineItem } from '../../omp/domain/index.js'

/**
 * Chat timeline visibility: filters items without renderable content and
 * merges trailing tool-only assistant items into the preceding one, so a
 * tool call chain renders as one continuous message.
 */

function itemHasContent(item: PiTimelineItem): boolean {
  if (item.kind === 'user_message') {
    return item.blocks.some(block => block.type === 'text' ? block.text.trim().length > 0 : true)
  }
  if (item.kind === 'assistant_message') {
    const hasRenderable = item.blocks.some(block =>
      block.type === 'text'
        ? block.text.trim().length > 0
        : block.type === 'thinking'
          ? block.thinking.trim().length > 0
          : true,
    )
    // 有非 abort 错误的助手消息始终可见（展示错误信息）。
    // abort 只有在已经产生可见内容时才显示；空 abort 不占信息流位置。
    if (item.message.stopReason === 'error') return true
    if (item.message.stopReason === 'aborted') return hasRenderable
    return hasRenderable
  }
  // bash/compaction/summary/custom/label/unknown 等系统条目始终保留（不静默丢弃）
  return true
}

function endsWithTool(item: PiTimelineItem): boolean {
  if (item.kind !== 'assistant_message' || item.blocks.length === 0 || item.message.errorMessage) return false
  for (let i = item.blocks.length - 1; i >= 0; i--) {
    const block = item.blocks[i]
    // skip empty thinking / empty text — they carry no visible content
    if (block.type === 'thinking' && block.thinking.trim().length === 0) continue
    if (block.type === 'text' && block.text.trim().length === 0) continue
    return block.type === 'toolCall'
  }
  return false
}

function startsWithTool(item: PiTimelineItem): boolean {
  if (item.kind !== 'assistant_message') return false
  for (const block of item.blocks) {
    if (block.type === 'thinking' && !block.thinking.trim()) continue
    if (block.type === 'text' && !block.text.trim()) continue
    return block.type === 'toolCall'
  }
  return false
}

export interface VisibleTimelineEntry {
  item: PiTimelineItem
  sourceIds: string[]
}

export function getVisibleTimelineForkTargetId(entry: VisibleTimelineEntry): string {
  return entry.sourceIds[entry.sourceIds.length - 1] || entry.item.entryId
}

/**
 * Merge-result cache: `buildVisibleTimelineEntries` merges trailing tool-only
 * assistant items into the preceding one, creating a NEW merged object on
 * every call. During streaming the items array is a fresh reference each
 * chunk, so without this cache every historical tool message would be
 * re-merged into a new object → VirtualRow memo (compares `item` reference)
 * fails for all visible rows → full re-render per token.
 *
 * The cache keys on the *input item references* of each merge chain — those
 * stay stable across chunks (timelineCache keeps history item identity), so
 * the merged output object is reused verbatim until a participant actually
 * changes.
 */
const mergeCache = new Map<object, { chain: readonly object[]; merged: PiAssistantMessageItem }>()
const MERGE_CACHE_LIMIT = 128

/** 清空 merge 缓存：测试隔离 / 服务器切换时调用（缓存 key 是对象引用，
 *  旧数据对象不会与新数据撞 key，但显式清理避免内存残留）。 */
export function clearVisibleTimelineMergeCache(): void {
  mergeCache.clear()
}

/** 命中：merge 链首条引用相同，且整条链引用逐一相同（任何参与者变化即 miss） */
function lookupMerge(first: PiTimelineItem, chain: readonly object[]): PiAssistantMessageItem | undefined {
  const cached = mergeCache.get(first)
  if (!cached || cached.chain.length !== chain.length) return undefined
  for (let k = 0; k < chain.length; k++) {
    if (cached.chain[k] !== chain[k]) return undefined
  }
  return cached.merged
}

function storeMerge(first: PiTimelineItem, chain: readonly object[], merged: PiAssistantMessageItem): void {
  mergeCache.set(first, { chain, merged })
  if (mergeCache.size > MERGE_CACHE_LIMIT) {
    mergeCache.delete(mergeCache.keys().next().value!)
  }
}

export function buildVisibleTimelineEntries(items: PiTimelineItem[]): VisibleTimelineEntry[] {
  // 防御性去重：保证输入无重复 ID
  const seenIds = new Set<string>()
  const unique: PiTimelineItem[] = []
  for (const item of items) {
    if (!seenIds.has(item.entryId)) {
      seenIds.add(item.entryId)
      unique.push(item)
    }
  }
  // Even an empty user message ends the previous assistant tool run.
  const filtered = unique.filter(item => item.kind === 'user_message' || itemHasContent(item))
  const result: VisibleTimelineEntry[] = []

  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i]
    if (!itemHasContent(item)) continue
    if (!endsWithTool(item)) {
      result.push({ item, sourceIds: [item.entryId] })
      continue
    }

    const sourceIds = [item.entryId]
    let j = i + 1

    while (j < filtered.length && startsWithTool(filtered[j])) {
      sourceIds.push(filtered[j].entryId)
      j++
      if (!endsWithTool(filtered[j - 1])) break
    }

    if (j === i + 1) {
      result.push({ item, sourceIds })
    } else {
      const mergedItems = filtered.slice(i + 1, j) as PiAssistantMessageItem[]
      const first = item as PiAssistantMessageItem
      const last = mergedItems[mergedItems.length - 1]
      const chain = [first, ...mergedItems]
      let merged = lookupMerge(first, chain)
      if (!merged) {
        merged = {
          ...first,
          // message 取最后一条（最新模型状态/stopReason）
          message: last.message,
          isStreaming: last.isStreaming,
          blocks: [...first.blocks, ...mergedItems.flatMap(m => m.blocks)],
          toolResults: Object.assign({}, first.toolResults, ...mergedItems.map(m => m.toolResults)),
          toolCallTimestamps: Object.fromEntries(chain.flatMap(m =>
            m.blocks.flatMap(block => block.type === 'toolCall'
              ? [[block.id, m.toolCallTimestamps?.[block.id] ?? m.timestamp]]
              : []),
          )),
        }
        storeMerge(first, chain, merged)
      }
      result.push({ item: merged, sourceIds })
      i = j - 1
    }
  }

  return result
}
