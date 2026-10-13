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
import { piEventStream } from './eventStream'
import { piBranchStore, piSessionStateStore, piCommandStore } from './state/index.js'
import { ompSubagentStore } from './ompSubagentStore'
import type { PiBranchPage } from './domain/index.js'
import { activeSessionStore } from '../store/activeSessionStore'
import * as controllers from './controllers/index.js'
import { buildPiLiveItems } from './selectors/index.js'
import * as http from './httpClient.js'

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
})

describe('omp.subagent routing across streams', () => {
  afterEach(() => {
    ompSubagentStore.clearAll()
  })

  function subagentEnvelope(stream: { kind: 'session' | 'server'; id: string }, payload: unknown) {
    return {
      protocolVersion: 2,
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

  it('recovers completed command results once without advancing the omitted event cursor', async () => {
    const command = { id: 'large-command', type: 'branch.get', status: 'completed' as const, submittedAt: '2026-10-13', result: { text: 'complete' } }
    let release: ((value: Response) => void) | undefined
    const read = vi.spyOn(http, 'piFetch').mockImplementation(() => new Promise(resolve => { release = resolve }))
    const internal = piEventStream as unknown as { cursors: Map<string, unknown> }
    internal.cursors.set('server', { epoch: 'test', sequence: 7 })
    const frame = { channel: 'control', type: 'payload_omitted', stream: { kind: 'server', id: 'server' }, eventChannel: 'command.updated', commandId: command.id }
    raw(frame)
    raw(frame)
    expect(read).toHaveBeenCalledOnce()
    release?.(new Response(JSON.stringify({ command })))
    await vi.waitFor(() => expect(piCommandStore.get(command.id)).toEqual(command))
    expect(piCommandStore.get(command.id)).toEqual(command)
    expect(internal.cursors.get('server')).toEqual({ epoch: 'test', sequence: 7 })
  })

  it('notifies terminal-list consumers even when the omitted event is not a session event', () => {
    const listener = vi.fn()
    window.addEventListener('ompiui:terminals-changed', listener)
    try {
      raw({ channel: 'control', type: 'payload_omitted', stream: { kind: 'workspace', id: 'C:/p' }, eventChannel: 'terminal.updated' })
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('ompiui:terminals-changed', listener)
    }
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

  it('refreshes the actual model on model_changed and invalidates older reads', async () => {
    const old = piSessionStateStore.beginRequest('session-stop')
    event({ type: 'model_changed' })
    expect(piSessionStateStore.isRequestCurrent('session-stop', old)).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(controllers.refreshPiSessionState).toHaveBeenCalledWith('session-stop')
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
    expect(piSessionStateStore.isRequestCurrent('session-stop', old)).toBe(false)
    expect(controllers.refreshPiSessionState).not.toHaveBeenCalled()
  })

  it('clears stale streaming when the global activity snapshot reports idle', () => {
    activity({ 'session-stop': { type: 'busy' } })
    activity({})
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({ isStreaming: false, isIdle: true })
    expect(activeSessionStore.getBusySessionsSnapshot()).toHaveLength(0)
  })

  it('reconciles a cached busy state on reconnect even without an earlier active snapshot', () => {
    const internal = piEventStream as unknown as { refCounts: Map<string, number> }
    internal.refCounts.set('session-stop', 1)
    activity({})
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({ isStreaming: false, isIdle: true })
  })

  it('keeps pending background work active at agent_end until the session settles', () => {
    activity({ 'session-stop': { type: 'busy' } })
    piSessionStateStore.patchState('session-stop', { hasPendingAsyncWork: true, isIdle: false })
    event({ type: 'agent_end' })
    expect(piSessionStateStore.getState('session-stop')).toMatchObject({
      isStreaming: false, isIdle: false, hasPendingAsyncWork: true,
    })
    expect(activeSessionStore.getBusySessionsSnapshot()).toHaveLength(1)
    event({ type: 'agent_settled' })
    expect(activeSessionStore.getBusySessionsSnapshot()).toHaveLength(0)
  })
})
