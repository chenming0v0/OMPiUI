/**
 * ompSubagentStore 状态测试：
 * - applySnapshot：worker state.get 注册表快照恢复（刷新/重连场景）
 * - 生命周期/进度/事件合并、代际替换、终态封口
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ompSubagentStore, transcriptItemsFromMessages } from './ompSubagentStore'

describe('ompSubagentStore state', () => {
  beforeEach(() => {
    localStorage.clear()
    ompSubagentStore.clearAll()
  })

  it('applySnapshot restores detached runs from the worker registry snapshot', () => {
    ompSubagentStore.applySnapshot('session-b', [
      { id: 'snap-1', detached: true, agent: 'task', status: 'running', task: 'do work', index: 0 },
      { id: 'snap-2', detached: false, agent: 'task', status: 'completed', index: 1 },
    ])

    const runs = ompSubagentStore.getSnapshot().runs
    const restored = runs.find(run => run.id === 'snap-1')
    expect(restored).toBeDefined()
    expect(restored?.detached).toBe(true)
    expect(restored?.task).toBe('do work')
    expect(restored?.status).toBe('running')
    expect(runs.find(run => run.id === 'snap-2')?.detached).toBe(false)
  })

  it('settles missing runs and their live tools after an authoritative idle reconnect', () => {
    ompSubagentStore.applyLifecycle('session-a', { id: 'lost', status: 'started', detached: false })
    ompSubagentStore.applyProgress('session-a', { id: 'lost', progress: { status: 'running' } })
    ompSubagentStore.applyEvent('session-a', {
      id: 'lost', event: { type: 'tool_execution_start', toolCallId: 'lost-read', toolName: 'read' },
    })
    ompSubagentStore.applyLifecycle('session-a', { id: 'finished', status: 'completed' })
    ompSubagentStore.applyLifecycle('session-b', { id: 'other', status: 'started', detached: true })
    ompSubagentStore.applySnapshot('session-a', [], true)
    expect(ompSubagentStore.runsForSession('session-a').find(run => run.id === 'lost')).toMatchObject({
      status: 'aborted', progress: { status: 'aborted' },
      transcript: [{ toolCallId: 'lost-read', toolStatus: 'error', streaming: false }],
    })
    expect(ompSubagentStore.runsForSession('session-a').find(run => run.id === 'finished')?.status).toBe('completed')
    expect(ompSubagentStore.runsForSession('session-b')[0]?.status).toBe('running')
  })

  it('does not stop present detached agents or infer failure from a partial busy snapshot', () => {
    ompSubagentStore.applyLifecycle('session-a', { id: 'active', status: 'started', detached: true })
    ompSubagentStore.applySnapshot('session-a', [])
    expect(ompSubagentStore.runsForSession('session-a')[0]?.status).toBe('running')
    ompSubagentStore.applySnapshot('session-a', [{ id: 'active', status: 'running', detached: true }], true)
    expect(ompSubagentStore.runsForSession('session-a')[0]?.status).toBe('running')
  })

  it('accepts the official progress.id identity without requiring an outer id', () => {
    ompSubagentStore.applyLifecycle('session-a', { id: 'native-progress', parentToolCallId: 'call-native', status: 'started', index: 0 })
    ompSubagentStore.applyProgress('session-a', {
      index: 0, parentToolCallId: 'call-native', sessionFile: 'C:/sessions/native-progress.jsonl',
      task: 'Inspect the source', progress: { id: 'native-progress', status: 'running', currentTool: 'read', tokens: 42 },
    })
    expect(ompSubagentStore.getRunsForToolCall('call-native', 'session-a')[0]).toMatchObject({
      task: 'Inspect the source', sessionFile: 'C:/sessions/native-progress.jsonl',
      progress: { currentTool: 'read', tokens: 42 },
    })
  })

  it('keeps concurrent runs for one task and never regresses a terminal run', () => {
    ompSubagentStore.applyLifecycle('session-task', {
      id: 'child-a', parentToolCallId: 'task-call', detached: false, status: 'started', index: 0,
    })
    ompSubagentStore.applyLifecycle('session-task', {
      id: 'child-b', parentToolCallId: 'task-call', detached: false, status: 'started', index: 1,
    })

    expect(ompSubagentStore.getRunsForToolCall('task-call', 'session-task').map(run => run.id)).toEqual(['child-a', 'child-b'])

    ompSubagentStore.applyLifecycle('session-task', {
      id: 'child-a', parentToolCallId: 'task-call', status: 'completed', index: 0,
    })
    // 迟到的 started/部分 lifecycle 帧不能让已完成子代理重新闪回运行中。
    ompSubagentStore.applyLifecycle('session-task', {
      id: 'child-a', parentToolCallId: 'task-call', status: 'started', index: 0,
    })
    ompSubagentStore.applyProgress('session-task', {
      id: 'child-a', progress: { status: 'running', tokens: 50 },
    })
    ompSubagentStore.applySnapshot('session-task', [
      { id: 'child-a', status: 'running' },
      { id: 'child-b', status: 'pending' },
    ])

    expect(ompSubagentStore.getRunsForToolCall('task-call', 'session-task').map(run => [run.id, run.status, run.detached])).toEqual([
      ['child-a', 'completed', false],
      ['child-b', 'running', false],
    ])
  })

  it('reopens a reused registry ID and rejects old generation terminal frames', () => {
    ompSubagentStore.applyLifecycle('reuse', { id: 'child', runId: 'run:1', parentToolCallId: 'call:1', status: 'started' })
    ompSubagentStore.applyLifecycle('reuse', { id: 'child', runId: 'run:1', parentToolCallId: 'call:1', status: 'completed' })
    ompSubagentStore.applyLifecycle('reuse', { id: 'child', runId: 'run:2', parentToolCallId: 'call:2', status: 'started' })
    ompSubagentStore.applyProgress('reuse', { id: 'child', runId: 'run:2', progress: { status: 'running', tokens: 72 } })
    ompSubagentStore.applyLifecycle('reuse', { id: 'child', runId: 'run:1', parentToolCallId: 'call:1', status: 'failed' })
    expect(ompSubagentStore.getRunsForToolCall('call:1', 'reuse')).toEqual([])
    expect(ompSubagentStore.getRunsForToolCall('call:2', 'reuse')[0]).toMatchObject({ runId: 'run:2', status: 'running', progress: { tokens: 72 }, endedAt: undefined })
  })

  it('reopens an autonomous wake with the same parent and file without inheriting old run state', () => {
    const identity = { id: 'wake', parentToolCallId: 'same-parent', sessionFile: 'C:/wake.jsonl' }
    ompSubagentStore.applyLifecycle('wake-parent', { ...identity, runId: 'wake:1', status: 'started', detached: true })
    ompSubagentStore.applyProgress('wake-parent', { ...identity, runId: 'wake:1', task: 'Old assignment', progress: { tokens: 100, status: 'running' } })
    ompSubagentStore.applyLifecycle('wake-parent', { ...identity, runId: 'wake:1', status: 'completed' })
    ompSubagentStore.applyLifecycle('wake-parent', { ...identity, runId: 'wake:2', status: 'started', detached: true })
    ompSubagentStore.applyEvent('wake-parent', { ...identity, runId: 'wake:2', event: { type: 'message_end', message: { role: 'assistant', content: 'New wake response' } } }, 'same-event')
    ompSubagentStore.applySnapshot('wake-parent', [{ ...identity, runId: 'wake:1', status: 'failed' }])
    const current = ompSubagentStore.runsForSession('wake-parent')[0]
    expect(current).toMatchObject({ runId: 'wake:2', status: 'running', task: '', detached: true })
    expect(current.progress).toBeUndefined()
    expect(current.endedAt).toBeUndefined()
    expect(current.transcript.map(item => item.text)).toEqual(['New wake response'])
  })

  it.each(['lifecycle', 'progress', 'snapshot'] as const)('seals unfinished transcript tools on terminal %s without losing completed results', source => {
    const identity = { id: `terminal-${source}`, runId: `terminal:${source}` }
    ompSubagentStore.applyLifecycle('terminal-parent', { ...identity, status: 'started' })
    ompSubagentStore.applyEvent('terminal-parent', { ...identity, event: { type: 'tool_execution_start', toolCallId: 'done', toolName: 'read' } })
    ompSubagentStore.applyEvent('terminal-parent', { ...identity, event: { type: 'tool_execution_end', toolCallId: 'done', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'Read completed' }] } } })
    ompSubagentStore.applyEvent('terminal-parent', { ...identity, event: { type: 'tool_execution_start', toolCallId: 'lost', toolName: 'bash' } })
    if (source === 'lifecycle') ompSubagentStore.applyLifecycle('terminal-parent', { ...identity, status: 'failed' })
    if (source === 'progress') ompSubagentStore.applyProgress('terminal-parent', { ...identity, progress: { status: 'failed' } })
    if (source === 'snapshot') ompSubagentStore.applySnapshot('terminal-parent', [{ ...identity, status: 'failed' }])
    const transcript = ompSubagentStore.runsForSession('terminal-parent')[0].transcript
    expect(transcript.find(item => item.toolCallId === 'done')).toMatchObject({ toolStatus: 'completed' })
    expect(transcript.find(item => item.toolCallId === 'lost')).toMatchObject({ toolStatus: 'error', streaming: false })
  })

  it('does not stop detached work missing from a settled parent snapshot', () => {
    ompSubagentStore.applyLifecycle('parent', { id: 'background', runId: 'bg:1', status: 'started', detached: true })
    ompSubagentStore.applySnapshot('parent', [], true)
    expect(ompSubagentStore.runsForSession('parent')[0].status).toBe('running')
  })
})

/**
 * 转录去重回归：OMP 消息事件的 start/update/end 每帧都带完整 message
 * （update 是累计快照）。按真实 RPC 抓包帧序列回放，同一条 user 消息和
 * 同一次 assistant 回复都必须只渲染一行。
 */
