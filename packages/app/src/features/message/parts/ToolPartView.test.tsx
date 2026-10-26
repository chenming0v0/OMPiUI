import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolPartView } from './ToolPartView'
import type { PiToolExecution } from '../../../omp/domain/index.js'
import { SessionNavigationContext } from '../../../contexts/SessionNavigationContext'
import { piSessionStateStore } from '../../../omp/state/index.js'
import { serverStore } from '../../../store/serverStore'

const { getActiveCalibratedNowMock } = vi.hoisted(() => ({
  getActiveCalibratedNowMock: vi.fn<() => number | undefined>(() => undefined),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'toolPart.running') return 'Running'
      if (key === 'toolPart.failed') return 'Failed'
      return key
    },
  }),
}))

vi.mock('../../../hooks', () => ({
  useDelayedRender: (show: boolean) => show,
  useDisclosureScrollLock: () => ({
    rootRef: () => undefined,
    headerRef: () => undefined,
    withScrollLock: (action: () => void) => action(),
  }),
  useCompositorExpand: (open: boolean) => ({
    contentRef: { current: null },
    layoutOpen: open,
    keepMounted: open,
    panelClassName: 'transition-[grid-template-rows] duration-300 ease-in-out',
  }),
}))

vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    immersiveMode: false,
  }),
}))


vi.mock('../tools', () => ({
  getToolIcon: () => <span data-testid="tool-icon">icon</span>,
  extractToolData: () => ({}),
  defaultExtractData: () => ({}),
  getToolConfig: () => undefined,
  isYieldTool: (name: string) => name.toLowerCase() === 'yield',
  DefaultRenderer: () => null,
  TodoRenderer: () => null,
  TaskRenderer: () => null,
  hasTodos: () => false,
}))

function createRunningExecution(): PiToolExecution {
  return {
    call: {
      type: 'toolCall',
      id: 'call-1',
      name: 'bash',
      arguments: { command: 'npm run build' },
    },
    startedAt: 7_500,
  }
}

describe('ToolPartView running duration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    getActiveCalibratedNowMock.mockReset()
    getActiveCalibratedNowMock.mockReturnValue(undefined)
    vi.spyOn(serverStore, 'getActiveCalibratedNow').mockImplementation(getActiveCalibratedNowMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('falls back to local wall clock when calibration is unavailable', () => {
    render(<ToolPartView execution={createRunningExecution()} partKey="tool-1" />)

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('2.5s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByText('3.0s')).toBeInTheDocument()
  })

  it('labels orphan arguments as unknown instead of deriving an operation target', () => {
    const execution = { ...createRunningExecution(), argumentsUnknown: true, result: { role: 'toolResult' as const, toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text' as const, text: 'actual output' }], isError: false, timestamp: 10_000 } }
    render(<ToolPartView execution={execution} partKey="unknown-arguments" compact defaultExpanded />)
    expect(screen.getByText('toolPart.argumentsUnknown')).toBeInTheDocument()
    expect(screen.queryByText('npm run build')).not.toBeInTheDocument()
  })

  it.each(['timeline', 'compact', 'descriptive'] as const)('does not keep the running timer after an authoritative tool interruption in the %s layout', layout => {
    const execution = { ...createRunningExecution(), isRunning: false, error: 'Runtime crashed before a result', endedAt: 10_000 }
    const { container } = render(<ToolPartView execution={execution} partKey={`stopped-tool-${layout}`} compact={layout === 'compact'} descriptive={layout === 'descriptive'} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('2.5s')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getByText('2.5s')).toBeInTheDocument()
    expect(container.querySelector('.reasoning-shimmer-text')).toBeNull()
  })

  it.each(['cancelled', 'unknown'] as const)('keeps a no-result %s interruption distinct from success', interruption => {
    const execution = { ...createRunningExecution(), isRunning: false, error: 'The real terminal explanation', interruption, endedAt: 10_000 }
    const { container, rerender } = render(<ToolPartView execution={execution} partKey={`outcome-${interruption}`} descriptive />)
    expect(screen.getByText(`toolPart.${interruption}`)).toHaveAttribute('title', execution.error)
    expect(container.querySelector('.reasoning-shimmer-text')).toBeNull()
    rerender(<ToolPartView execution={{ ...execution, result: { role: 'toolResult', toolCallId: execution.call.id, toolName: execution.call.name, isError: false, timestamp: 10_500, content: [{ type: 'text', text: 'Recovered actual result' }] } }} partKey={`outcome-${interruption}`} descriptive />)
    expect(screen.queryByText(`toolPart.${interruption}`)).not.toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })

  it('uses calibrated server time for running tools when available', () => {
    getActiveCalibratedNowMock.mockReturnValue(11_000)

    render(<ToolPartView execution={createRunningExecution()} partKey="tool-1" />)

    expect(screen.getByText('3.5s')).toBeInTheDocument()
  })

  it('clamps running duration to zero when calibrated time is earlier than start', () => {
    getActiveCalibratedNowMock.mockReturnValue(7_000)

    render(<ToolPartView execution={createRunningExecution()} partKey="tool-1" />)

    expect(screen.getByText('0ms')).toBeInTheDocument()
  })

  it('rounds calibrated sub-second durations before rendering', () => {
    getActiveCalibratedNowMock.mockReturnValue(7_623.456)

    render(<ToolPartView execution={createRunningExecution()} partKey="tool-1" />)

    expect(screen.getByText('123ms')).toBeInTheDocument()
  })
  it.each(['timeline', 'compact', 'descriptive'] as const)('does not time unstarted calls in the %s layout, then starts and settles only that call', layout => {
    const queued = { ...createRunningExecution(), startedAt: undefined }
    const props = { partKey: `queued-${layout}`, compact: layout === 'compact', descriptive: layout === 'descriptive' }
    const { container, rerender } = render(<ToolPartView execution={queued} {...props} />)
    expect(screen.getByText('toolPart.pending')).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
    expect(screen.queryByText('2.5s')).not.toBeInTheDocument()
    expect(container.querySelector('.reasoning-shimmer-text')).toBeNull()
    rerender(<ToolPartView execution={{ ...queued, startedAt: 9_000 }} {...props} />)
    expect(screen.queryByText('toolPart.pending')).not.toBeInTheDocument()
    expect(screen.getByText('1.0s')).toBeInTheDocument()
    const result: NonNullable<PiToolExecution['result']> = {
      role: 'toolResult', toolCallId: queued.call.id, toolName: queued.call.name,
      content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 10_500,
    }
    rerender(<ToolPartView execution={{ ...queued, startedAt: 9_000, isRunning: true, result }} {...props} />)
    expect(screen.getByText('1.5s')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText('1.5s')).toBeInTheDocument()
    expect(container.querySelector('.reasoning-shimmer-text')).toBeNull()
  })

  it('leaves an unstarted task waiting even if the session is idle', () => {
    piSessionStateStore.setState('queued-task-session', { isIdle: true, isStreaming: false })
    render(<SessionNavigationContext.Provider value={{ currentSessionId: 'queued-task-session', navigateToSession: vi.fn(), currentDirectory: undefined }}>
      <ToolPartView execution={{ call: { type: 'toolCall', id: 'queued-task', name: 'task', arguments: {} } }} partKey="queued-task" />
    </SessionNavigationContext.Provider>)
    expect(screen.getByText('toolPart.pending')).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
    expect(screen.getByText('Failed')).toHaveClass('opacity-0')
    piSessionStateStore.clear('queued-task-session')
  })

})
