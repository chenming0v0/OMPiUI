import { describe, expect, it } from 'vitest'
import { appendPendingSends, createPendingSend, reconcilePendingSends, reconcileQueuedPendingSends, withoutQueueEntry } from './pendingSend'
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
    const handed = reconcileQueuedPendingSends([regular, promoted], [queued])
    expect(handed).toEqual([{ ...regular, phase: 'queued', queueEntryId: queued.entryId }, promoted])
    expect(appendPendingSends([], handed, 'session', label).map(item => item.entryId)).toEqual([`submitted:local:${promoted.id}`])
    const older = { ...createPendingSend('session', 1, queued.text, [], [], undefined, [queued]), phase: 'accepted' as const }
    expect(reconcileQueuedPendingSends([older], [queued])).toEqual([older])
    expect(reconcileQueuedPendingSends([{ ...regular, phase: 'submitting' }], [queued])).toMatchObject([{ phase: 'submitting' }])
  })

  it('binds a queued regular send to its entryId so deleting the entry clears it', () => {
    const queued = { entryId: 'q1', text: 'later' }
    const regular = { ...createPendingSend('session', 1, queued.text, [], []), phase: 'accepted' as const }
    const bound = reconcileQueuedPendingSends([regular], [queued])
    expect(bound).toMatchObject([{ id: regular.id, phase: 'queued', queueEntryId: 'q1' }])
    expect(reconcileQueuedPendingSends(bound, [queued])).toBe(bound)
    expect(appendPendingSends([], bound, 'session', label)).toEqual([])
    // 删除 / 移回：按 entryId 清理，不做文本匹配；另一条同文本的未绑定发送不受影响。
    const sibling = { ...createPendingSend('session', 1, queued.text, [], []), phase: 'accepted' as const }
    expect(withoutQueueEntry([...bound, sibling], 1, 'session', 'q1')).toEqual([sibling])
    expect(withoutQueueEntry(bound, 1, 'other-session', 'q1')).toEqual(bound)
    // 条目被其他客户端删除或已出队：绑定的 pending 随之消失。
    expect(reconcileQueuedPendingSends(bound, [])).toEqual([])
  })

  it('replaces a queued regular send on Send now without duplicating the preview', () => {
    const queued = { entryId: 'q2', text: 'now please' }
    const regular = { ...createPendingSend('session', 1, queued.text, [], []), phase: 'accepted' as const }
    const bound = reconcileQueuedPendingSends([regular], [queued])
    const promoted = createPendingSend('session', 1, queued.text, [], [], queued.entryId)
    const next = [...withoutQueueEntry(bound, 1, 'session', queued.entryId), promoted]
    expect(next).toEqual([promoted])
    const visible = reconcileQueuedPendingSends(next, [])
    expect(appendPendingSends([], visible, 'session', label).map(item => item.entryId)).toEqual([`submitted:local:${promoted.id}`])
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
    expect(reconcilePendingSends([one, two], [row])).toMatchObject([{ id: two.id }])
    expect(reconcilePendingSends([one], [native('same', 13, [])])).toEqual([one])
  })

  it('hands off a send whose image OMP re-encoded before persisting (png -> webp)', () => {
    const pending = { ...createPendingSend('session', 1, 'what is this', [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }], []), phase: 'accepted' as const }
    const row = native('what is this', 30, [{ type: 'image', mimeType: 'image/webp', data: 'UklGRg==' }])
    expect(reconcilePendingSends([pending], [row])).toEqual([])
    expect(appendPendingSends([row], [pending], 'session', label)).toEqual([row])
  })

  it('does not let a consumed native row be claimed again by later reconciles', () => {
    const one = createPendingSend('session', 1, 'same', [], [])
    const two = createPendingSend('session', 1, 'same', [], [])
    const rows = [native('same', 20)]
    let pending = reconcilePendingSends([one, two], rows)
    for (let i = 0; i < 3; i += 1) pending = reconcilePendingSends(pending, rows)
    expect(pending.map(send => send.id)).toEqual([two.id])
    expect(reconcilePendingSends(pending, rows)).toBe(pending)
    expect(reconcilePendingSends(pending, [...rows, native('same', 21)])).toEqual([])
  })
})