describe('ompSubagentStore transcript dedupe', () => {
  const ASSIGNMENT = 'Complete assignment thoroughly:\n\n# Target\nNo files. No tools.'

  beforeEach(() => {
    localStorage.clear()
    ompSubagentStore.clearAll()
  })

  function seedRun(id: string) {
    ompSubagentStore.applyLifecycle('session-t', { id, detached: true, status: 'started', agent: 'task', index: 0 })
  }

  function feed(id: string, events: unknown[]) {
    for (const event of events) {
      ompSubagentStore.applyEvent('session-t', { id, event } as never)
    }
  }

  it('ping run: one user message and one streamed reply render exactly one line each', () => {
    seedRun('dedupe-1')
    feed('dedupe-1', [
      // user 消息：start + end（全文相同）
      { type: 'message_start', message: { role: 'user', content: ASSIGNMENT } },
      { type: 'message_end', message: { role: 'user', content: ASSIGNMENT } },
      // assistant：thinking 流（无文本）→ text 流（累计）→ end
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reply pong' }] } },
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reply pong' }, { type: 'text', text: 'pong' }] } },
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reply pong' }, { type: 'text', text: 'pong' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reply pong' }, { type: 'text', text: 'pong' }] } },
      // developer 提醒：不进转录
      { type: 'message_start', message: { role: 'developer', content: '<system-reminder>...</system-reminder>' } },
      { type: 'message_end', message: { role: 'developer', content: '<system-reminder>...</system-reminder>' } },
      // 纯 thinking + 工具调用的 assistant 消息：不留空行
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'yield now' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'yield now' }] } },
      { type: 'tool_execution_end', toolName: 'yield', isError: true },
      { type: 'tool_execution_end', toolName: 'yield' },
    ])

    const run = ompSubagentStore.getSnapshot().runs.find(item => item.id === 'dedupe-1')
    expect(run?.transcript.map(item => [item.kind, item.text || item.toolName])).toEqual([
      ['user', ASSIGNMENT],
      ['assistant', 'pong'],
      ['tool', 'yield'],
      ['tool', 'yield'],
    ])
  })

  it('two consecutive assistant text messages stay separate lines', () => {
    seedRun('dedupe-2')
    feed('dedupe-2', [
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    ])

    const run = ompSubagentStore.getSnapshot().runs.find(item => item.id === 'dedupe-2')
    expect(run?.transcript.map(item => item.text)).toEqual(['first', 'second'])
  })

  it('non-streamed assistant message (end only) renders once', () => {
    seedRun('dedupe-3')
    feed('dedupe-3', [
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } },
    ])

    const run = ompSubagentStore.getSnapshot().runs.find(item => item.id === 'dedupe-3')
    expect(run?.transcript.map(item => item.text)).toEqual(['final'])
  })
})

