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
  queueResync(key: string, cursor?: { epoch: string; sequence: number }): void
  incompleteResync: Set<string>
  handleActivitySnapshot(snapshot: unknown): void
  handleRaw(raw: string): void
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

  it('backs off repeated failures then continues minute probes without a visibility or online event', async () => {
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
    expect(internals.reconnectTimer).not.toBeNull()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(network.open).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(network.open).toHaveBeenCalledTimes(4)
    socket.onclose!({ code: 1006 })
    await vi.advanceTimersByTimeAsync(240_000)
    expect(network.open).toHaveBeenCalledTimes(5)
    socket.readyState = 1
    socket.onopen!()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(internals.reconnectAttempts).toBe(0)
    socket.onclose!({ code: 1006 })
    window.dispatchEvent(new Event('online'))
    expect(network.open).toHaveBeenCalledTimes(6)
  })

  it('uses incremental recovery for cached branches and only loads an initial page when absent', async () => {
    piBranchStore.setData('network-session', {
      items: [],
      hasMore: false,
      syncCursor: 'sync',
    } as unknown as PiBranchPage)
    internals.handleResync('session:network-session')
    await vi.advanceTimersByTimeAsync(0)
    expect(network.branch).toHaveBeenCalledWith('network-session', expect.any(AbortSignal), { includeLiveMessage: true })
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

  it('cancels active and queued resync work when its last panes leave', async () => {
    const signals: AbortSignal[] = []
    network.load.mockImplementation((_id: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signals.push(signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    for (const id of ['close-a', 'close-b', 'close-c']) {
      piEventStream.connect(id)
      internals.queueResync(`session:${id}`)
    }
    await vi.advanceTimersByTimeAsync(150)
    expect(network.load).toHaveBeenCalledTimes(2)
    for (const id of ['close-a', 'close-b', 'close-c']) piEventStream.disconnect(id)
    await vi.advanceTimersByTimeAsync(5000)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(network.load).toHaveBeenCalledTimes(2)
    expect(internals.incompleteResync.size).toBe(0)
  })

  it('retains failed snapshots after cursor acknowledgement and retries them again on reconnect', async () => {
    network.load.mockRejectedValue(new Error('temporary snapshot failure'))
    piEventStream.connect('network-session')
    socket.readyState = 1
    socket.onopen!()
    internals.queueResync('session:network-session', { epoch: 'confirmed', sequence: 10 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(network.load).toHaveBeenCalledTimes(4)
    expect(internals.incompleteResync.has('session:network-session')).toBe(true)
    expect(internals.cursors.get('session:network-session')).toEqual({ epoch: 'confirmed', sequence: 10 })
    network.load.mockResolvedValue(undefined)
    socket.onclose!({ code: 1006 })
    await vi.advanceTimersByTimeAsync(1000)
    socket.readyState = 1
    socket.onopen!()
    await vi.advanceTimersByTimeAsync(150)
    expect(network.load).toHaveBeenCalledTimes(5)
    expect(internals.incompleteResync.has('session:network-session')).toBe(false)
  })

  it('recovers after five minutes of failed sockets without losing its cursor or needing a visibility change', async () => {
    let available = false
    network.open.mockImplementation(() => {
      socket = { readyState: 0, send: vi.fn(), close: vi.fn() }
      const attempt = socket
      queueMicrotask(() => {
        attempt.readyState = available ? 1 : 3
        if (available) attempt.onopen!()
        else attempt.onclose!({ code: 1006 })
      })
      return attempt
    })
    internals.cursors.set('session:network-session', { epoch: 'resume', sequence: 42 })
    piEventStream.connect('network-session')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(network.open.mock.calls.length).toBeGreaterThan(10)
    available = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.readyState).toBe(1)
    const subscribe = socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).find(frame => frame.type === 'subscribe')
    expect(subscribe.cursors['session:network-session']).toEqual({ epoch: 'resume', sequence: 42 })
  })

  it('refreshes authoritative history after a worker omission rather than interpreting it as a runtime crash', async () => {
    piEventStream.connect('network-session')
    internals.handleRaw(JSON.stringify({ channel: 'event', event: {
      channel: 'payload.omitted', stream: { kind: 'session', id: 'network-session' },
      cursor: { epoch: 'e', sequence: 3 }, payload: { channel: 'pi.event', originalBytes: 9 * 1024 * 1024 },
    } }))
    await vi.advanceTimersByTimeAsync(300)
    expect(network.load).toHaveBeenCalledTimes(1)
    expect(network.state).toHaveBeenCalled()
    expect(internals.cursors.get('session:network-session')).toEqual({ epoch: 'e', sequence: 3 })
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
