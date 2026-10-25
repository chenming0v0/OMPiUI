import { describe, expect, it } from 'vitest'
import { appendPendingSends, appendPendingQueueEntries, createPendingSend, reconcilePendingSends, reconcileQueuedPendingSends, withoutQueueEntry } from './pendingSend'
import type { PiTimelineItem } from '../../omp/domain'

const label = (count: number) => `${count} image(s)`
function native(text: string, timestamp: number, images: object[] = []): PiTimelineItem {
  return { kind: 'user_message', entryId: `native:${timestamp}`, timestamp,
    message: { role: 'user', timestamp, content: [{ type: 'text', text }, ...images] },
    blocks: [{ type: 'text', text }, ...images],
  } as PiTimelineItem
}

describe('pending user message handoff', () => {
  it('keeps two busy submissions out of history across pre-ACK queue arrival and consumption', () => {
    const first = createPendingSend('session', 1, 'first queued', [], [], undefined, [], 'followUp')
    const second = createPendingSend('session', 1, 'second queued', [], [], undefined, [], 'followUp')
    let pending = [first, second]
    expect(appendPendingSends([], pending, 'session', label)).toEqual([])
    expect(appendPendingQueueEntries([], pending, 'followUp').map(entry => [entry.text, entry.pending])).toEqual([['first queued', true], ['second queued', true]])

    const queue = [{ entryId: 'native-first', text: first.text }, { entryId: 'native-second', text: second.text }]
    pending = [...reconcileQueuedPendingSends(pending, queue)]
    expect(pending.map(send => send.queueEntryId)).toEqual(['native-first', 'native-second'])
    expect(appendPendingQueueEntries(queue, pending, 'followUp')).toBe(queue)
    expect(appendPendingSends([], pending, 'session', label)).toEqual([])

    pending = [...reconcileQueuedPendingSends(pending, queue.slice(1))]
    const history = [native(first.text, 100)]
    expect(appendPendingSends(history, pending, 'session', label)).toBe(history)
    expect(appendPendingQueueEntries(queue.slice(1), pending, 'followUp').map(entry => entry.text)).toEqual([second.text])
    expect(reconcileQueuedPendingSends(pending, [])).toEqual([])
  })

  it('hands a busy send directly to history if the foreground ended before native dispatch', () => {
    const pending = createPendingSend('session', 1, 'ready now', [], [], undefined, [], 'followUp')
    const history = [native(pending.text, 101)]
    const remaining = reconcilePendingSends([pending], history)
    expect(remaining).toEqual([])
    expect(appendPendingQueueEntries([], remaining, 'followUp')).toEqual([])
    expect(appendPendingSends(history, remaining, 'session', label)).toBe(history)
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

  it('keeps Send now in the native queue until history takes ownership', () => {
    const queued = { entryId: 'q2', text: 'now please' }
    const promoted = createPendingSend('session', 1, queued.text, [], [], queued.entryId, [queued], 'steering')
    const before = reconcileQueuedPendingSends([promoted], [queued])
    expect(appendPendingSends([], before, 'session', label)).toEqual([])
    expect(appendPendingQueueEntries([queued], before, 'steering')).toEqual([queued])
    expect(appendPendingSends([], [promoted], 'session', label)).toEqual([])
    const rows = [native(queued.text, 102)]
    expect(appendPendingSends(rows, reconcilePendingSends([promoted], rows), 'session', label)).toBe(rows)
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
