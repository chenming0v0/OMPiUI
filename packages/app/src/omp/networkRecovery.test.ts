import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@ompiui/protocol'
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
  onmessage?: (event: { data: string }) => void
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
function respondingSocket(): Socket {
  const next: Socket = { readyState: 0, send: vi.fn(), close: vi.fn() }
  next.send.mockImplementation((raw: string) => {
    if (JSON.parse(raw).type === 'ping') queueMicrotask(() => next.onmessage?.({
      data: JSON.stringify({ type: 'pong', protocolVersion: PROTOCOL_VERSION, t: Date.now() }),
    }))
  })
  return next
}

describe('network recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    piEventStream.disconnectAll()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    network.branch.mockReset().mockResolvedValue(undefined)
    network.load.mockReset().mockResolvedValue(undefined)
    network.state.mockReset().mockResolvedValue(undefined)
    network.open.mockReset().mockImplementation(() => {
      socket = respondingSocket()
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
      socket = respondingSocket()
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

  it('calibrates every pane immediately on foreground/pageshow even with a live socket', async () => {
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    piEventStream.connect('network-session')
    piEventStream.connect('second-pane')
    socket.readyState = 1
    socket.onopen!()
    await vi.advanceTimersByTimeAsync(0)
    piBranchStore.setData('network-session', { items: [], hasMore: false, syncCursor: 'cached' } as unknown as PiBranchPage)
    network.branch.mockClear()
    network.load.mockClear()
    network.state.mockClear()
    const live = socket
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    // No timer advance: the old debounce is not part of foreground recovery.
    expect(network.branch).toHaveBeenCalledWith('network-session', expect.any(AbortSignal), { includeLiveMessage: true })
    expect(network.load).toHaveBeenCalledWith('second-pane', expect.any(AbortSignal))
    expect(network.state.mock.calls.map(([id]) => id).sort()).toEqual(['network-session', 'second-pane'])
    expect(live.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    network.branch.mockClear()
    network.load.mockClear()
    window.dispatchEvent(new Event('pageshow'))
    expect(network.branch).toHaveBeenCalledTimes(1)
    expect(network.load).toHaveBeenCalledTimes(1)
  })

  it('replaces a half-open socket at the pong deadline and ignores its later frames', async () => {
    piEventStream.connect('network-session')
    socket.send.mockImplementation(() => {})
    socket.readyState = 1
    socket.onopen!()
    const halfOpen = socket
    await vi.advanceTimersByTimeAsync(9_999)
    expect(halfOpen.close).not.toHaveBeenCalled()
    // An event is not the acknowledgement for the outstanding application ping.
    halfOpen.onmessage!({ data: JSON.stringify({ channel: 'event', event: {
      channel: 'registry.updated', stream: { kind: 'session', id: 'network-session' },
      cursor: { epoch: 'before-reconnect', sequence: 3 }, payload: {},
    } }) })
    await vi.advanceTimersByTimeAsync(1)
    expect(halfOpen.close).toHaveBeenCalledTimes(1)
    expect(network.open).toHaveBeenCalledTimes(2)
    halfOpen.onmessage!({ data: JSON.stringify({ channel: 'event', event: {
      channel: 'registry.updated', stream: { kind: 'session', id: 'network-session' },
      cursor: { epoch: 'stale-socket', sequence: 100 }, payload: {},
    } }) })
    expect(internals.cursors.get('session:network-session')).toEqual({ epoch: 'before-reconnect', sequence: 3 })
    socket.readyState = 1
    socket.onopen!()
    await vi.advanceTimersByTimeAsync(150)
    expect(network.load).toHaveBeenCalledWith('network-session', expect.any(AbortSignal))
  })

  it('accepts pong and keeps a responsive socket alive across heartbeat intervals', async () => {
    piEventStream.connect('network-session')
    socket.readyState = 1
    socket.onopen!()
    await vi.advanceTimersByTimeAsync(80_000)
    expect(network.open).toHaveBeenCalledTimes(1)
    expect(socket.close).not.toHaveBeenCalled()
    expect(socket.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'ping').length).toBeGreaterThan(1)
  })

  it('preserves the stable-connection cleanup across foreground heartbeat resets', async () => {
    piEventStream.connect('network-session')
    const internal = piEventStream as unknown as { lastProblemCode?: string }
    internal.lastProblemCode = 'PREVIOUS_FAILURE'
    socket.readyState = 1
    socket.onopen!()
    await vi.advanceTimersByTimeAsync(5000)
    window.dispatchEvent(new Event('pageshow'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(internal.lastProblemCode).toBeUndefined()
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('discards frozen debounce timers and reconnects a stale socket before immediately reading panes', async () => {
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    piEventStream.connect('network-session')
    socket.readyState = 1
    socket.onopen!()
    await vi.advanceTimersByTimeAsync(0)
    const stale = socket
    const timers = piEventStream as unknown as {
      branchRefreshTimers: Map<string, ReturnType<typeof setTimeout>>
      stateRefreshTimers: Map<string, ReturnType<typeof setTimeout>>
      resyncTimer: ReturnType<typeof setTimeout> | null
    }
    const obsolete = vi.fn()
    timers.branchRefreshTimers.set('network-session', setTimeout(obsolete, 150))
    timers.stateRefreshTimers.set('network-session', setTimeout(obsolete, 150))
    timers.resyncTimer = setTimeout(obsolete, 150)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    // Advance wall time, not callbacks, to model an OS-frozen browser page.
    vi.setSystemTime(Date.now() + 120_000)
    network.load.mockClear()
    network.state.mockClear()
    visibility = 'visible'
    window.dispatchEvent(new Event('pageshow'))
    expect(stale.close).toHaveBeenCalledTimes(1)
    expect(network.open).toHaveBeenCalledTimes(2)
    expect(network.load).toHaveBeenCalledTimes(1)
    expect(network.state).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(obsolete).not.toHaveBeenCalled()
    expect(network.load).toHaveBeenCalledTimes(1)
  })

  it('reconnects an expired pending ping on return before the inbound-stale threshold', async () => {
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    piEventStream.connect('network-session')
    socket.send.mockImplementation(() => {})
    socket.readyState = 1
    socket.onopen!()
    const halfOpen = socket
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    vi.setSystemTime(Date.now() + 11_000)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(halfOpen.close).toHaveBeenCalledTimes(1)
    expect(network.open).toHaveBeenCalledTimes(2)
    expect(network.load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
  })

  it('does not refresh or replace transport while offline or still hidden', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    piEventStream.connect('network-session')
    network.load.mockClear()
    network.state.mockClear()
    visibility.mockReturnValue('hidden')
    window.dispatchEvent(new Event('pageshow'))
    visibility.mockReturnValue('visible')
    online.mockReturnValue(false)
    window.dispatchEvent(new Event('online'))
    expect(network.load).not.toHaveBeenCalled()
    expect(network.state).not.toHaveBeenCalled()
    expect(network.open).toHaveBeenCalledTimes(1)
  })

  it('keeps a racing resync as one dirty tail without stealing another session slot', async () => {
    const first = Promise.withResolvers<void>()
    network.branch.mockImplementation((id: string) => id === 'network-session' && network.branch.mock.calls.filter(([key]) => key === id).length === 1
      ? first.promise : Promise.resolve())
    for (const id of ['network-session', 'other-resync'])
      piBranchStore.setData(id, { items: [], hasMore: false } as unknown as PiBranchPage)
    internals.queueResync('session:network-session')
    await vi.advanceTimersByTimeAsync(150)
    internals.queueResync('session:network-session')
    internals.queueResync('session:network-session')
    internals.queueResync('session:other-resync')
    await vi.advanceTimersByTimeAsync(150)
    expect(network.branch.mock.calls.map(([id]) => id)).toEqual(['network-session', 'other-resync'])
    expect(internals.incompleteResync.has('session:network-session')).toBe(true)
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(network.branch.mock.calls.map(([id]) => id)).toEqual(['network-session', 'other-resync', 'network-session'])
    expect(internals.incompleteResync.has('session:network-session')).toBe(false)
  })

  it('keeps a racing foreground resync after the older request fails', async () => {
    const first = Promise.withResolvers<void>()
    network.load.mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    internals.queueResync('session:network-session')
    await vi.advanceTimersByTimeAsync(150)
    internals.queueResync('session:network-session')
    await vi.advanceTimersByTimeAsync(150)
    first.reject(new TypeError('connection was suspended'))
    await vi.advanceTimersByTimeAsync(0)
    expect(network.load).toHaveBeenCalledTimes(2)
    expect(internals.incompleteResync.has('session:network-session')).toBe(false)
    // Successful dirty tail cancels the older flight's scheduled retry.
    await vi.advanceTimersByTimeAsync(1500)
    expect(network.load).toHaveBeenCalledTimes(2)
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
