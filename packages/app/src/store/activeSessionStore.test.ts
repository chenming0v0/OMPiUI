import { beforeEach, describe, expect, it } from 'vitest'
import { activeSessionStore } from './activeSessionStore'

describe('activeSessionStore scoped refresh handling', () => {
  beforeEach(() => {
    activeSessionStore.initialize({})
    activeSessionStore.initializePendingRequests([], [])
  })

  it('preserves existing busy child sessions when merging scoped status refreshes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
      child: { type: 'busy' },
    })

    activeSessionStore.mergeStatusRefresh({
      root: { type: 'busy' },
    })

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['root', 'child'])
  })

  it('drops missing sessions on full status replacement refreshes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
      child: { type: 'busy' },
    })

    activeSessionStore.initialize({
      root: { type: 'busy' },
    })

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['root'])
  })

  it('keeps existing pending child requests during scoped pending refresh merges', () => {
    activeSessionStore.addPendingRequest('req-child', 'child', 'question', 'Need approval')

    activeSessionStore.mergePendingRequests([], [])

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['child'])
    expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
      type: 'question',
      description: 'Need approval',
    })
  })

  it('reuses the busySessions array reference when content is unchanged', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
    })
    activeSessionStore.setSessionMeta('root', 'Root', '/repo')

    const first = activeSessionStore.getBusySessionsSnapshot()
    activeSessionStore.mergeStatusRefresh({
      root: { type: 'busy' },
    })
    const second = activeSessionStore.getBusySessionsSnapshot()

    expect(second).toBe(first)
    expect(second).toEqual([
      {
        sessionId: 'root',
        status: { type: 'busy' },
        title: 'Root',
        directory: '/repo',
        pendingAction: undefined,
      },
    ])
  })

  it('replaces the busySessions array reference when status content changes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
    })
    const first = activeSessionStore.getBusySessionsSnapshot()

    activeSessionStore.updateStatus('root', {
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: 1000,
    })
    const second = activeSessionStore.getBusySessionsSnapshot()

    expect(second).not.toBe(first)
    expect(second[0]?.status).toEqual({
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: 1000,
    })
  })

  it('settles native request IDs only in their originating session', () => {
    activeSessionStore.addPendingRequest('same', 'S', 'question', 'S input')
    activeSessionStore.addPendingRequest('same', 'T', 'question', 'T input')
    activeSessionStore.updateStatus('S', { type: 'idle' })
    activeSessionStore.updateStatus('T', { type: 'idle' })
    activeSessionStore.resolvePendingRequest('same', 'S')
    activeSessionStore.resolvePendingRequest('same', 'S')
    activeSessionStore.resolvePendingRequest('unknown', 'T')
    expect(activeSessionStore.getBusySessions().map(row => [row.sessionId, row.pendingAction?.description])).toEqual([['T', 'T input']])
    activeSessionStore.resolvePendingRequest('same', 'T')
    expect(activeSessionStore.getBusySessions()).toEqual([])
  })

})