describe('ompSubagentStore disk backfill', () => {
  beforeEach(() => {
    localStorage.clear()
    ompSubagentStore.clearAll()
  })

  it('maps raw subagent session messages to transcript items', () => {
    const items = transcriptItemsFromMessages([
      { role: 'user', content: [{ type: 'text', text: 'Complete assignment thoroughly:' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'pong' }] },
      { role: 'developer', content: '<system-reminder>...</system-reminder>' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'yield' }] },
      { role: 'toolResult', toolName: 'yield', isError: true, content: [{ type: 'text', text: 'err' }] },
      { role: 'toolResult', toolName: 'yield', isError: false, content: [{ type: 'text', text: 'ok' }] },
    ])

    expect(items.map(item => [item.kind, item.text || item.toolName, item.isError ?? false])).toEqual([
      ['user', 'Complete assignment thoroughly:', false],
      ['assistant', 'pong', false],
      ['tool', 'yield', true],
      ['tool', 'yield', false],
    ])
  })

  it('applyHistory fills an empty transcript and marks the run backfilled', () => {
    ompSubagentStore.applyLifecycle('session-h', { id: 'hist-1', detached: true, status: 'started', agent: 'task', index: 0 })
    ompSubagentStore.applyHistory('session-h', 'hist-1', [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
    ])

    const run = ompSubagentStore.getSnapshot().runs.find(item => item.id === 'hist-1')
    expect(run?.historyLoaded).toBe(true)
    expect(run?.transcript.map(item => item.text)).toEqual(['ping', 'pong'])
  })

  it('applyHistory never clobbers a live transcript and ignores unknown runs', () => {
    ompSubagentStore.applyLifecycle('session-h', { id: 'hist-2', detached: true, status: 'started', agent: 'task', index: 0 })
    ompSubagentStore.applyEvent('session-h', { id: 'hist-2', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'live' }] } } })
    ompSubagentStore.applyHistory('session-h', 'hist-2', [{ role: 'user', content: 'stale history' }])
    const run = ompSubagentStore.getSnapshot().runs.find(item => item.id === 'hist-2')
    expect(run?.transcript.map(item => item.text)).toEqual(['live'])
    expect(run?.historyLoaded).toBe(true)

    // 未知 run：不凭空创建
    ompSubagentStore.applyHistory('session-h', 'hist-ghost', [{ role: 'user', content: 'x' }])
    expect(ompSubagentStore.getSnapshot().runs.some(item => item.id === 'hist-ghost')).toBe(false)
  })

  it('backfills an incomplete reconnect preview only after the run settles', () => {
    ompSubagentStore.applyLifecycle('s', { id: 'partial-history', status: 'started' })
    const event = { type: 'message_patch', role: 'assistant', messageId: 'm',
      phase: 'message_end', textOffset: 100, textDelta: 'tail', textTailOffset: 90, textTail: 'reply tail' }
    ompSubagentStore.applyEvent('s', { id: 'partial-history', event }, 'patch-1')
    ompSubagentStore.applyHistory('s', 'partial-history', [{ role: 'assistant', content: 'full disk reply' }])
    expect(ompSubagentStore.runsForSession('s')[0]?.transcript[0]?.text).toBe('reply tail')
    ompSubagentStore.applyLifecycle('s', { id: 'partial-history', status: 'completed' })
    ompSubagentStore.applyHistory('s', 'partial-history', [{ role: 'assistant', content: 'full disk reply' }])
    expect(ompSubagentStore.runsForSession('s')[0]?.transcript[0]?.text).toBe('full disk reply')
  })
  it('rejects stale disk history after a same-ID same-file generation replacement', () => {
    const identity = { id: 'history-wake', parentToolCallId: 'parent', sessionFile: 'C:/wake.jsonl' }
    ompSubagentStore.applyLifecycle('history-parent', { ...identity, runId: 'old', status: 'completed' })
    ompSubagentStore.applyLifecycle('history-parent', { ...identity, runId: 'new', status: 'started' })
    ompSubagentStore.applyHistory('history-parent', identity.id, [{ role: 'assistant', content: 'Old wake history' }], undefined, { runId: 'old', sessionFile: identity.sessionFile })
    expect(ompSubagentStore.runsForSession('history-parent')[0].transcript).toEqual([])
    expect(ompSubagentStore.runsForSession('history-parent')[0].historyLoaded).toBe(false)
    ompSubagentStore.applyHistory('history-parent', identity.id, [{ role: 'assistant', content: 'Current wake history' }], undefined, { runId: 'new', sessionFile: identity.sessionFile })
    expect(ompSubagentStore.runsForSession('history-parent')[0].transcript.map(item => item.text)).toEqual(['Current wake history'])
  })
})

