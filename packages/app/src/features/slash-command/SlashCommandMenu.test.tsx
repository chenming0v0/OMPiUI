import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlashCommandMenu } from './SlashCommandMenu'

const mocks = vi.hoisted(() => ({
  loadPiSlashCommands: vi.fn(),
}))

vi.mock('../../omp/controllers/index.js', () => ({
  loadPiSlashCommands: mocks.loadPiSlashCommands,
}))

describe('SlashCommandMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 16),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
    mocks.loadPiSlashCommands.mockClear()
    mocks.loadPiSlashCommands.mockResolvedValue([
      { name: 'explain', description: 'Explain code', sourceInfo: null },
      { name: 'review', description: 'Review changes', sourceInfo: null },
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  it('keeps official commands and their arguments authoritative alongside unique UI actions', async () => {
    mocks.loadPiSlashCommands.mockResolvedValue([
      { name: 'model', description: 'Native model selection', argumentHint: '[selector]', aliases: ['models'], sourceInfo: { source: 'builtin' } },
      { name: 'session', description: 'Native session management', subcommands: [{ name: 'pin', description: 'Pin account', usage: '[account]' }], sourceInfo: { source: 'builtin' } },
    ])
    const onSelect = vi.fn()
    render(<SlashCommandMenu isOpen query="" sessionId="s1" onSelect={onSelect} onClose={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(32); await Promise.resolve() })
    expect(screen.getAllByText('/model')).toHaveLength(1)
    expect(screen.getByText('/ui-model')).toBeInTheDocument()
    fireEvent.click(screen.getByText('/model'))
    expect(onSelect.mock.lastCall?.[0]).toMatchObject({ name: 'model', argumentHint: '[selector]', aliases: ['models'], source: 'builtin' })
    const sessionCommand = screen.getByText('/session')
    expect(sessionCommand.closest('button')?.title).toContain('pin [account]')
    fireEvent.click(sessionCommand)
    expect(onSelect.mock.lastCall?.[0].subcommands).toEqual([{ name: 'pin', description: 'Pin account', usage: '[account]' }])
  })

  it('finds native aliases and inserts the selected spelling', async () => {
    mocks.loadPiSlashCommands.mockResolvedValue([{ name: 'model', aliases: ['models'], sourceInfo: { source: 'builtin' } }])
    const onSelect = vi.fn()
    render(<SlashCommandMenu isOpen query="models" sessionId="s1" onSelect={onSelect} onClose={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(32); await Promise.resolve() })
    fireEvent.click(screen.getByText('/models'))
    expect(onSelect.mock.lastCall?.[0].name).toBe('models')
    expect(screen.queryByText('/ui-model')).not.toBeInTheDocument()
  })

  it('never invents native commands when no runtime registry is available', async () => {
    render(<SlashCommandMenu isOpen query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(32) })
    expect(screen.getByText('/ui-settings')).toBeInTheDocument()
    expect(screen.queryByText('/share')).not.toBeInTheDocument()
    expect(screen.queryByText('/compact')).not.toBeInTheDocument()
    expect(mocks.loadPiSlashCommands).not.toHaveBeenCalled()
  })



  it('merges native extension commands with builtins and filters by query', async () => {
    render(
      <div>
        <SlashCommandMenu isOpen={true} query="expl" sessionId="session-1" onSelect={vi.fn()} onClose={vi.fn()} />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.loadPiSlashCommands).toHaveBeenCalledWith('session-1')
    expect(screen.getByText('/explain')).toBeInTheDocument()
    expect(screen.queryByText('/review')).not.toBeInTheDocument()
    expect(screen.queryByText('/compact')).not.toBeInTheDocument()
    expect(screen.queryByText('/export')).not.toBeInTheDocument()
  })


  it('filters by command name only, not description', async () => {
    mocks.loadPiSlashCommands.mockResolvedValue([
      { name: 'session', description: 'Info and pinning', sourceInfo: { source: 'builtin' } },
      { name: 'resume', description: 'Resume session', sourceInfo: { source: 'builtin' } },
    ])
    render(
      <div>
        <SlashCommandMenu isOpen={true} query="session" sessionId="session-1" onSelect={vi.fn()} onClose={vi.fn()} />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
    })

    // /session 名字精确匹配
    expect(screen.getByText('/session')).toBeInTheDocument()
    // 描述里含 "session" 的 /resume /new /export /import 不应出现
    expect(screen.queryByText('/resume')).not.toBeInTheDocument()
    expect(screen.queryByText('/new')).not.toBeInTheDocument()
    expect(screen.queryByText('/export')).not.toBeInTheDocument()
    expect(screen.queryByText('/import')).not.toBeInTheDocument()
  })
  it('does not restore the previous session commands after changing sessions', async () => {
    const previous = Promise.withResolvers<Array<{ name: string }>>()
    mocks.loadPiSlashCommands.mockReturnValueOnce(previous.promise).mockResolvedValueOnce([{ name: 'current-command' }])
    const view = render(<SlashCommandMenu isOpen query="" sessionId="previous" onSelect={vi.fn()} onClose={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(32) })
    view.rerender(<SlashCommandMenu isOpen query="" sessionId="current" onSelect={vi.fn()} onClose={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(32); await Promise.resolve() })
    await act(async () => { previous.resolve([{ name: 'previous-command' }]) })
    expect(screen.getByText('/current-command')).toBeInTheDocument()
    expect(screen.queryByText('/previous-command')).not.toBeInTheDocument()
  })
})
