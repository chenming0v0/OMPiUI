import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@ompiui/protocol'
import { initializePiBackend, installPiBackendServerSwitch } from './bootstrapMockChat'
import { piEventStream } from './eventStream'
import { ompSubagentStore, selectHudRuns } from './ompSubagentStore'
import { openPiSocket, type PiSocket } from './ompSocket'
import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'
import { piModelsStore } from './state/piModelsStore'
import * as controllers from './controllers/index'
import { piModelRolesStore } from './state/piModelRolesStore'
import * as rolesController from './controllers/modelRoles'

vi.mock('../api/events', () => ({
  subscribeToConnectionState: vi.fn(),
}))

vi.mock('./ompSocket', () => ({
  openPiSocket: vi.fn(),
  PI_SOCKET_OPEN: 1,
  PI_SOCKET_CLOSING: 2,
  PI_SOCKET_CLOSED: 3,
}))

vi.mock('./nativeStatus', () => ({
  refreshPiNativeStatus: vi.fn(async () => ({
    status: 'online',
    health: { service: 'ompiui-server', protocolVersion: PROTOCOL_VERSION },
    registry: { driver: 'mock' },
    missingCoreCommands: [],
  })),
}))

function makeSocket(): PiSocket {
  return {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  }
}

function deliverRun(socket: PiSocket, id: string, sessionId = 'session-old'): void {
  socket.onmessage?.({
    data: JSON.stringify({
      channel: 'event',
      event: {
        protocolVersion: PROTOCOL_VERSION,
        stream: { kind: 'server', id: 'server' },
        cursor: { epoch: 'epoch', sequence: 1 },
        eventId: `event-${id}`,
        timestamp: '2026-01-01T00:00:00.000Z',
        channel: 'omp.subagent',
        payload: {
          kind: 'lifecycle',
          sessionId,
          payload: { id, parentToolCallId: 'call-1', detached: true, status: 'started', agent: 'task' },
        },
      },
    }),
  })
}

describe('backend generation reset clears subagent state', () => {
  let remoteId: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.mocked(openPiSocket).mockImplementation(makeSocket)
    installPiBackendServerSwitch()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'http://127.0.0.1:8787', token: '' })
    remoteId = serverStore.addServer({ name: 'Other server', url: 'http://other.test:8787' }).id
    await initializePiBackend()
    ompSubagentStore.clearAll()
  })

  afterEach(async () => {
    piEventStream.disconnectAll()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(remoteId)
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'http://127.0.0.1:8787', token: '' })
    await initializePiBackend()
    ompSubagentStore.clearAll()
    // Let the real store's coalesced notification finish before restoring timers.
    await vi.advanceTimersByTimeAsync(32)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.mocked(openPiSocket).mockReset()
  })

  it.each(['selected server', 'saved endpoint', 'credentials', 'local runtime endpoint'])('clears old runs on a changed %s and rejects late socket frames', async change => {
    piEventStream.connectWorkspace('/workspace')
    const oldSocket = vi.mocked(openPiSocket).mock.results.at(-1)!.value as PiSocket
    deliverRun(oldSocket, 'run-1')
    expect(selectHudRuns(ompSubagentStore.getSnapshot())).toHaveLength(1)
    expect(ompSubagentStore.runsForSession('session-old')).toHaveLength(1)
    expect(ompSubagentStore.getRunsForToolCall('call-1', 'session-old')).toHaveLength(1)
    const generation = serverStore.getActiveServerGeneration()

    if (change === 'selected server') serverStore.setActiveServer(remoteId)
    else if (change === 'saved endpoint') serverStore.updateServer(LOCAL_SERVER_ID, { url: 'http://edited.test:9999' })
    else if (change === 'credentials') serverStore.updateServer(LOCAL_SERVER_ID, { token: 'new-token' })
    else serverStore.setLocalServerRuntimeUrl('http://127.0.0.1:9999')

    expect(serverStore.getActiveServerGeneration()).toBeGreaterThan(generation)
    expect(oldSocket.close).toHaveBeenCalled()
    expect(ompSubagentStore.getSnapshot().runs).toEqual([])
    expect(ompSubagentStore.runsForSession('session-old')).toEqual([])
    expect(ompSubagentStore.getRunsForToolCall('call-1', 'session-old')).toEqual([])
    deliverRun(oldSocket, 'late-old-run')
    expect(ompSubagentStore.getSnapshot().runs).toEqual([])

    // The HUD is not disabled: events from the new backend can use the same IDs.
    piEventStream.connectWorkspace('/workspace')
    const newSocket = vi.mocked(openPiSocket).mock.results.at(-1)!.value as PiSocket
    deliverRun(newSocket, 'run-1', 'session-new')
    deliverRun(oldSocket, 'late-old-run')
    await initializePiBackend()
    expect(selectHudRuns(ompSubagentStore.getSnapshot())).toMatchObject([{ id: 'run-1', sessionId: 'session-new' }])
    expect(ompSubagentStore.getRunsForToolCall('call-1', 'session-old')).toEqual([])
    expect(ompSubagentStore.getRunsForToolCall('call-1', 'session-new')).toHaveLength(1)
  })

  it('does not clear the HUD for a display-name-only edit', () => {
    ompSubagentStore.applyLifecycle('session-old', { id: 'run-1', detached: true, status: 'started' })
    const generation = serverStore.getActiveServerGeneration()
    serverStore.updateServer(LOCAL_SERVER_ID, { name: 'Renamed local' })
    expect(serverStore.getActiveServerGeneration()).toBe(generation)
    expect(selectHudRuns(ompSubagentStore.getSnapshot())).toHaveLength(1)
  })

  it('installs the shared reset listener only once', () => {
    const clear = vi.spyOn(ompSubagentStore, 'clearAll')
    installPiBackendServerSwitch()
    installPiBackendServerSwitch()
    serverStore.setActiveServer(remoteId)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('marks models disconnected on socket loss and revalidates on reconnect', async () => {
    const load = vi.spyOn(controllers, 'loadPiModels').mockResolvedValue([])
    const loadRoles = vi.spyOn(rolesController, 'loadPiModelRoles').mockResolvedValue({})
    piEventStream.connectWorkspace('/workspace')
    const socket = vi.mocked(openPiSocket).mock.results.at(-1)!.value as PiSocket
    piModelsStore.setModels([])
    piModelRolesStore.beginRead()
    piModelRolesStore.setRoles({})
    expect(piModelsStore.isSynced()).toBe(true)
    socket.onclose?.({ code: 1006 })
    expect(piModelsStore.isSynced()).toBe(false)
    expect(piModelRolesStore.getSnapshot().syncStatus).toBe('disconnected')
    await vi.advanceTimersByTimeAsync(5000)
    const reconnected = vi.mocked(openPiSocket).mock.results.at(-1)!.value as PiSocket
    reconnected.onopen?.()
    expect(load).toHaveBeenCalledTimes(1)
    expect(loadRoles).toHaveBeenCalledWith(true)
    expect(piModelsStore.isSynced()).toBe(false)
    piModelsStore.setModels([])
    expect(piModelsStore.isSynced()).toBe(true)
  })
})
