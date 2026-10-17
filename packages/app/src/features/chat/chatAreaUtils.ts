import type { Virtualizer } from '@tanstack/virtual-core'
import type { ProcessTimelineItem } from './chatPageModel'

/** 回合边界 / 用户消息：上下各 12px */
const ROW_Y_TURN = 'py-3'
/** 连续助手流：上下各 4px，相邻两行合计 8px（对齐消息内 stack gap） */
const ROW_Y_ASSISTANT_STACK = 'py-1'
const ROW_Y_ASSISTANT_AFTER_USER = 'pt-3 pb-1'
const ROW_Y_ASSISTANT_BEFORE_USER = 'pt-1 pb-3'

function isAssistantMessageItem(item: ProcessTimelineItem | undefined): boolean {
  return item?.kind === 'message' && item.item.kind === 'assistant_message'
}

/**
 * 用户和过程壳保留回合边界；连续助手按消息内 stack 节奏收紧。
 * 连续助手 py-1+py-1=8px，与 MSG_SPACING.stack / processBody 的 gap-2 同距。
 */
export function getTimelineRowYClass(
  item: ProcessTimelineItem,
  prev?: ProcessTimelineItem,
  next?: ProcessTimelineItem,
): string {
  if (item.kind === 'process-shell' || item.item.kind === 'user_message') return ROW_Y_TURN

  const prevAssistant = isAssistantMessageItem(prev)
  const nextAssistant = isAssistantMessageItem(next)
  if (prevAssistant && nextAssistant) return ROW_Y_ASSISTANT_STACK
  if (prevAssistant) return ROW_Y_ASSISTANT_BEFORE_USER
  if (nextAssistant) return ROW_Y_ASSISTANT_AFTER_USER
  return ROW_Y_TURN
}

/** 流式热行 index：末 1～2 行，避免 virtual range 边界卸载正在生成的行 */
export function getStreamingHotIndexes(count: number, isStreaming: boolean): number[] {
  if (!isStreaming || count <= 0) return []
  if (count === 1) return [0]
  return [count - 2, count - 1]
}

/** 合并可见行与固定行，排除列表缩短后尚未清理的旧索引。 */
export function mergeVirtualRangeIndexes(base: number[], count: number, ...pinnedGroups: number[][]): number[] {
  const pinned = pinnedGroups.flat()
  if (pinned.length === 0) return base
  return [...new Set([...pinned, ...base])]
    .filter(index => index >= 0 && index < count)
    .sort((a, b) => a - b)
}

/** Validate against the current measurements, before virtual-core materializes rows.
 * A render-only filter is too late: directDomUpdates reads each row's start first.
 */
export function guardVirtualizerRange<TScroll extends Element, TItem extends Element>(
  virtualizer: Virtualizer<TScroll, TItem>,
): void {
  const getVirtualIndexes = virtualizer.getVirtualIndexes
  virtualizer.getVirtualIndexes = Object.assign(() => {
    const indexes = getVirtualIndexes()
    const measurements = virtualizer.measurementsCache
    const count = Math.min(virtualizer.options.count, measurements.length)
    let valid: number[] | undefined
    for (let i = 0; i < indexes.length; i++) {
      const index = indexes[i]
      if (Number.isInteger(index) && index >= 0 && index < count && measurements[index] !== undefined) {
        valid?.push(index)
      } else {
        valid ??= indexes.slice(0, i)
      }
    }
    // Keep the memoized reference, and allocate nothing, on the normal path.
    return valid ?? indexes
  }, { updateDeps: getVirtualIndexes.updateDeps })
}
