import type { PiTimelineItem, PiUserMessageItem } from '../../omp/domain/index.js'
import type { ComposerQueueEntry } from '../chat/input/QueuedUserMessageQueue'

export interface PendingSendImage {
  mimeType?: string
  data?: string
}

export interface PendingSend {
  id: string
  timestamp: number
  sessionId: string | null
  serverGeneration: number
  text: string
  images: readonly PendingSendImage[]
  /** queued：普通发送已出现在原生队列并绑定 queueEntryId，由队列 UI 展示。 */
  phase: 'submitting' | 'accepted' | 'queued'
  baselineTimestamps: ReadonlySet<number>
  baselineQueueIds: ReadonlySet<string>
  queueEntryId?: string
  queueKind?: 'steering' | 'followUp'
}

/** Display-only state. Never write a synthetic entry or timestamp to history. */
export function createPendingSend(
  sessionId: string | null,
  serverGeneration: number,
  text: string,
  images: readonly PendingSendImage[],
  items: readonly PiTimelineItem[],
  queueEntryId?: string,
  queueEntries: readonly { entryId: string }[] = [],
  queueKind?: PendingSend['queueKind'],
): PendingSend {
  return {
    id: crypto.randomUUID(), timestamp: Date.now(), sessionId, serverGeneration, text, images,
    phase: 'submitting', queueEntryId, queueKind,
    baselineTimestamps: new Set(items.filter(item => item.kind === 'user_message').map(item => item.timestamp)),
    baselineQueueIds: new Set(queueEntries.map(entry => entry.entryId)),
  }
}

/**
 * A new native user row owns its content immediately, even before command ACK.
 * Pre-send timestamps exclude old identical messages without comparing clocks.
 * Native history may contain lazy image references or re-encoded images.
 */
export function reconcilePendingSends<T extends PendingSend>(pending: readonly T[], items: readonly PiTimelineItem[]): readonly T[] {

  const consumed = new Set<number>()
  const remaining = pending.filter(send => {
    // 已绑定队列条目的发送只由队列生命周期清理，不被历史中的同文本行抢走。
    if (send.phase === 'queued') return true
    const native = items.find(item => {
      if (item.kind !== 'user_message' || send.baselineTimestamps.has(item.timestamp) || consumed.has(item.timestamp)) return false
      const content = typeof item.message.content === 'string' ? [{ type: 'text' as const, text: item.message.content }] : item.message.content
      if (send.text !== content.filter(block => block.type === 'text').map(block => block.text).join('')) return false
      // OMP 在落盘前会重编码图片（缩放、png→webp/jpeg），mimeType 与 data 都不是稳定身份。
      // 身份 = 发送后新出现的行 + 相同文本 + 相同图片数。
      return content.filter(block => block.type === 'image').length === send.images.length
    })
    if (!native) return true
    consumed.add(native.timestamp)
    return false
  })
  if (consumed.size === 0) return pending
  // 已被认领的 row 写入存活 pending 的基线，后续调用不能再次认领。
  return remaining.map(send => ({ ...send, baselineTimestamps: new Set([...send.baselineTimestamps, ...consumed]) }))
}

/**
 * A regular send that appears in the native queue is bound to that entryId
 * (phase 'queued'), so delete / back-to-input / Send now clear it by identity.
 * It is dropped once its entry leaves the queue. Send now owns a separate preview.
 */
export function reconcileQueuedPendingSends(
  pending: readonly PendingSend[],
  entries: readonly { entryId: string; text: string; images?: readonly PendingSendImage[] }[],
): readonly PendingSend[] {
  const live = new Set(entries.map(entry => entry.entryId))
  const claimed = new Set(pending.flatMap(send => send.phase === 'queued' && send.queueEntryId ? [send.queueEntryId] : []))
  let changed = false
  const next = pending.flatMap(send => {
    if (send.phase === 'queued') return live.has(send.queueEntryId ?? '') ? [send] : (changed = true, [])
    if (send.queueEntryId) {
      if (!live.has(send.queueEntryId)) return [send]
      changed = true
      return [{ ...send, phase: 'queued' as const }]
    }
    const queued = entries.find(entry => !claimed.has(entry.entryId) &&
      !send.baselineQueueIds.has(entry.entryId) && entry.text === send.text &&
      (entry.images?.length ?? 0) === send.images.length)
    if (!queued) return [send]
    claimed.add(queued.entryId)
    changed = true
    return [{ ...send, phase: 'queued' as const, queueEntryId: queued.entryId }]
  })
  return changed ? next : pending
}

/** 删除 / 移回输入框 / 立即发送：按原生队列 entryId 同源清理，不做文本匹配。 */
export function withoutQueueEntry(pending: readonly PendingSend[], serverGeneration: number, sessionId: string | null, entryId: string): PendingSend[] {
  return pending.filter(send => send.serverGeneration !== serverGeneration || send.sessionId !== sessionId || send.queueEntryId !== entryId)
}

type VisiblePendingSend = PendingSend & { phase: 'submitting' | 'accepted' }

export function appendPendingSends(items: PiTimelineItem[], pending: readonly PendingSend[], sessionId: string | null, imageLabel: (count: number) => string): PiTimelineItem[] {
  // 已排队的普通发送由队列 UI 展示，不在时间线重复出现。
  const visible = pending.filter((send): send is VisiblePendingSend => send.sessionId === sessionId && send.phase !== 'queued' && !send.queueKind)
  const appended = reconcilePendingSends(visible, items)
    .map(send => {
      const timestamp = send.timestamp
      const id = `submitted:local:${send.id}`
      const previewImages = send.images.flatMap(image => typeof image.data === 'string' && typeof image.mimeType === 'string' ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : [])
      const text = send.images.length > previewImages.length ? `${send.text}${send.text ? '\n' : ''}${imageLabel(send.images.length)}` : send.text
      const blocks = [{ type: 'text' as const, text }, ...previewImages]
      return {
        kind: 'user_message', entryId: id, timestamp, submissionStatus: send.phase,
        rawEntry: { type: 'message', id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: 'user' as const, content: blocks, timestamp } },
        message: { role: 'user' as const, content: blocks, timestamp }, blocks,
      } as PiUserMessageItem
    })
  return appended.length > 0 ? [...items, ...appended] : items
}

/** Keep busy submissions in the queue rail from their first render through native admission. */
export function appendPendingQueueEntries(entries: readonly ComposerQueueEntry[], pending: readonly PendingSend[], kind: 'steering' | 'followUp'): readonly ComposerQueueEntry[] {
  const local = reconcileQueuedPendingSends(pending, entries).filter(send => send.queueKind === kind && send.phase !== 'queued')
  return local.length === 0 ? entries : [...entries, ...local.map(send => ({ entryId: `submitted:local:${send.id}`, text: send.text, images: send.images, pending: true }))]
}
