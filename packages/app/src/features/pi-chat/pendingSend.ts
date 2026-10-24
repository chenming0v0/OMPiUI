import type { PiTimelineItem, PiUserMessageItem } from '../../omp/domain/index.js'

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
  phase: 'submitting' | 'accepted'
  baselineTimestamps: ReadonlySet<number>
  baselineQueueIds: ReadonlySet<string>
  queueEntryId?: string
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
): PendingSend {
  return {
    id: crypto.randomUUID(), timestamp: Date.now(), sessionId, serverGeneration, text, images,
    phase: 'submitting', queueEntryId,
    baselineTimestamps: new Set(items.filter(item => item.kind === 'user_message').map(item => item.timestamp)),
    baselineQueueIds: new Set(queueEntries.map(entry => entry.entryId)),
  }
}

/**
 * A new native user row owns its content immediately, even before command ACK.
 * Pre-send timestamps exclude old identical messages without comparing clocks.
 * Native history may contain lazy image references instead of original base64.
 */
export function reconcilePendingSends(pending: readonly PendingSend[], items: readonly PiTimelineItem[]): readonly PendingSend[] {

  const consumed = new Set<number>()
  const remaining = pending.filter(send => {
    const native = items.find(item => {
      if (item.kind !== 'user_message' || send.baselineTimestamps.has(item.timestamp) || consumed.has(item.timestamp)) return false
      const content = typeof item.message.content === 'string' ? [{ type: 'text' as const, text: item.message.content }] : item.message.content
      if (send.text !== content.filter(block => block.type === 'text').map(block => block.text).join('')) return false
      const images = content.filter(block => block.type === 'image')
      return images.length === send.images.length && send.images.every((image, index) => {
        const actual = images[index]
        return actual.mimeType === image.mimeType && (!image.data || !actual.data || actual.data.startsWith('blob:sha256:') || actual.data === image.data || 'attachment' in actual)
      })
    })
    if (!native) return true
    consumed.add(native.timestamp)
    return false
  })
  return remaining.length === pending.length ? pending : remaining
}

/** A regular send is already visible in the native queue; Send now owns a separate preview. */
export function reconcileQueuedPendingSends(
  pending: readonly PendingSend[],
  entries: readonly { entryId: string; text: string; images?: readonly PendingSendImage[] }[],
): readonly PendingSend[] {
  const consumed = new Set<string>()
  const remaining = pending.filter(send => {
    if (send.phase !== 'accepted' || send.queueEntryId) return true
    const queued = entries.find(entry => !consumed.has(entry.entryId) &&
      !send.baselineQueueIds.has(entry.entryId) && entry.text === send.text &&
      (entry.images?.length ?? 0) === send.images.length)
    if (!queued) return true
    consumed.add(queued.entryId)
    return false
  })
  return remaining.length === pending.length ? pending : remaining
}
export function appendPendingSends(items: PiTimelineItem[], pending: readonly PendingSend[], sessionId: string | null, imageLabel: (count: number) => string): PiTimelineItem[] {
  const appended = reconcilePendingSends(pending.filter(send => send.sessionId === sessionId), items)
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
