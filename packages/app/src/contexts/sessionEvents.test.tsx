import { act, cleanup, renderHook } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from './SessionContext'
import { SessionContext } from './SessionContext.shared'
import { useSessions } from '../hooks/useSessions'
import type { SessionInfo } from '../omp/vendor/pi-coding-agent'

const mocks = vi.hoisted(() => ({
  loadPiSessions: vi.fn<() => Promise<SessionInfo[]>>(),
  deletePiSession: vi.fn<() => Promise<void>>(),
  createPiSession: vi.fn(),
}))
vi.mock('../omp/controllers/index.js', () => mocks)
vi.mock('./useDirectory', () => ({ useDirectory: () => ({ currentDirectory: '/workspace' }) }))

function sessionInfo(id: string): SessionInfo {
  return {
    id, path: `/sessions/${id}.jsonl`, cwd: '/workspace', name: id,
    created: new Date('2026-01-01'), modified: new Date('2026-01-02'),
    firstMessage: id, allMessagesText: id, messageCount: 1,
  }
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function useBothLists() {
  return { context: useContext(SessionContext)!, independent: useSessions() }
}

describe('canonical session list events', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.loadPiSessions.mockResolvedValue([sessionInfo('old')])
    mocks.deletePiSession.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('refreshes both consumers exactly once for one canonical event', async () => {
    const { result, unmount } = renderHook(useBothLists, { wrapper: SessionProvider })
    await advance(0)
    expect(mocks.loadPiSessions).toHaveBeenCalledTimes(2)
    mocks.loadPiSessions.mockClear().mockResolvedValue([sessionInfo('fresh')])

    act(() => { window.dispatchEvent(new CustomEvent('ompiui:sessions-changed')) })
    await advance(300)
    expect(result.current.context.sessions.map(session => session.id)).toEqual(['fresh'])
    expect(result.current.independent.sessions.map(session => session.id)).toEqual(['fresh'])
    expect(mocks.loadPiSessions).toHaveBeenCalledTimes(2)
    await advance(1_000)
    expect(mocks.loadPiSessions).toHaveBeenCalledTimes(2)

    unmount()
    window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
    await advance(300)
    expect(mocks.loadPiSessions).toHaveBeenCalledTimes(2)
  })

  it.each(['context', 'independent'] as const)('propagates deletion from %s without dual broadcasts or duplicate refreshes', async owner => {
    const canonical = vi.fn()
    const legacy = vi.fn()
    window.addEventListener('ompiui:sessions-changed', canonical)
    window.addEventListener('omompiui:sessions-changed', legacy)
    try {
      const { result } = renderHook(useBothLists, { wrapper: SessionProvider })
      await advance(0)
      mocks.loadPiSessions.mockClear().mockResolvedValue([])
      await act(async () => {
        if (owner === 'context') await result.current.context.deleteSession('old')
        else await result.current.independent.remove('old')
      })
      await advance(300)
      expect(result.current.context.sessions).toEqual([])
      expect(result.current.independent.sessions).toEqual([])
      expect(canonical).toHaveBeenCalledTimes(1)
      expect(legacy).not.toHaveBeenCalled()
      expect(mocks.loadPiSessions).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener('ompiui:sessions-changed', canonical)
      window.removeEventListener('omompiui:sessions-changed', legacy)
    }
  })

  it('broadcasts pending-session reconciliation to independent consumers', async () => {
    const { result } = renderHook(useBothLists, { wrapper: SessionProvider })
    await advance(0)
    act(() => {
      result.current.context.registerSession({
        id: 'pending', directory: '/workspace', title: 'Pending', createdAt: Date.now(), updatedAt: Date.now(),
      })
    })
    mocks.loadPiSessions.mockClear().mockResolvedValue([sessionInfo('pending')])
    await advance(15_300)
    expect(result.current.context.sessions.map(session => session.id)).toEqual(['pending'])
    expect(result.current.independent.sessions.map(session => session.id)).toEqual(['pending'])
    expect(mocks.loadPiSessions).toHaveBeenCalledTimes(2)
  })
})
