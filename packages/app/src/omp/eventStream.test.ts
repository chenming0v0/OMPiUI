/**
 * handleSessionsUpdated 的替换语义测试：
 * - fork/new/import 等真实替换：清源 session 的 keyed store + 派发
 *   ompiui:session-replaced（pane 跟随新 session）。
 * - runtime-reuse（server 复用同目录空闲 runtime 的静默身份切换）：
 *   源 session 的磁盘数据与 pane 绑定都不变——不清 store、不派发
 *   session-replaced，只刷新会话列表。否则 paneLayoutStore.remapSession
 *   会把所有绑定源 session 的 pane 切走（分屏串扰）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { PROTOCOL_VERSION, type JsonObject } from '@ompiui/protocol'
import { piEventStream } from './eventStream'
import { piBranchStore, piSessionStateStore, piCommandStore } from './state/index.js'
import { ompSubagentStore } from './ompSubagentStore'
import type { PiBranchPage } from './domain/index.js'
import { activeSessionStore } from '../store/activeSessionStore'
import * as controllers from './controllers/index.js'
import { buildPiLiveItems } from './selectors/index.js'
import * as http from './httpClient.js'
import { serverStore } from '../store/serverStore'
import { notificationStore } from '../store/notificationStore'
import { commandFeedbackStore } from './commandFeedbackStore'
import { extensionDiagnosticStore } from './extensionDiagnosticStore'
import * as transport from './transport/index.js'
import * as sockets from './ompSocket'
import * as modelSettingsSync from './modelSettingsSync'
import * as managementEvents from './managementEventStore'
import { getTerminalSecret } from './terminalIdentity'
import { resetWorkspaceResolutionCache, resolveWorkspacePath } from './workspaces'

// Retain the real controller before sibling scenarios install module spies.
const readNativeSessionState = controllers.refreshPiSessionState

// 触达私有方法做白盒测试（事件驱动路径需要 WS，单测直接调 handler）
type Handler = (payload: unknown) => void
const handle = (payload: unknown) =>
  (piEventStream as unknown as { handleSessionsUpdated: Handler }).handleSessionsUpdated(payload)

type EnvelopeHandler = (envelope: unknown) => void
const handleEvent = (envelope: unknown) =>
  (piEventStream as unknown as { handleEvent: EnvelopeHandler }).handleEvent(envelope as never)

function fakeBranchPage(sessionId: string): PiBranchPage {
  return {
    head: {
      sdkVersion: 'test',
      revision: 1,
      header: null,
      leafId: null,
      entryCount: 0,
      epoch: `test:${sessionId}`,
    },
    items: [],
    hasMore: false,
  } as PiBranchPage
}

describe('workspace watcher reconnect recovery', () => {
  beforeEach(() => {
    piEventStream.disconnectAll()
    resetWorkspaceResolutionCache()
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(modelSettingsSync, 'refreshModelSettings').mockImplementation(() => {})
    vi.spyOn(modelSettingsSync, 'refreshOfficialSettings').mockImplementation(() => {})
  })

  afterEach(() => {
    piEventStream.disconnectAll()
    resetWorkspaceResolutionCache()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restores active watches after a same-endpoint restart and delivers later file/git notifications', async () => {
    const registry = new Set<string>()
    const watchRequests: string[] = []
    const host = vi.spyOn(transport, 'postHostCommand').mockImplementation(async (name, params) => {
      if (name === 'workspaces.open') return { workspace: { path: (params as { rootPath: string }).rootPath } } as never
      if (name === 'workspaces.watch') {
        const path = (params as { workspacePath: string }).workspacePath
        registry.add(path)
        watchRequests.push(path)
        return { ok: true } as never
      }
      throw new Error(`Unexpected host command: ${name}`)
    })
    const runtime = vi.spyOn(transport, 'postPiGlobalCommand').mockRejectedValue(new Error('unexpected runtime command'))
    const sessionCommand = vi.spyOn(transport, 'postPiSessionCommand').mockRejectedValue(new Error('unexpected session command'))
    const navigate = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    type MutableSocket = Omit<sockets.PiSocket, 'readyState'> & { readyState: number }
    const socketList: MutableSocket[] = []
    const socketOpen = vi.spyOn(sockets, 'openPiSocket').mockImplementation(() => {
      const socket: MutableSocket = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send: vi.fn(), close: vi.fn() }
      socketList.push(socket)
      return socket
    })
    const changed = vi.fn()
    const gitUpdated = vi.fn()
    window.addEventListener('ompiui:workspace-files-changed', changed)
    window.addEventListener('ompiui:workspace-git-updated', gitUpdated)
    try {
      const generation = serverStore.getActiveServerGeneration()
      const server = serverStore.getActiveServer()
      await resolveWorkspacePath('/not-selected')
      expect(await resolveWorkspacePath('/repo')).toBe('/repo')
      piEventStream.connectWorkspace('/repo')
      const first = socketList[0]!
      first.readyState = sockets.PI_SOCKET_OPEN
      first.onopen?.()
      await vi.advanceTimersByTimeAsync(0)

      // A backend restart keeps URL/token unchanged but loses native watchers.
      registry.clear()
      watchRequests.length = 0
      first.readyState = sockets.PI_SOCKET_CLOSED
      first.onclose?.({ code: 1012 })
      await vi.advanceTimersByTimeAsync(1000)
      const reconnected = socketList[1]!
      reconnected.readyState = sockets.PI_SOCKET_OPEN
      reconnected.onopen?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(socketOpen).toHaveBeenCalledTimes(2)
      expect(serverStore.getActiveServerGeneration()).toBe(generation)
      expect(serverStore.getActiveServer()).toEqual(server)
      expect(watchRequests).toEqual(['/repo'])
      expect(registry.has('/not-selected')).toBe(false)
      expect(await resolveWorkspacePath('/repo')).toBe('/repo')
      expect(host.mock.calls.filter(([name]) => name === 'workspaces.open')).toHaveLength(2)
      expect(watchRequests).toEqual(['/repo'])

      const frames = vi.mocked(reconnected.send).mock.calls.map(([data]) => JSON.parse(data))
      const subscribe = frames.find(frame => frame.type === 'subscribe')
      expect(subscribe).toMatchObject({ terminalSecret: getTerminalSecret(), streams: [{ kind: 'server', id: 'server' }, { kind: 'workspace', id: '/repo' }] })
      expect(socketOpen.mock.calls.every(([url]) => !url.includes('terminalSecret') && !url.includes(getTerminalSecret()))).toBe(true)
      const notifyOtherClientChange = (channel: string, payload: object, sequence: number) => {
        if (!registry.has('/repo')) return
        reconnected.onmessage?.({ data: JSON.stringify({ channel: 'event', event: {
          protocolVersion: PROTOCOL_VERSION, stream: { kind: 'workspace', id: '/repo' },
          cursor: { epoch: 'restarted-backend', sequence }, eventId: `workspace-${sequence}`,
          timestamp: '2026-11-25T00:00:00Z', channel, payload,
        } }) })
      }
      const fileChange = { workspacePath: '/repo', changes: [{ path: 'src/main.ts', type: 'change' }] }
      const gitChange = { workspacePath: '/repo' }
      notifyOtherClientChange('workspace.files', fileChange, 1)
      notifyOtherClientChange('workspace.git', gitChange, 2)
      expect(changed).toHaveBeenCalledTimes(1)
      expect((changed.mock.calls[0]![0] as CustomEvent).detail).toEqual(fileChange)
      expect(gitUpdated).toHaveBeenCalledTimes(1)
      expect((gitUpdated.mock.calls[0]![0] as CustomEvent).detail).toEqual(gitChange)
      expect(runtime).not.toHaveBeenCalled()
      expect(sessionCommand).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('ompiui:workspace-files-changed', changed)
      window.removeEventListener('ompiui:workspace-git-updated', gitUpdated)
    }
  })
})

describe('optional private terminal subscription', () => {
  afterEach(() => {
    piEventStream.disconnectAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps ordinary subscriptions and events working when private terminal storage is unavailable', () => {
    piEventStream.disconnectAll()
    vi.useFakeTimers()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage is disabled', 'SecurityError')
    })
    const send = vi.fn()
    const internal = piEventStream as unknown as {
      ws: sockets.PiSocket | null
      refCounts: Map<string, number>
      flushSubscribe(): void
      handleRaw(raw: string): void
    }
    internal.ws = { readyState: sockets.PI_SOCKET_OPEN, onopen: null, onmessage: null, onclose: null, onerror: null, send, close: vi.fn() }
    internal.refCounts.set('ordinary-chat', 1)
    expect(() => internal.flushSubscribe()).not.toThrow()
    const subscribe = JSON.parse(send.mock.calls[0]![0])
    expect(subscribe).toMatchObject({ type: 'subscribe', streams: [{ kind: 'server', id: 'server' }, { kind: 'session', id: 'ordinary-chat' }] })
    expect(subscribe).not.toHaveProperty('terminalSecret')
    const changed = vi.fn()
    window.addEventListener('ompiui:sessions-changed', changed)
    try {
      internal.handleRaw(JSON.stringify({ channel: 'event', event: {
        channel: 'sessions.updated', stream: { kind: 'server', id: 'server' },
        cursor: { epoch: 'ordinary', sequence: 1 }, payload: {},
      } }))
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('ompiui:sessions-changed', changed)
    }
  })
})

describe('official settings event recovery routing', () => {
  afterEach(() => {
    piEventStream.disconnectAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('invalidates and rereads settings for normal, transport-omitted, worker-omitted and resync events', async () => {
    vi.useFakeTimers()
    const updated = vi.spyOn(managementEvents, 'receiveSettingsUpdated').mockImplementation(() => {})
    const refresh = vi.spyOn(modelSettingsSync, 'refreshOfficialSettings').mockImplementation(() => {})
    const internal = piEventStream as unknown as { handleRaw(raw: string): void; handleResync(key: string): Promise<void> }
    handleEvent({ channel: 'settings.updated', stream: { kind: 'server', id: 'server' }, cursor: { epoch: 'settings', sequence: 1 }, payload: {} })
    internal.handleRaw(JSON.stringify({
      channel: 'control', type: 'payload_omitted', stream: { kind: 'server', id: 'server' },
      cursor: { epoch: 'settings', sequence: 2 }, eventChannel: 'settings.updated',
    }))
    handleEvent({ channel: 'payload.omitted', stream: { kind: 'server', id: 'server' }, cursor: { epoch: 'settings', sequence: 3 }, payload: { channel: 'settings.updated' } })
    expect(updated).toHaveBeenCalledTimes(3)
    expect(refresh).toHaveBeenCalledTimes(3)
    await internal.handleResync('server')
    expect(updated).toHaveBeenCalledTimes(4)
    expect(refresh).toHaveBeenCalledTimes(4)
  })
})

describe('bounded live recovery and cache cleanup', () => {
  afterEach(() => {
    piEventStream.disconnectAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it('single-flights live recovery and backs off when large checkpoints remain omitted', async () => {
    vi.useFakeTimers()
    const refresh = vi.spyOn(controllers, 'refreshPiBranch').mockResolvedValue(undefined)
    const internal = piEventStream as unknown as { recoverLiveMessage(sessionId: string): void }
    for (let i = 0; i < 100; i++) internal.recoverLiveMessage('large')
    expect(refresh).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(4999)
    internal.recoverLiveMessage('large')
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    internal.recoverLiveMessage('large')
    expect(refresh).toHaveBeenCalledTimes(2)
  })
  it('probes after protocol problems without visibility changes and notifies once per failure', async () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const internal = piEventStream as unknown as {
      refCounts: Map<string, number>
      handleRaw(raw: string): void
      openSocket(): void
    }
    internal.refCounts.set('protocol', 1)
    const open = vi.spyOn(internal, 'openSocket').mockImplementation(() => {})
    const notify = vi.spyOn(notificationStore, 'push').mockImplementation(() => {})
    const problem = JSON.stringify({ channel: 'control', type: 'problem', problem: { code: 'PROTOCOL_VERSION_MISMATCH', message: 'outdated' } })
    internal.handleRaw(problem)
    expect(notify).toHaveBeenCalledWith('error', expect.any(String), expect.stringContaining('PROTOCOL_VERSION_MISMATCH'), '')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(open).toHaveBeenCalledTimes(1)
    internal.handleRaw(problem)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(open).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('drops in-flight resync work when the backend changes', async () => {
    vi.useFakeTimers()
    const requests = Array.from({ length: 3 }, () => {
      let resolve!: () => void
      const promise = new Promise<void>(done => { resolve = done })
      return { promise, resolve }
    })
    const pending = [...requests]
    const refresh = vi.spyOn(controllers, 'refreshPiBranch').mockImplementation(() => {
      const next = pending.shift()
      if (!next) throw new Error('unexpected refresh')
      return next.promise
    })
    for (const sessionId of ['old-a', 'old-b']) piBranchStore.setData(sessionId, fakeBranchPage(sessionId))
    const internal = piEventStream as unknown as { queueResync(key: string): void }

    internal.queueResync('session:old-a')
    internal.queueResync('session:old-b')
    await vi.advanceTimersByTimeAsync(150)
    expect(refresh).toHaveBeenCalledTimes(2)

    piEventStream.disconnectAll()
    piBranchStore.setData('new', fakeBranchPage('new'))
    internal.queueResync('session:new')
    await vi.advanceTimersByTimeAsync(150)
    expect(refresh).toHaveBeenCalledTimes(3)

    for (const request of requests) request.resolve()
    await Promise.resolve()
  })
  it('clears subagent and command data after the last consumer disconnects', () => {
    const internal = piEventStream as unknown as { refCounts: Map<string, number> }
    internal.refCounts.set('closed', 1)
    ompSubagentStore.applyLifecycle('closed', { id: 'child', parentToolCallId: 'task', status: 'started' })
    piCommandStore.upsert({ id: 'closed-command', type: 'test', sessionId: 'closed', status: 'completed', submittedAt: '2026-10-13' })
    piEventStream.disconnect('closed')
    expect(ompSubagentStore.getRunsForToolCall('task', 'closed')).toHaveLength(0)
    expect(piCommandStore.get('closed-command')).toBeNull()
  })
  it('bounds completed command results by bytes as well as record count', () => {
    piCommandStore.clearAll()
    for (let i = 0; i < 300; i++) piCommandStore.upsert({
      id: `cache-${i}`, type: 'test', status: 'completed', submittedAt: '2026-10-13', result: 'x'.repeat(128 * 1024),
    })
    const snapshot = piCommandStore.getSnapshot()
    expect(snapshot.length).toBeLessThan(256)
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(16 * 1024 * 1024 + 256)
    expect(piCommandStore.get('cache-299')).not.toBeNull()
  })
})

describe('handleSessionsUpdated deletion', () => {
  it('invalidates only the matching loaded history and refreshes the lists', () => {
    piBranchStore.setData('deleted-session', fakeBranchPage('deleted-session'))
    piBranchStore.setData('remaining-session', fakeBranchPage('remaining-session'))
    piSessionStateStore.setState('deleted-session', { isIdle: true })
    const changed = vi.fn()
    window.addEventListener('ompiui:sessions-changed', changed)
    try {
      handle({ sessionId: 'deleted-session', sessionFile: '/project/deleted.jsonl', deleted: true })
      expect(piBranchStore.getData('deleted-session')).toBeNull()
      expect(piBranchStore.getError('deleted-session')).toMatchObject({ code: 'SESSION_NOT_FOUND' })
      expect(piSessionStateStore.getState('deleted-session')).toBeNull()
      expect(piBranchStore.getData('remaining-session')).not.toBeNull()
      expect(changed).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('ompiui:sessions-changed', changed)
      piBranchStore.clear('deleted-session')
      piBranchStore.clear('remaining-session')
    }
  })
})

describe('handleSessionsUpdated replacement semantics', () => {
  let replacedEvents: unknown[] = []
  let changedCount = 0
  const onReplaced = (event: Event) => replacedEvents.push((event as CustomEvent).detail)
  const onChanged = () => { changedCount += 1 }

  beforeEach(() => {
    replacedEvents = []
    changedCount = 0
    window.addEventListener('ompiui:session-replaced', onReplaced)
    window.addEventListener('ompiui:sessions-changed', onChanged)
  })

  afterEach(() => {
    window.removeEventListener('ompiui:session-replaced', onReplaced)
    window.removeEventListener('ompiui:sessions-changed', onChanged)
    piBranchStore.clear('session-a')
    piSessionStateStore.clear('session-a')
    vi.restoreAllMocks()
  })

  it('a runtime crash settles live subagent tools instead of leaving them running', () => {
    ompSubagentStore.clearAll()
    piSessionStateStore.setState('session-a', { isStreaming: true, isIdle: false })
    const page = {
      ...fakeBranchPage('session-a'),
      checkpoint: {
        position: { epoch: 'stream-a', sequence: 1 },
        liveMessage: {
          id: 'partial-reply', revision: 1, phase: 'streaming',
          message: { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'Partial reply' }] },
        },
      },
    } as PiBranchPage
    piBranchStore.setData('session-a', page)
    const oldBranchRequest = piBranchStore.beginRequest('session-a')
    ompSubagentStore.applyLifecycle('session-a', { id: 'crash-child', parentToolCallId: 'task-crash', status: 'started' })
    ompSubagentStore.applyEvent('session-a', {
      id: 'crash-child', event: { type: 'tool_execution_start', toolCallId: 'read-crash', toolName: 'read' },
    })
    handle({ sessionId: 'session-a', crashed: true })
    expect(piSessionStateStore.getState('session-a')).toMatchObject({ isStreaming: false, isIdle: true })
    const settled = piBranchStore.getData('session-a')!
    expect(settled.checkpoint?.liveMessage?.phase).toBe('persisting')
    expect(buildPiLiveItems(settled)[0]).toMatchObject({ kind: 'assistant_message', isStreaming: false })
    piBranchStore.setDataIfCurrent('session-a', page, oldBranchRequest)
    expect(piBranchStore.getData('session-a')).toBe(settled)
    expect(ompSubagentStore.getRunsForToolCall('task-crash', 'session-a')[0]).toMatchObject({
      status: 'failed', transcript: [{ toolCallId: 'read-crash', toolStatus: 'error', streaming: false }],
    })
    ompSubagentStore.clearAll()
  })

  it('runtime-reuse: keeps source keyed stores and does not emit session-replaced', () => {
    piBranchStore.setData('session-a', fakeBranchPage('session-a'))
    piSessionStateStore.setState('session-a', { isStreaming: false })
    const branchClear = vi.spyOn(piBranchStore, 'clear')
    const stateClear = vi.spyOn(piSessionStateStore, 'clear')
    const commandClear = vi.spyOn(piCommandStore, 'clearSession')

    handle({
      replaced: true,
      sourceSessionId: 'session-a',
      targetSessionId: 'session-b',
      targetCwd: '/tmp',
      reason: 'runtime-reuse',
    })

    // 源 session 的缓存数据保留：pane 继续显示磁盘预览，无闪烁
    expect(branchClear).not.toHaveBeenCalled()
    expect(stateClear).not.toHaveBeenCalled()
    expect(commandClear).not.toHaveBeenCalled()
    expect(piBranchStore.getData('session-a')).not.toBeNull()
    // pane 不跟随：不派发 session-replaced（App 的 remapSession 不会触发）
    expect(replacedEvents).toHaveLength(0)
    // 列表仍刷新
    expect(changedCount).toBe(1)
  })

  it('user replacement (fork/new/import): clears source stores and emits session-replaced', () => {
    piBranchStore.setData('session-a', fakeBranchPage('session-a'))
    const branchClear = vi.spyOn(piBranchStore, 'clear')

    handle({
      replaced: true,
      sourceSessionId: 'session-a',
      targetSessionId: 'session-b',
      targetCwd: '/tmp',
    })

    expect(branchClear).toHaveBeenCalledWith('session-a')
    expect(replacedEvents).toHaveLength(1)
    expect(replacedEvents[0]).toMatchObject({
      sourceSessionId: 'session-a',
      targetSessionId: 'session-b',
    })
    expect(changedCount).toBe(1)
  })

  it('same-ID relocation retains Goal and child state and emits metadata only', () => {
    const page = fakeBranchPage('session-a')
    piBranchStore.setData('session-a', page)
    piSessionStateStore.setState('session-a', { goal: { objective: 'native goal' } } as never)
    ompSubagentStore.applyLifecycle('session-a', { id: 'native-child', parentToolCallId: 'task-a', status: 'started' })
    const relocated = vi.fn()
    window.addEventListener('ompiui:session-relocated', relocated)
    try {
      handle({ replaced: true, sourceSessionId: 'session-a', targetSessionId: 'session-a', targetCwd: '/relocated' })
      expect(piBranchStore.getData('session-a')).toBe(page)
      expect(piSessionStateStore.getState('session-a')).toMatchObject({ goal: { objective: 'native goal' } })
      expect(ompSubagentStore.getRunsForToolCall('task-a', 'session-a')).toHaveLength(1)
      expect(replacedEvents).toHaveLength(0)
      expect(relocated).toHaveBeenCalledTimes(1)
      expect(changedCount).toBe(1)
    } finally {
      window.removeEventListener('ompiui:session-relocated', relocated)
      ompSubagentStore.clearSession('session-a')
    }
  })

  it('cancels source refresh timers and invalidates old target reads without clearing target', async () => {
    vi.useFakeTimers()
    const internal = piEventStream as unknown as {
      branchRefreshTimers: Map<string, number>
      stateRefreshTimers: Map<string, number>
      resyncControllers: Map<string, AbortController>
    }
    const sourceRefresh = vi.fn()
    const controller = new AbortController()
    internal.branchRefreshTimers.set('session-a', window.setTimeout(sourceRefresh, 10))
    internal.stateRefreshTimers.set('session-a', window.setTimeout(sourceRefresh, 10))
    internal.resyncControllers.set('session-a', controller)
    const targetPage = fakeBranchPage('session-b')
    piBranchStore.setData('session-b', targetPage)
    const oldBranch = piBranchStore.beginRequest('session-b')
    const oldState = piSessionStateStore.beginRequest('session-b')
    try {
      handle({ replaced: true, sourceSessionId: 'session-a', targetSessionId: 'session-b' })
      await vi.advanceTimersByTimeAsync(20)
      expect(sourceRefresh).not.toHaveBeenCalled()
      expect(controller.signal.aborted).toBe(true)
      expect(piBranchStore.getData('session-b')).toBe(targetPage)
      expect(piBranchStore.isRequestCurrent('session-b', oldBranch)).toBe(false)
      expect(piSessionStateStore.isRequestCurrent('session-b', oldState)).toBe(false)
    } finally {
      piBranchStore.clear('session-b')
      piSessionStateStore.clear('session-b')
      vi.useRealTimers()
    }
  })
})

describe('omp.subagent routing across streams', () => {
  afterEach(() => {
    ompSubagentStore.clearAll()
  })

  function subagentEnvelope(stream: { kind: 'session' | 'server'; id: string }, payload: unknown) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      stream,
      cursor: { epoch: 'test-epoch', sequence: 1 },
      eventId: 'event-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      channel: 'omp.subagent',
      payload,
    }
  }

  it('server-stream mirror frames land in the store via payload sessionId', () => {
    handleEvent(subagentEnvelope(
      { kind: 'server', id: 'server' },
      { kind: 'lifecycle', payload: { id: 'mirror-run-1', detached: true, status: 'started', agent: 'task', index: 0 }, sessionId: 'session-bg' },
    ))

    const run = ompSubagentStore.getSnapshot().runs.find(item => item.id === 'mirror-run-1')
    expect(run).toBeDefined()
    expect(run?.sessionId).toBe('session-bg')
    expect(run?.detached).toBe(true)
  })

  it('session-stream frames keep using the envelope stream id', () => {
    handleEvent(subagentEnvelope(
      { kind: 'session', id: 'session-open' },
      { kind: 'lifecycle', payload: { id: 'mirror-run-2', detached: true, status: 'started', agent: 'task', index: 1 } },
    ))

    const run = ompSubagentStore.getSnapshot().runs.find(item => item.id === 'mirror-run-2')
    expect(run).toBeDefined()
    expect(run?.sessionId).toBe('session-open')
  })

  it('requests the canonical timeline immediately when an IRC message arrives', () => {
    const refresh = vi.spyOn(piEventStream as unknown as { scheduleBranchRefresh(sessionId: string): void }, 'scheduleBranchRefresh')
      .mockImplementation(() => undefined)
    try {
      handleEvent({
        ...subagentEnvelope({ kind: 'session', id: 'irc-parent' }, {}),
        channel: 'pi.event', payload: { event: { type: 'irc_message', message: { customType: 'irc:incoming' } } },
      })
      expect(refresh).toHaveBeenCalledWith('irc-parent')
    } finally {
      refresh.mockRestore()
    }
  })
})

describe('oversized event recovery', () => {
  afterEach(() => {
    piEventStream.disconnectAll()
    vi.restoreAllMocks()
  })

  const raw = (value: unknown) =>
    (piEventStream as unknown as { handleRaw(data: string): void }).handleRaw(JSON.stringify(value))

  it('recovers a command once without rewinding newer consumed events or the next subscription', async () => {
    const command = { id: 'large-command', type: 'branch.get', status: 'completed' as const, submittedAt: '2026-10-13', result: { text: 'complete' } }
    const pending = Promise.withResolvers<Response>()
    const read = vi.spyOn(http, 'piFetch').mockReturnValue(pending.promise)
    const internal = piEventStream as unknown as {
      cursors: Map<string, unknown>
      send(message: unknown): void
      flushSubscribe(): void
    }
    const send = vi.spyOn(internal, 'send').mockImplementation(() => {})
    internal.cursors.set('server', { epoch: 'test', sequence: 7 })
    const frame = {
      channel: 'control', type: 'payload_omitted', stream: { kind: 'server', id: 'server' },
      cursor: { epoch: 'test', sequence: 8 }, eventId: 'large-event', eventChannel: 'command.updated', commandId: command.id,
    }
    raw(frame)
    raw(frame)
    handleEvent({ stream: frame.stream, cursor: { epoch: 'test', sequence: 9 }, channel: 'registry.updated', payload: {} })
    expect(read).toHaveBeenCalledOnce()
    pending.resolve(new Response(JSON.stringify({ command })))
    await vi.waitFor(() => expect(piCommandStore.get(command.id)).toEqual(command))
    internal.flushSubscribe()
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ cursors: { server: { epoch: 'test', sequence: 9 } } }))
  })

  it('notifies terminal-list consumers even when the omitted event is not a session event', () => {
    const listener = vi.fn()
    window.addEventListener('ompiui:terminals-changed', listener)
    try {
      raw({
        channel: 'control', type: 'payload_omitted', stream: { kind: 'workspace', id: 'C:/p' },
        cursor: { epoch: 'test', sequence: 1 }, eventId: 'terminal-large', eventChannel: 'terminal.updated',
      })
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('ompiui:terminals-changed', listener)
    }
  })

  it('refreshes authoritative session state when a subagent event payload is omitted', () => {
    const refresh = vi.spyOn(
      piEventStream as unknown as { scheduleStateRefresh(sessionId: string): void },
      'scheduleStateRefresh',
    ).mockImplementation(() => undefined)
    try {
      raw({
        channel: 'control',
        type: 'payload_omitted',
        stream: { kind: 'session', id: 'session-subagent' },
        cursor: { epoch: 'test', sequence: 9 },
        eventId: 'subagent-large',
        eventChannel: 'omp.subagent',
      })
      expect(refresh).toHaveBeenCalledWith('session-subagent')
    } finally {
      refresh.mockRestore()
    }
  })
})

describe('ordered recovery cursors', () => {
  // 注入已解码的内存帧，并观察重连会发送的订阅；不建立真实 socket。
  const internal = piEventStream as unknown as {
    handleRaw(raw: string): void
    send(message: unknown): void
    flushSubscribe(): void
  }
  const raw = (frame: unknown) => internal.handleRaw(JSON.stringify(frame))
  const omitted = (epoch: string, sequence: number) => ({
    channel: 'control', type: 'payload_omitted', stream: { kind: 'server', id: 'server' },
    cursor: { epoch, sequence }, eventId: `command-${sequence}`, eventChannel: 'command.updated', commandId: 'recovered-command',
  })
  const command = {
    id: 'recovered-command', type: 'branch.get', status: 'completed', submittedAt: '2026-10-14', result: 'current',
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    piEventStream.disconnectAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([{ epoch: 'old', sequence: 11 }, { epoch: 'new', sequence: 1 }])(
    'keeps $epoch:$sequence through a delayed resync while still refreshing the missing snapshot',
    async cursor => {
      const send = vi.spyOn(internal, 'send').mockImplementation(() => {})
      const changed = vi.fn()
      window.addEventListener('ompiui:sessions-changed', changed)
      try {
        raw({ channel: 'control', type: 'resync_required', streams: { server: { cursor: { epoch: 'old', sequence: 10 } } } })
        handleEvent({ stream: { kind: 'server', id: 'server' }, cursor, channel: 'registry.updated', payload: {} })
        await vi.advanceTimersByTimeAsync(150)
        internal.flushSubscribe()
        expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ cursors: { server: cursor } }))
        expect(changed).toHaveBeenCalledOnce()
      } finally {
        window.removeEventListener('ompiui:sessions-changed', changed)
      }
    },
  )

  it('retries a failed command snapshot on resubscription without replaying later events', async () => {
    const send = vi.spyOn(internal, 'send').mockImplementation(() => {})
    const read = vi.spyOn(http, 'piFetch')
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ command })))
    raw(omitted('old', 10))
    handleEvent({ stream: { kind: 'server', id: 'server' }, cursor: { epoch: 'old', sequence: 11 }, channel: 'registry.updated', payload: {} })
    await vi.advanceTimersByTimeAsync(0)
    internal.flushSubscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    expect(piCommandStore.get(command.id)?.result).toBe('current')
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ cursors: { server: { epoch: 'old', sequence: 11 } } }))
  })

  it.each(['epoch', 'backend'] as const)('does not let a previous %s recovery overwrite or detach its replacement', async change => {
    const old = Promise.withResolvers<Response>()
    const current = Promise.withResolvers<Response>()
    const read = vi.spyOn(http, 'piFetch').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const send = vi.spyOn(internal, 'send').mockImplementation(() => {})
    let generation = 1
    vi.spyOn(serverStore, 'getActiveServerGeneration').mockImplementation(() => generation)
    raw(omitted('old', 10))
    if (change === 'backend') {
      generation++
      piEventStream.handleServerChange()
    }
    const epoch = change === 'epoch' ? 'new' : 'old'
    const frame = omitted(epoch, 1)
    raw(frame)
    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    old.resolve(new Response(JSON.stringify({ command: { ...command, result: 'stale' } })))
    await vi.advanceTimersByTimeAsync(0)
    expect(piCommandStore.get(command.id)).toBeNull()
    raw(frame)
    expect(read).toHaveBeenCalledTimes(2)
    current.resolve(new Response(JSON.stringify({ command })))
    await vi.advanceTimersByTimeAsync(0)
    expect(piCommandStore.get(command.id)?.result).toBe('current')
    internal.flushSubscribe()
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ cursors: { server: { epoch, sequence: 1 } } }))
  })

  it('keeps a newer complete command event when an older HTTP snapshot finally resolves', async () => {
    const pending = Promise.withResolvers<Response>()
    vi.spyOn(http, 'piFetch').mockReturnValue(pending.promise)
    raw(omitted('old', 10))
    handleEvent({ stream: { kind: 'server', id: 'server' }, cursor: { epoch: 'old', sequence: 11 }, channel: 'command.updated', payload: command })
    pending.resolve(new Response(JSON.stringify({ command: { ...command, status: 'running', result: 'stale' } })))
    await vi.advanceTimersByTimeAsync(0)
    expect(piCommandStore.get(command.id)).toMatchObject({ status: 'completed', result: 'current' })
  })
})

describe('refresh replay hydration', () => {
  afterEach(() => {
    piBranchStore.clear('session-refresh')
    ;(piEventStream as unknown as { pendingLiveMessages: Map<string, unknown> }).pendingLiveMessages.clear()
  })

  it('keeps a live assistant frame received before branch hydration', () => {
    const update = (piEventStream as unknown as {
      updateLiveMessage: (sessionId: string, message: unknown, meta: unknown) => void
    }).updateLiveMessage.bind(piEventStream)
    const flush = (piEventStream as unknown as { flushPendingLiveMessage: (sessionId: string) => void }).flushPendingLiveMessage.bind(piEventStream)

    update('session-refresh', { role: 'assistant', content: [{ type: 'text', text: 'still working' }] }, {
      epoch: 'event-epoch',
      sequence: 7,
    })
    expect(piBranchStore.getData('session-refresh')).toBeNull()

    piBranchStore.setData('session-refresh', fakeBranchPage('session-refresh'))
    flush('session-refresh')

    expect(piBranchStore.getData('session-refresh')?.checkpoint?.liveMessage?.message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'still working' }],
    })
  })
})

describe('session configuration and stop synchronization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(controllers, 'refreshPiSessionState').mockResolvedValue()
    vi.spyOn(controllers, 'refreshPiBranch').mockResolvedValue()
    piSessionStateStore.setState('session-stop', { isStreaming: true, isIdle: false })
  })

  afterEach(() => {
    piEventStream.disconnectAll()
    ;(piEventStream as unknown as { knownActiveSessions: Set<string> }).knownActiveSessions.clear()
    piSessionStateStore.clearAll()
    activeSessionStore.reset()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function event(event: unknown) {
    handleEvent({
      stream: { kind: 'session', id: 'session-stop' },
      cursor: { epoch: 'test', sequence: 1 },
      channel: 'pi.event',
      payload: { event, meta: { epoch: 'test', sequence: 1 } },
    })
  }

  function activity(sessions: unknown) {
    handleEvent({
      stream: { kind: 'server', id: 'server' },
      cursor: { epoch: 'test', sequence: 1 },
      channel: 'sessions.activity',
      payload: { sessions },
    })
  }

  it.each(['queue_update', 'snapshot'])('restores the shared Send now state through %s without another submission', async path => {
    const entry = { entryId: 'promoted-queue', text: 'accepted on the other device' }
    const submittedMessages = [{ id: `submitted:${entry.entryId}`, queueEntryId: entry.entryId, submissionStatus: 'queued',
      message: { role: 'user', timestamp: 123456, content: [{ type: 'text', text: entry.text }] } }]
    vi.mocked(controllers.refreshPiSessionState).mockImplementation(readNativeSessionState)
    vi.spyOn(transport, 'getPiSessionState').mockResolvedValue({
      isStreaming: true, queue: { steeringEntries: [entry], followUpEntries: [] }, submittedMessages,
    })
    const send = vi.spyOn(transport, 'sendQueuedMessage')
    if (path === 'queue_update') {
      const old = piSessionStateStore.beginRequest('session-stop')
      event({ type: 'queue_update', steeringEntries: [entry], followUpEntries: [], submittedMessages })
      expect(piSessionStateStore.isRequestCurrent('session-stop', old)).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
    } else {
      // 新端／游标失效恢复只读取权威快照，不依赖曾收到立即发送事件。
      await readNativeSessionState('session-stop')
    }
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({
      queue: { steeringEntries: [entry], followUpEntries: [] }, submittedMessages,
    })
    expect(piSessionStateStore.getState('another-session')).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('refreshes the actual model on model_changed and invalidates older reads', async () => {
    const old = piSessionStateStore.beginRequest('session-stop')
    event({ type: 'model_changed' })
    expect(piSessionStateStore.isRequestCurrent('session-stop', old)).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(controllers.refreshPiSessionState).toHaveBeenCalledWith('session-stop')
  })

  it.each(['session_info_update', 'session_info_changed'])('refreshes the title and sidebar on %s without accepting an older state read', async type => {
    vi.mocked(controllers.refreshPiSessionState).mockImplementation(readNativeSessionState)
    vi.spyOn(transport, 'getPiSessionState').mockResolvedValueOnce({ sessionName: '修复会话自动命名', isStreaming: false })
    const changed = vi.fn()
    window.addEventListener('ompiui:sessions-changed', changed)
    try {
      piSessionStateStore.patchState('session-stop', { sessionName: '第一条用户消息' })
      const old = piSessionStateStore.beginRequest('session-stop')
      event(type === 'session_info_update' ? { type, sessionId: 'session-stop', title: '修复会话自动命名' } : { type, name: '修复会话自动命名' })
      expect(piSessionStateStore.isRequestCurrent('session-stop', old)).toBe(false)
      expect(changed).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(200)
      expect(transport.getPiSessionState).toHaveBeenCalledWith('session-stop', undefined)
      expect(piSessionStateStore.getState('session-stop')?.sessionName).toBe('修复会话自动命名')
      expect(piSessionStateStore.getState('another-session')).toBeNull()
    } finally {
      window.removeEventListener('ompiui:sessions-changed', changed)
    }
  })

  it('applies config_update from native slash commands to the correct session immediately', () => {
    event({ type: 'config_update', model: { provider: 'custom', id: 'correct' }, thinkingLevel: 'xhigh' })
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({
      model: { provider: 'custom', id: 'correct' }, thinkingLevel: 'xhigh',
    })
    expect(piSessionStateStore.getState('another-session')).toBeNull()
  })

  it('clears both streaming and activity immediately on agent_settled without waiting for HTTP', () => {
    activity({ 'session-stop': { type: 'busy' } })
    const old = piSessionStateStore.beginRequest('session-stop')
    event({ type: 'agent_settled' })
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({
      isStreaming: false, isIdle: true, isRetrying: false, isCompacting: false,
    })
    expect(activeSessionStore.getBusySessionsSnapshot()).toHaveLength(0)
    expect(piSessionStateStore.isRequestCurrent('session-stop', old)).toBe(true)
    expect(piSessionStateStore.setStateIfCurrent('session-stop', { isStreaming: true, isIdle: false, queue: [] }, old)).toBe(true)
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({ isStreaming: false, isIdle: true, queue: [] })
    expect(controllers.refreshPiSessionState).not.toHaveBeenCalled()
  })

  it('refreshes a session branch when the global activity snapshot settles after a missed runtime event', async () => {
    activity({ 'session-stop': { type: 'busy' } })
    activity({})
    await vi.advanceTimersByTimeAsync(150)
    expect(controllers.refreshPiBranch).toHaveBeenCalledWith('session-stop')
  })

  it('settles stale streaming only after the native readback confirms the global idle projection', async () => {
    vi.mocked(controllers.refreshPiSessionState).mockImplementation(readNativeSessionState)
    const { promise, resolve } = Promise.withResolvers<JsonObject>()
    vi.spyOn(transport, 'getPiSessionState').mockReturnValueOnce(promise)
    activity({ 'session-stop': { type: 'busy' } })
    activity({})
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({ isStreaming: true, isIdle: false })
    await vi.advanceTimersByTimeAsync(200)
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({ isStreaming: true, isIdle: false })
    resolve({ isStreaming: false, isIdle: true, isSettled: true, pendingMessageCount: 0, subagents: [] })
    const completion = vi.mocked(controllers.refreshPiSessionState).mock.results.at(-1)?.value
    if (!(completion instanceof Promise)) throw new Error('Scheduled native-state readback was not dispatched')
    await completion
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({ isStreaming: false, isIdle: true })
    expect(activeSessionStore.getBusySessionsSnapshot()).toHaveLength(0)
  })

  it('keeps retained native work busy after reconnect when the global snapshot omits the session', async () => {
    vi.mocked(controllers.refreshPiSessionState).mockImplementation(readNativeSessionState)
    vi.spyOn(transport, 'getPiSessionState').mockResolvedValueOnce({
      isStreaming: false, isIdle: false, isSettled: false, hasPendingAsyncWork: true, pendingMessageCount: 1,
    })
    const internal = piEventStream as unknown as { refCounts: Map<string, number> }
    internal.refCounts.set('session-stop', 1)
    activity({})
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({ isStreaming: true, isIdle: false })
    await vi.advanceTimersByTimeAsync(200)
    const completion = vi.mocked(controllers.refreshPiSessionState).mock.results.at(-1)?.value
    if (!(completion instanceof Promise)) throw new Error('Reconnect native-state readback was not dispatched')
    await completion
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({ isIdle: false, isSettled: false, pendingMessageCount: 1 })
    expect(activeSessionStore.getBusySessionsSnapshot().map(session => session.sessionId)).toContain('session-stop')
  })

  it('clears executing activity after Stop without settling or dropping the retained queue', async () => {
    vi.mocked(controllers.refreshPiSessionState).mockImplementation(readNativeSessionState)
    const retained = [{ text: 'continue later', entryId: 'queue:1' }]
    vi.spyOn(transport, 'getPiSessionState').mockResolvedValueOnce({
      isStreaming: false, isIdle: false, isSettled: false, hasPendingAsyncWork: false,
      pendingMessageCount: 1, queue: { followUpEntries: retained },
    })
    activity({ 'session-stop': { type: 'busy' } })
    event({ type: 'agent_end' })
    await vi.advanceTimersByTimeAsync(200)
    const completion = vi.mocked(controllers.refreshPiSessionState).mock.results.at(-1)?.value
    if (!(completion instanceof Promise)) throw new Error('Stop native-state readback was not dispatched')
    await completion
    expect(activeSessionStore.getBusySessionsSnapshot()).toHaveLength(0)
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({
      isStreaming: false, isIdle: false, isSettled: false, pendingMessageCount: 1,
      queue: { followUpEntries: retained },
    })
    event({ type: 'agent_start' })
    expect(activeSessionStore.getBusySessionsSnapshot().map(session => session.sessionId)).toContain('session-stop')
  })

  it('keeps pending background work active at agent_end until the session settles', () => {
    activity({ 'session-stop': { type: 'busy' } })
    piSessionStateStore.patchState('session-stop', { isStreaming: true, isIdle: false })
    event({ type: 'agent_end', isTerminal: false, yielded: true, awaitingAsyncWork: true })
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({
      isStreaming: false, isIdle: false, isSettled: false, hasPendingAsyncWork: true,
    })
    expect(activeSessionStore.getBusySessionsSnapshot()).toHaveLength(1)
    event({ type: 'agent_settled' })
    expect(activeSessionStore.getBusySessionsSnapshot()).toHaveLength(0)
  })
})

describe('tool_execution_update progress frames', () => {
  afterEach(() => {
    piBranchStore.clear('progress-session')
    vi.restoreAllMocks()
  })
  it('keeps existing call arguments when a progress frame carries no args', () => {
    const internal = piEventStream as unknown as {
      handlePiEvent(sessionId: string, payload: unknown): void
      scheduleBranchRefresh(sessionId: string): void
      scheduleStateRefresh(sessionId: string): void
    }
    const branchRefresh = vi.spyOn(internal, 'scheduleBranchRefresh').mockImplementation(() => undefined)
    vi.spyOn(internal, 'scheduleStateRefresh').mockImplementation(() => undefined)
    piBranchStore.setData('progress-session', fakeBranchPage('progress-session'))
    const args = { path: 'xd://task', content: '{"tasks":[{"name":"A","task":"x"}]}' }
    internal.handlePiEvent('progress-session', { event: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args } })
    branchRefresh.mockClear()
    internal.handlePiEvent('progress-session', { event: { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'write', partialResult: { content: [{ type: 'text', text: 'Running agent' }] } } })
    expect(piBranchStore.getData('progress-session')?.client?.toolExecutions?.['call-1']?.call).toMatchObject({ name: 'write', arguments: args })
    expect(branchRefresh).not.toHaveBeenCalled()
    const next = { path: 'xd://task', content: '{"tasks":[]}' }
    internal.handlePiEvent('progress-session', { event: { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'write', args: next } })
    expect(piBranchStore.getData('progress-session')?.client?.toolExecutions?.['call-1']?.call?.arguments).toEqual(next)
  })
})

describe('shared UI history', () => {
  afterEach(() => {
    piEventStream.disconnectAll()
    notificationStore.replaceShared([], new Set())
    vi.restoreAllMocks()
  })

  it('reads the server snapshot on resync and never overwrites a newer clear with a pending read', async () => {
    const pending = Promise.withResolvers<Response>()
    const row = { id: 'shared-run', type: 'completed', title: 'Job', body: '', sessionId: 'shared-session', timestamp: 10, read: false }
    vi.spyOn(modelSettingsSync, 'refreshOfficialSettings').mockImplementation(() => {})
    let notificationReads = 0
    vi.spyOn(http, 'piFetch').mockImplementation(async (url, options) => {
      if (url.includes('kind=notifications') && options?.method !== 'POST') {
        notificationReads++
        if (notificationReads === 1) return pending.promise
      }
      return Response.json({ entries: [] })
    })
    const replace = vi.spyOn(notificationStore, 'replaceShared')
    const internal = piEventStream as unknown as { handleResync(key: string): Promise<void> }
    await internal.handleResync('server')
    handleEvent({ stream: { kind: 'server', id: 'server' }, channel: 'ui.history', cursor: { epoch: 'history', sequence: 2 }, payload: { kind: 'notifications' } })
    pending.resolve(Response.json({ entries: [row] }))
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith([], expect.any(Set)))
    expect(replace).not.toHaveBeenCalledWith([row], expect.any(Set))
  })

  it('uses the selected session scope to hydrate feedback and does not append local duplicates', async () => {
    const full = { id: 'feedback-1', at: 7, sessionId: 'shared-session', command: '', status: 'info', message: 'full output\nlast line' }
    const internal = piEventStream as unknown as { refCounts: Map<string, number>; handlePiEvent(sessionId: string, payload: unknown): void }
    vi.spyOn(http, 'piFetch').mockResolvedValue(Response.json({ entries: [full] }))
    internal.refCounts.set(full.sessionId, 1)
    handleEvent({ stream: { kind: 'session', id: full.sessionId }, channel: 'ui.history', cursor: { epoch: 'history', sequence: 1 }, payload: { kind: 'feedback' } })
    internal.handlePiEvent(full.sessionId, { event: { type: 'command_output', text: full.message }, meta: { sequence: 1 }, sharedHistory: true })
    await vi.waitFor(() => expect(commandFeedbackStore.getSnapshot().sessions[full.sessionId]).toEqual([full]))
    piEventStream.disconnect(full.sessionId)
    expect(commandFeedbackStore.getSnapshot().sessions[full.sessionId]).toBeUndefined()
  })
})

describe('native notices and protocol feedback', () => {
  afterEach(() => { commandFeedbackStore.reset(); extensionDiagnosticStore.reset(); notificationStore.clearAll(); vi.restoreAllMocks() })

  it('retains global extension errors without assigning any session feedback or session notification', () => {
    const push = vi.spyOn(notificationStore, 'push').mockImplementation(() => {})
    const payload = { workerGeneration: 'worker', runtimeId: 'runtime', frame: { type: 'extension_error', extensionPath: '<timer>', event: 'timeout_callback', error: 'old callback\nlast line' } }
    handleEvent({ stream: { kind: 'server', id: 'server' }, channel: 'omp.extension_error', cursor: { epoch: 'diagnostic', sequence: 1 }, payload })
    expect(extensionDiagnosticStore.getSnapshot()[0]).toMatchObject({ message: payload.frame.error, runtimeId: 'runtime' })
    expect(commandFeedbackStore.getSnapshot().sessions).toEqual({})
    expect(push).not.toHaveBeenCalled()
    handleEvent({ stream: { kind: 'session', id: 'wrong' }, channel: 'omp.extension_error', cursor: { epoch: 'diagnostic', sequence: 2 }, payload })
    expect(extensionDiagnosticStore.getSnapshot()).toHaveLength(1)
    piEventStream.disconnectAll()
    expect(extensionDiagnosticStore.getSnapshot()).toEqual([])
  })

  it('keeps native open_url notifications within supported informational severity', () => {
    notificationStore.clearAll()
    const internal = piEventStream as unknown as { handleExtensionUiEvent(sessionId: string, event: unknown): void }
    // Exact supported open_url projection from the official worker bridge; no Node module enters the browser test graph.
    internal.handleExtensionUiEvent('native-link', { type: 'notify', sessionId: 'native-link', notifyType: 'link', message: '打开链接: https://example.invalid/native-help\nNative link instructions' })
    const notification = notificationStore.getSnapshot().notifications.find(entry => entry.sessionId === 'native-link')
    expect(notification).toMatchObject({ type: 'info', target: 'extensions' })
    expect(notification?.body).toContain('https://example.invalid/native-help')
    expect(commandFeedbackStore.getSnapshot().sessions['native-link']?.[0]).toMatchObject({ status: 'info', source: 'Extension' })
  })

  it('retains native severity, raw text, source and protocol context in the owning session', () => {
    const push = vi.spyOn(notificationStore, 'push').mockImplementation(() => {})
    const internal = piEventStream as unknown as { handlePiEvent(sessionId: string, payload: unknown): void }
    for (const level of ['info', 'warning', 'error']) {
      internal.handlePiEvent('notice-a', { event: { type: 'notice', level, message: `raw ${level}\nlast line\n`, source: 'native-source' }, meta: {} })
      expect(push).toHaveBeenLastCalledWith(level, 'native-source', `raw ${level}\nlast line\n`, 'notice-a', undefined, { target: 'extensions' })
    }
    internal.handlePiEvent('notice-b', { event: { type: 'rpc_frame_error', error: 'original error\n', text: 'suppression context', originalType: 'rpc_chunk' }, meta: {} })
    expect(commandFeedbackStore.getSnapshot().sessions['notice-b']?.[0]).toMatchObject({ source: 'OMP runtime', status: 'error', message: 'original error\n', originalType: 'rpc_chunk', context: 'suppression context' })
    expect(commandFeedbackStore.getSnapshot().sessions['notice-a']?.map(entry => entry.status)).toEqual(['error', 'warning', 'info'])
  })

  it('retains stream-loss errors and routes feedback only to their owning session', () => {
    const push = vi.spyOn(notificationStore, 'push').mockImplementation(() => {})
    const internal = piEventStream as unknown as { handlePiEvent(sessionId: string, payload: unknown): void }
    const error = 'rpc chunk isolated-stream length mismatch: got 1048577 expected 1048578\n'
    internal.handlePiEvent('stream-owner', { event: { type: 'rpc_stream_error', error, text: 'bounded suppression context', originalType: 'rpc_chunk' }, meta: {} })
    expect(commandFeedbackStore.getSnapshot().sessions['stream-owner']?.[0]).toMatchObject({ source: 'OMP runtime', status: 'error', message: error, originalType: 'rpc_chunk', context: 'bounded suppression context' })
    expect(commandFeedbackStore.getSnapshot().sessions['stream-other']).toBeUndefined()
    expect(push).toHaveBeenLastCalledWith('error', 'OMP runtime', error, 'stream-owner', undefined, { target: 'extensions' })
    internal.handlePiEvent('stream-owner', { event: { type: 'notice', level: 'info', message: 'normal feedback after stream loss', source: 'native-source' }, meta: {} })
    expect(commandFeedbackStore.getSnapshot().sessions['stream-owner']?.map(entry => entry.status)).toEqual(['info', 'error'])
  })

  it('does not turn extension warnings or informational native output into success', () => {
    const push = vi.spyOn(notificationStore, 'push').mockImplementation(() => {})
    const internal = piEventStream as unknown as { handleExtensionUiEvent(sessionId: string, event: unknown): void; handlePiEvent(sessionId: string, payload: unknown): void }
    internal.handleExtensionUiEvent('notice-a', { type: 'notify', sessionId: 'notice-a', notifyType: 'warning', message: 'extension warning' })
    expect(commandFeedbackStore.getSnapshot().sessions['notice-a']?.[0]).toMatchObject({ status: 'warning', source: 'Extension', message: 'extension warning' })
    expect(push).toHaveBeenLastCalledWith('warning', 'Extension', 'extension warning', 'notice-a', undefined, { target: 'extensions' })
    internal.handlePiEvent('notice-a', { event: { type: 'command_output', text: 'Usage only' }, meta: {} })
    expect(push).toHaveBeenLastCalledWith('info', 'Native command', 'Usage only', 'notice-a', undefined, { target: 'extensions' })
  })
})
