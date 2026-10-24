// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ompSubagentStore, type OmpSubagentRun } from '../../../../omp/ompSubagentStore'
import { SubagentSessionPreview } from './SubagentSessionPreview'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${values.count} ${key.split('.').at(-1)}`,
  }),
}))
const getHistory = vi.hoisted(() => vi.fn())
vi.mock('../../../../omp/transport/index.js', () => ({ getOmpSubagentMessages: getHistory }))

function run(text = 'Current reply'): OmpSubagentRun {
  return {
    id: 'preview-run',
    sessionId: 'parent',
    agent: 'scout',
    task: 'Inspect the source',
    status: 'running',
    index: 0,
    detached: false,
    startedAt: 0,
    historyLoaded: true,
    transcript: [{ kind: 'assistant', text, timestamp: 1 }],
    progress: {
      recentOutput: [text],
      recentTools: [],
      tokens: 123,
      toolCount: 10,
      requests: 1,
      cost: 0,
      durationMs: 3000,
    },
  }
}

describe('SubagentSessionPreview', () => {
  beforeEach(() => {
    getHistory.mockReset()
    // 严格模式双挂载/重试会让调用次数超过 Once 队列；默认回空，测试内再按需覆盖。
    getHistory.mockResolvedValue({ messages: [] })
    ompSubagentStore.clearAll()
  })
  it('keeps live progress visible while a transcript is already rendered', () => {
    render(<SubagentSessionPreview run={run()} />)
    expect(screen.getAllByText('Current reply')).toHaveLength(1)
    expect(screen.getByText('10 tools')).toBeInTheDocument()
    expect(screen.getByText('1 requests')).toBeInTheDocument()
    expect(screen.getByText('123 tokens')).toBeInTheDocument()
  })

  it('shows loading skeletons only while reading history, then an unframed waiting state', () => {
    const { rerender } = render(<SubagentSessionPreview loading />)
    expect(screen.getByRole('status', { name: 'common:loading' })).toBeInTheDocument()
    expect(screen.queryByText('task.waitingForResponse')).not.toBeInTheDocument()
    rerender(<SubagentSessionPreview />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('task.waitingForResponse')).not.toHaveClass('border')
  })

  it('never hides live tool progress behind an unfinished history request', () => {
    render(<SubagentSessionPreview loading run={{
      ...run(), transcript: [], historyLoaded: false,
      progress: { ...run().progress!, currentTool: 'read', lastIntent: 'Inspect source files' },
    }} />)
    expect(screen.queryByRole('status', { name: 'common:loading' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('read')
    expect(screen.getByRole('status')).toHaveTextContent('Inspect source files')
  })

  it('follows a large append when pinned but preserves position after the user scrolls up', () => {
    const { container, rerender } = render(<SubagentSessionPreview run={run()} />)
    const scroll = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let height = 300
    Object.defineProperties(scroll, {
      scrollHeight: { get: () => height, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    scroll.scrollTop = 200
    fireEvent.scroll(scroll)
    height = 1000
    rerender(<SubagentSessionPreview run={run('A much longer reply')} />)
    expect(scroll.scrollTop).toBe(1000)
    scroll.scrollTop = 100
    fireEvent.scroll(scroll)
    height = 1500
    rerender(<SubagentSessionPreview run={run('Another long update')} />)
    expect(scroll.scrollTop).toBe(100)
  })

  it('opens completed history at the top so its first message is visible', () => {
    const initial = { ...run('Initial assignment'), status: 'completed' as const, transcript: [] }
    const { container, rerender } = render(<SubagentSessionPreview run={initial} />)
    rerender(
      <SubagentSessionPreview
        run={{
          ...initial,
          transcript: [
            { kind: 'user', text: 'Initial assignment', timestamp: 0 },
            { kind: 'assistant', text: 'Completed reply', timestamp: 1 },
          ],
        }}
      />,
    )
    const scroll = container.querySelector('.overflow-y-auto') as HTMLDivElement
    Object.defineProperties(scroll, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    rerender(
      <SubagentSessionPreview
        run={{
          ...initial,
          transcript: [
            { kind: 'user', text: 'Initial assignment', timestamp: 0 },
            { kind: 'assistant', text: 'More loaded history', timestamp: 1 },
          ],
        }}
      />,
    )
    expect(scroll.scrollTop).toBe(0)
    expect(screen.getByText('Initial assignment')).toBeInTheDocument()
  })

  it('still follows the final response when a live run completes', () => {
    const { container, rerender } = render(<SubagentSessionPreview run={run()} />)
    const scroll = container.querySelector('.overflow-y-auto') as HTMLDivElement
    Object.defineProperties(scroll, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    rerender(<SubagentSessionPreview run={{ ...run('Final response'), status: 'completed' }} />)
    expect(scroll.scrollTop).toBe(1000)
  })
  it('restarts a same-file backfill on runId change and rejects the previous response', async () => {
    const old = Promise.withResolvers<{ messages: Array<{ role: string; content: string }> }>()
    const current = Promise.withResolvers<{ messages: Array<{ role: string; content: string }> }>()
    getHistory.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const identity = { id: 'preview-wake', sessionFile: 'C:/wake.jsonl', parentToolCallId: 'same-parent' }
    ompSubagentStore.applyLifecycle('parent', { ...identity, runId: 'old', status: 'completed' })
    const view = render(<SubagentSessionPreview run={ompSubagentStore.runsForSession('parent')[0]} />)
    ompSubagentStore.applyLifecycle('parent', { ...identity, runId: 'new', status: 'started' })
    view.rerender(<SubagentSessionPreview run={ompSubagentStore.runsForSession('parent')[0]} />)
    await act(async () => { old.resolve({ messages: [{ role: 'assistant', content: 'Old response' }] }) })
    expect(ompSubagentStore.runsForSession('parent')[0].transcript).toEqual([])
    await act(async () => { current.resolve({ messages: [{ role: 'assistant', content: 'Current response' }] }) })
    view.rerender(<SubagentSessionPreview run={ompSubagentStore.runsForSession('parent')[0]} />)
    expect(screen.getByText('Current response')).toBeInTheDocument()
    expect(screen.queryByText('Old response')).not.toBeInTheDocument()
  })

  it('retains a history read failure and permits recovery instead of reporting empty success', async () => {
    getHistory.mockRejectedValueOnce(new Error('Child history is unavailable')).mockResolvedValueOnce({ messages: [{ role: 'assistant', content: 'Recovered child reply' }] })
    ompSubagentStore.applyLifecycle('parent', { id: 'recover-preview', runId: 'recover', sessionFile: 'C:/recover.jsonl', status: 'completed' })
    const view = render(<SubagentSessionPreview run={ompSubagentStore.runsForSession('parent')[0]} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Child history is unavailable')
    expect(ompSubagentStore.runsForSession('parent')[0].historyLoaded).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'common:retry' })) })
    view.rerender(<SubagentSessionPreview run={ompSubagentStore.runsForSession('parent')[0]} />)
    expect(screen.getByText('Recovered child reply')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
