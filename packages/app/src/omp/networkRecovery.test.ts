import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiBranchPage } from './domain/index.js'
import { piBranchStore, piSessionStateStore } from './state/index.js'
import { retryDelay, waitNetworkDelay } from './networkRetry'

const network = vi.hoisted(() => ({ open: vi.fn(), branch: vi.fn(), load: vi.fn(), state: vi.fn() }))
vi.mock('./ompSocket', async importOriginal => ({
  ...(await importOriginal<typeof import('./ompSocket')>()),
  openPiSocket: network.open,
}))
vi.mock('./controllers/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./controllers/index.js')>()),
  refreshPiBranch: network.branch,
  loadPiSessionData: network.load,
  refreshPiSessionState: network.state,
}))
vi.mock('./modelSettingsSync', () => ({ markModelSettingsDisconnected: vi.fn(), refreshModelSettings: vi.fn() }))
import { piEventStream } from './eventStream'

type Socket = {
  readyState: number
  onopen?: () => void
  onclose?: (event: { code: number }) => void
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}
type Internals = {
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  cursors: Map<string, { epoch: string; sequence: number }>
  knownActiveSessions: Set<string>
  handleResync(key: string): void
  handleActivitySnapshot(snapshot: unknown): void
}
const internals = piEventStream as unknown as Internals
let socket: Socket

describe('network recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    piEventStream.disconnectAll()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    network.branch.mockReset().mockResolvedValue(undefined)
    network.load.mockReset().mockResolvedValue(undefined)
    network.state.mockReset().mockResolvedValue(undefined)
    network.open.mockReset().mockImplementation(() => {
      socket = { readyState: 0, send: vi.fn(), close: vi.fn() }
      return socket
    })
  })
  afterEach(() => {
    piEventStream.disconnectAll()
    piBranchStore.clear('network-session')
    piSessionStateStore.clear('network-session')
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('coalesces pane subscriptions and retains cursor when a pane closes', async () => {
    piEventStream.connect('network-session')
    socket.readyState = 1
    socket.onopen!()
    piEventStream.connectWorkspace('/workspace')
    piEventStream.connectWorkspace('/another')
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'subscribe')).toHaveLength(1)
    internals.cursors.set('session:network-session', { epoch: 'a', sequence: 3 })
    piEventStream.disconnect('network-session')
    expect(internals.cursors.get('session:network-session')).toEqual({ epoch: 'a', sequence: 3 })
  })

  it('backs off repeated failures and stops automatic retries after ten attempts', async () => {
    piEventStream.connect('network-session')
    socket.onclose!({ code: 1006 })
    await vi.advanceTimersByTimeAsync(999)
    expect(network.open).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(network.open).toHaveBeenCalledTimes(2)
    socket.onclose!({ code: 1006 })
    await vi.advanceTimersByTimeAsync(1999)
    expect(network.open).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(network.open).toHaveBeenCalledTimes(3)
    internals.reconnectAttempts = 10
    socket.onclose!({ code: 1006 })
    expect(internals.reconnectTimer).toBeNull()
    window.dispatchEvent(new Event('online'))
    expect(network.open).toHaveBeenCalledTimes(4)
  })

  it('uses incremental recovery for cached branches and only loads an initial page when absent', async () => {
    piBranchStore.setData('network-session', {
      items: [],
      hasMore: false,
      syncCursor: 'sync',
    } as unknown as PiBranchPage)
    internals.handleResync('session:network-session')
    await vi.advanceTimersByTimeAsync(0)
    expect(network.branch).toHaveBeenCalledWith('network-session', undefined, { includeLiveMessage: true })
    expect(network.load).not.toHaveBeenCalled()
    piBranchStore.clear('network-session')
    internals.handleResync('session:network-session')
    await vi.advanceTimersByTimeAsync(0)
    expect(network.load).toHaveBeenCalledTimes(1)
    expect(network.branch).toHaveBeenCalledTimes(1)
  })

  it('activity deltas do not settle unchanged active sessions', () => {
    internals.handleActivitySnapshot({ sessions: { a: { type: 'busy' }, b: { type: 'busy' } } })
    internals.handleActivitySnapshot({ delta: true, sessions: { b: { type: 'compacting' } }, removed: [] })
    expect([...internals.knownActiveSessions].sort()).toEqual(['a', 'b'])
    internals.handleActivitySnapshot({ delta: true, sessions: {}, removed: ['a'] })
    expect([...internals.knownActiveSessions]).toEqual(['b'])
    internals.handleActivitySnapshot({ sessions: {} })
  })

  it('retry jitter stays bounded and an aborted wait leaves no timer', async () => {
    expect(retryDelay(0)).toBe(1000)
    expect(retryDelay(100)).toBe(30000)
    const controller = new AbortController()
    const wait = waitNetworkDelay(5000, controller.signal)
    controller.abort()
    await expect(wait).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