/**
 * 内联转录分片（getRunsForToolCall）的订阅语义：TaskRenderer 按 call.id
 * 订阅自己的分片，引用稳定性是防卡死的关键——别的 run 刷帧绝不能让
 * 本键分片换引用，否则长会话里每个 task 行都跟着每个子代理帧重渲染。
 */
describe('ompSubagentStore toolCall slices', () => {
  beforeEach(() => {
    localStorage.clear()
    ompSubagentStore.clearAll()
  })

  it('filters by call id and parent session', () => {
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-1', detached: false, status: 'started', agent: 'task', parentToolCallId: 'call-1', index: 0 })
    ompSubagentStore.applyLifecycle('session-b', { id: 'run-2', detached: false, status: 'started', agent: 'task', parentToolCallId: 'call-1', index: 1 })
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-3', detached: false, status: 'started', agent: 'task', parentToolCallId: 'call-2', index: 2 })

    expect(ompSubagentStore.getRunsForToolCall('call-1', 'session-a').map(run => run.id)).toEqual(['run-1'])
    expect(ompSubagentStore.getRunsForToolCall('call-1', undefined).map(run => run.id)).toEqual(['run-1', 'run-2'])
    expect(ompSubagentStore.getRunsForToolCall('call-2', 'session-a').map(run => run.id)).toEqual(['run-3'])
    expect(ompSubagentStore.getRunsForToolCall(undefined, 'session-a')).toEqual([])
  })

  it('keeps the slice reference stable while unrelated runs stream', () => {
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-1', detached: false, status: 'started', agent: 'task', parentToolCallId: 'call-1', index: 0 })
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-2', detached: false, status: 'started', agent: 'task', parentToolCallId: 'call-2', index: 1 })
    const first = ompSubagentStore.getRunsForToolCall('call-1', 'session-a')

    // 别的 run 连刷 20 帧：call-1 的分片保持同一引用
    for (let i = 0; i < 20; i++) {
      ompSubagentStore.applyEvent('session-a', { id: 'run-2', event: { type: 'tool_execution_end', toolName: 'read' } })
    }
    expect(ompSubagentStore.getRunsForToolCall('call-1', 'session-a')).toBe(first)

    // 本 run 刷帧：分片换引用，内容同步更新
    ompSubagentStore.applyEvent('session-a', { id: 'run-1', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } })
    const after = ompSubagentStore.getRunsForToolCall('call-1', 'session-a')
    expect(after).not.toBe(first)
    expect(after[0]?.transcript.map(item => item.text)).toEqual(['hi'])
  })

  it('preserves transcript references across progress updates and ignores events with no rendered change', () => {
    ompSubagentStore.applyLifecycle('s', { id: 'stable-transcript', parentToolCallId: 'call', status: 'started' })
    ompSubagentStore.applyEvent('s', { id: 'stable-transcript', event: {
      type: 'message_patch', messageId: 'm', role: 'assistant', phase: 'message_update', textOffset: 0, textDelta: 'Working',
    } }, 'text')
    const transcript = ompSubagentStore.runsForSession('s')[0]?.transcript
    ompSubagentStore.applyProgress('s', { id: 'stable-transcript', progress: { tokens: 200 } })
    expect(ompSubagentStore.runsForSession('s')[0]?.transcript).toBe(transcript)
    const slice = ompSubagentStore.getRunsForToolCall('call', 's')
    ompSubagentStore.applyEvent('s', { id: 'stable-transcript', event: { type: 'turn_start' } }, 'ignored')
    expect(ompSubagentStore.getRunsForToolCall('call', 's')).toBe(slice)
  })

  it('ignores duplicate event snapshots while keeping later updates', () => {
    ompSubagentStore.applyLifecycle('session-a', {
      id: 'dedupe-events', detached: false, status: 'started', agent: 'task', parentToolCallId: 'call-1', index: 0,
    })
    const update = {
      id: 'dedupe-events',
      event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } },
    }
    ompSubagentStore.applyEvent('session-a', update)
    ompSubagentStore.applyEvent('session-a', update)
    ompSubagentStore.applyEvent('session-a', {
      id: 'dedupe-events',
      event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } },
    })

    const run = ompSubagentStore.getRunsForToolCall('call-1', 'session-a')[0]
    expect(run?.transcript).toHaveLength(1)
    expect(run?.transcript[0]?.text).toBe('final')
  })

  it('deduplicates chunk replay by event identity without serializing cumulative text', () => {
    ompSubagentStore.applyLifecycle('s', { id: 'patch-replay', parentToolCallId: 'call', status: 'started' })
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      const payload = { id: 'patch-replay', event: {
        type: 'message_patch', messageId: 'm', role: 'assistant', phase: 'message_update',
        textOffset: 0, textDelta: 'a'.repeat(100000),
      } }
      ompSubagentStore.applyEvent('s', payload, 'patch-1')
      const first = ompSubagentStore.getRunsForToolCall('call', 's')
      ompSubagentStore.applyEvent('s', payload, 'patch-1')
      expect(ompSubagentStore.getRunsForToolCall('call', 's')).toBe(first)
      ompSubagentStore.applyEvent('s', { id: 'patch-replay', event: {
        ...payload.event, textOffset: 100000, textDelta: 'final', phase: 'message_end',
      } }, 'patch-2')
      expect(ompSubagentStore.runsForSession('s')[0]?.transcript[0]?.text).toBe(`${'a'.repeat(100000)}final`)
      expect(stringify).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })

  it('invalidates slices on clearSession', () => {
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-1', detached: false, status: 'started', agent: 'task', parentToolCallId: 'call-1', index: 0 })
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-4', detached: false, status: 'started', agent: 'task', parentToolCallId: 'call-1', index: 3 })
    const first = ompSubagentStore.getRunsForToolCall('call-1', 'session-a')
    expect(first.map(run => run.id)).toEqual(['run-1', 'run-4'])

    ompSubagentStore.clearSession('session-a')
    expect(ompSubagentStore.getRunsForToolCall('call-1', 'session-a')).not.toBe(first)
    expect(ompSubagentStore.getRunsForToolCall('call-1', 'session-a')).toEqual([])
  })

  it('coalesces high-frequency frames into one listener notification per frame', async () => {
    let notifications = 0
    const unsubscribe = ompSubagentStore.subscribe(() => { notifications += 1 })
    // 排掉 beforeEach clearAll 留下的 rAF，避免计数漂
    await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()) })
    notifications = 0
    ompSubagentStore.applyLifecycle('session-a', { id: 'coalesce-1', detached: false, status: 'started', agent: 'task', index: 0 })
    for (let i = 0; i < 50; i++) {
      ompSubagentStore.applyEvent('session-a', { id: 'coalesce-1', event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: `chunk ${i}` }] } } })
    }
    // 数据同步可见（revision 在 bump 时已推进），listener 通知合并到下一帧
    const run = ompSubagentStore.getSnapshot().runs.find(item => item.id === 'coalesce-1')
    expect(run?.transcript.length).toBeGreaterThan(0)
    expect(notifications).toBe(0)
    await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()) })
    expect(notifications).toBe(1)
    unsubscribe()
  })

  it('does not use the wrapping assignment prompt as the HUD title', () => {
    ompSubagentStore.applyLifecycle('session-s', {
      id: 'scout-run',
      parentToolCallId: 'call-batch',
      index: 0,
      agent: 'scout',
      status: 'started',
      description: 'Complete assignment thoroughly:\n\n# Target',
    })
    ompSubagentStore.applyProgress('session-s', {
      id: 'scout-run',
      assignment: 'Complete assignment thoroughly:\n\n# Target',
      task: 'Complete assignment thoroughly:\n\n# Target',
    })
    const run = ompSubagentStore.getRunsForToolCall('call-batch', 'session-s')[0]
    expect(run?.description).toBeUndefined()
    expect(run?.task).toMatch(/^Complete assignment thoroughly/)
  })
})
