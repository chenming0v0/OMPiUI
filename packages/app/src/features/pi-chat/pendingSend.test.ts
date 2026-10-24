import { describe, expect, it } from 'vitest'
import { appendPendingSends, createPendingSend, reconcilePendingSends, reconcileQueuedPendingSends } from './pendingSend'
import type { PiTimelineItem } from '../../omp/domain'

const label = (count: number) => `${count} image(s)`
function native(text: string, timestamp: number, images: object[] = []): PiTimelineItem {
  return { kind: 'user_message', entryId: `native:${timestamp}`, timestamp,
    message: { role: 'user', timestamp, content: [{ type: 'text', text }, ...images] },
    blocks: [{ type: 'text', text }, ...images],
  } as PiTimelineItem
}

describe('pending user message handoff', () => {
  it('hands an accepted normal send to the native queue without duplicating a Send now preview', () => {
    const queued = { entryId: 'new-queue-entry', text: 'follow up' }
    const regular = { ...createPendingSend('session', 1, queued.text, [], []), phase: 'accepted' as const }
    const promoted = { ...createPendingSend('session', 1, queued.text, [], [], queued.entryId), phase: 'accepted' as const }
    expect(reconcileQueuedPendingSends([regular, promoted], [queued])).toEqual([promoted])
    const older = { ...createPendingSend('session', 1, queued.text, [], [], undefined, [queued]), phase: 'accepted' as const }
    expect(reconcileQueuedPendingSends([older], [queued])).toEqual([older])
    expect(reconcileQueuedPendingSends([{ ...regular, phase: 'submitting' }], [queued])).toMatchObject([{ phase: 'submitting' }])
  })

  it('renders before session creation and keeps a stable timestamp without changing native history', () => {
    const pending = createPendingSend(null, 1, 'first prompt', [], [])
    const items: PiTimelineItem[] = []
    const first = appendPendingSends(items, [pending], null, label)[0]
    expect(first).toMatchObject({ kind: 'user_message', entryId: `submitted:local:${pending.id}`, timestamp: pending.timestamp, blocks: [{ type: 'text', text: 'first prompt' }] })
    expect(appendPendingSends(items, [pending], null, label)[0].timestamp).toBe(first.timestamp)
    expect(items).toEqual([])
    expect(appendPendingSends(items, [pending], 'another-session', label)).toBe(items)
  })

  it('does not consume a new identical send with an older historical message', () => {
    const old = native('repeat', 1)
    const pending = createPendingSend('session', 1, 'repeat', [], [old])
    expect(reconcilePendingSends([pending], [old])).toEqual([pending])
    const fresh = native('repeat', 2)
    expect(reconcilePendingSends([pending], [old, fresh])).toEqual([])
    expect(appendPendingSends([old, fresh], [pending], 'session', label)).toEqual([old, fresh])
  })

  it('hands each repeated send to a distinct native row and recognizes lazy image persistence', () => {
    const one = createPendingSend('session', 1, 'same', [{ mimeType: 'image/png', data: 'AA==' }], [])
    const two = createPendingSend('session', 1, 'same', [{ mimeType: 'image/png', data: 'AA==' }], [])
    const row = native('same', 12, [{ type: 'image', mimeType: 'image/png', data: 'blob:sha256:stored' }])
    expect(reconcilePendingSends([one, two], [row])).toEqual([two])
    expect(reconcilePendingSends([one], [native('same', 13, [{ type: 'image', mimeType: 'image/png', data: 'different' }])])).toEqual([one])
  })
})
