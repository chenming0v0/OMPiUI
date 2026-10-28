import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { push } = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('../../store/notificationStore', () => ({ notificationStore: { push } }))
vi.mock('../../i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'detail' in options ? `${key}:${String(options.detail)}` : key,
  },
}))

import { ACCEPTED_SYNC_TIMEOUT_MS, pendingSendStore, type PendingSendAlert } from './pendingSendStore'
import { createPendingSend } from './pendingSend'

function begin(overrides: { sessionId?: string | null; serverGeneration?: number; text?: string } = {}) {
  const send = createPendingSend(
    overrides.sessionId === undefined ? 'session-a' : overrides.sessionId,
    overrides.serverGeneration ?? 1,
    overrides.text ?? 'hello',
    [],
    [],
  )
  pendingSendStore.begin(send)
  return send
}

describe('pendingSendStore', () => {
  beforeEach(() => {
    pendingSendStore.reset()
    push.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    pendingSendStore.reset()
  })

  it('starts a send as submitting and keeps it across listener churn (remount)', () => {
    const send = begin()
    expect(pendingSendStore.getSnapshot().map(item => item.id)).toEqual([send.id])
    expect(pendingSendStore.getSnapshot()[0].phase).toBe('submitting')

    const unsubscribe = pendingSendStore.subscribe(() => undefined)
    unsubscribe()
    // 组件卸载不等于请求结束：pending 由请求生命周期决定，不能被挂载时机清掉。
    expect(pendingSendStore.getSnapshot().map(item => item.id)).toEqual([send.id])
  })

  it('removes the pending row and reports a visible failure when the send fails', () => {
    const send = begin()
    const alerts: PendingSendAlert[] = []
    const off = pendingSendStore.onAlert(alert => alerts.push(alert))

    pendingSendStore.fail(send.id, Object.assign(new Error('http://x/api 500 {"code":"INTERNAL"}'), { code: 'INTERNAL' }))

    expect(pendingSendStore.getSnapshot()).toEqual([])
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toBe('error')
    expect(String(push.mock.calls[0][2])).toContain('INTERNAL')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ sessionId: 'session-a', serverGeneration: 1, kind: 'rejected' })
    off()
  })

  it('reports a timeout failure instead of hanging', () => {
    const send = begin()
    pendingSendStore.fail(send.id, Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }))
    expect(pendingSendStore.getSnapshot()).toEqual([])
    expect(push.mock.calls[0][2]).toBe('chat:chatArea.sendTimedOutBody')
  })

  it('drops an accepted send once its native row never arrives', () => {
    vi.useFakeTimers()
    const send = begin()
    const alerts: PendingSendAlert[] = []
    const off = pendingSendStore.onAlert(alert => alerts.push(alert))

    pendingSendStore.accept(send.id)
    expect(pendingSendStore.getSnapshot()[0].phase).toBe('accepted')

    vi.advanceTimersByTime(ACCEPTED_SYNC_TIMEOUT_MS - 1)
    expect(pendingSendStore.getSnapshot()).toHaveLength(1)

    vi.advanceTimersByTime(1)
    expect(pendingSendStore.getSnapshot()).toEqual([])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe('not-synced')
    off()
  })

  it('settles accepted sends when the native history owns them (no leftover pending)', () => {
    const send = begin()
    pendingSendStore.accept(send.id)
    pendingSendStore.settle(send.id)
    expect(pendingSendStore.getSnapshot()).toEqual([])
    // 幂等：失败路径的 finally 再调一次不会炸。
    pendingSendStore.settle(send.id)
    expect(pendingSendStore.getSnapshot()).toEqual([])
  })

  it('only accepts sends that are still submitting and isolates sessions', () => {
    const first = begin({ sessionId: 'session-a' })
    const second = begin({ sessionId: 'session-b', serverGeneration: 2, text: 'other' })

    pendingSendStore.settle(first.id)
    pendingSendStore.accept(first.id)
    expect(pendingSendStore.getSnapshot().map(item => item.id)).toEqual([second.id])

    pendingSendStore.update(current => current.map(send => ({ ...send, phase: 'queued' as const })))
    pendingSendStore.accept(second.id)
    expect(pendingSendStore.getSnapshot()[0].phase).toBe('queued')
  })
})
