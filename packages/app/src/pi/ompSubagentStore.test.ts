/**
 * ompSubagentStore 的 HUD 语义测试：
 * - selectHudRuns：只取 detached run，运行中在前、终态按结束时间在后
 * - dismiss：从列表移除 + localStorage 持久化，后续帧不再恢复
 * - applySnapshot：worker state.get 注册表快照恢复（刷新/重连场景）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { ompSubagentStore, selectHudRuns, transcriptItemsFromMessages } from './ompSubagentStore'

const DISMISSED_KEY = 'piui-omp-subagent-hud-dismissed'

describe('ompSubagentStore HUD', () => {
  beforeEach(() => {
    localStorage.clear()
    ompSubagentStore.clearAll()
  })

  it('selectHudRuns keeps only detached runs with running first', () => {
    // 先创建 running-1，再创建 running-2（稳定排序下两者 startedAt 相等时按插入序）
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-1', detached: true, status: 'started', agent: 'task', index: 0 })
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-2', detached: true, status: 'started', agent: 'task', index: 1 })
    // 非 detached：task 工具内联等待的普通子代理，不进 HUD
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-3', detached: false, status: 'started', agent: 'task', index: 2 })

    expect(selectHudRuns(ompSubagentStore.getSnapshot()).map(run => run.id)).toEqual(['run-1', 'run-2'])

    // run-1 结束后沉到运行中条目之后
    ompSubagentStore.applyLifecycle('session-a', { id: 'run-1', detached: true, status: 'completed', agent: 'task', index: 0 })
    expect(selectHudRuns(ompSubagentStore.getSnapshot()).map(run => run.id)).toEqual(['run-2', 'run-1'])
  })

  it('dismiss removes the run, persists it, and suppresses later frames', () => {
    ompSubagentStore.applyLifecycle('session-a', { id: 'hud-run-1', detached: true, status: 'completed', agent: 'task', index: 0 })
    expect(ompSubagentStore.getSnapshot().runs.some(run => run.id === 'hud-run-1')).toBe(true)

    ompSubagentStore.dismiss('hud-run-1')
    expect(ompSubagentStore.getSnapshot().runs.some(run => run.id === 'hud-run-1')).toBe(false)
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')).toContain('hud-run-1')

    // 迟到的 progress 帧 / 快照恢复都不应把被清除的 run 带回来
    ompSubagentStore.applyProgress('session-a', { id: 'hud-run-1', task: 'late', detached: true })
    ompSubagentStore.applySnapshot('session-a', [{ id: 'hud-run-1', detached: true, status: 'completed' }])
    expect(ompSubagentStore.getSnapshot().runs.some(run => run.id === 'hud-run-1')).toBe(false)
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
    // 非 detached 的快照条目只进 store（内联视图用），不进 HUD
    expect(selectHudRuns(ompSubagentStore.getSnapshot()).some(run => run.id === 'snap-2')).toBe(false)
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
})
