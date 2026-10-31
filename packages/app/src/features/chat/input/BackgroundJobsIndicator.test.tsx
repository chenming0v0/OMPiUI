import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { BackgroundJobsIndicator, SessionBackgroundJobs } from './BackgroundJobsIndicator'
import { formatElapsed } from './formatElapsed'
import { BACKGROUND_JOB_POLL_MS, parseAsyncJobSnapshot } from '../../../omp/backgroundJobs'

const { getJobs, inspectJob, cancelJob, state, capabilities } = vi.hoisted(() => ({
  getJobs: vi.fn(), inspectJob: vi.fn(), cancelJob: vi.fn(),
  state: { value: { isStreaming: true } as Record<string, unknown> | null },
  capabilities: { backgroundJobs: true, backgroundJobCancel: true },
}))

const translate = (key: string, values?: Record<string, unknown>) => {
  if (!values) return key
  return `${key}:${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(',')}`
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
vi.mock('../../../omp/transport/index.js', () => ({ getPiAsyncJobs: getJobs, inspectPiAsyncJob: inspectJob, cancelPiAsyncJob: cancelJob }))
vi.mock('../../../omp/state/index.js', () => ({ piSessionStateStore: { subscribe: () => () => {}, getState: () => state.value } }))
vi.mock('../../../omp/capabilities', () => ({ usePiCapabilities: () => capabilities }))

const now = Date.now()
const bash = { id: 'bg_1', type: 'bash', status: 'running', label: 'node prototypes/serve.js', startTime: now - 740_000 }
const task = { id: 'bg_2', type: 'task', status: 'running', label: 'explore', startTime: now - 5_000 }

describe('formatElapsed', () => {
  const t = translate as unknown as TFunction
  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(9_400, t)).toBe('backgroundJobs.elapsedSeconds:seconds=9')
    expect(formatElapsed(740_000, t)).toBe('backgroundJobs.elapsedMinutes:minutes=12,seconds=20')
    expect(formatElapsed(3_723_000, t)).toBe('backgroundJobs.elapsedHours:hours=1,minutes=2,seconds=3')
    expect(formatElapsed(-50, t)).toBe('backgroundJobs.elapsedSeconds:seconds=0')
  })
})

describe('parseAsyncJobSnapshot', () => {
  it('keeps only running jobs in running and drops malformed entries', () => {
    const parsed = parseAsyncJobSnapshot({ running: [bash, { ...task, status: 'completed' }, { id: 1 }], recent: [{ ...task, status: 'completed', endTime: now }] })
    expect(parsed.running.map(job => job.id)).toEqual(['bg_1'])
    expect(parsed.recent.map(job => job.id)).toEqual(['bg_2'])
    expect(parseAsyncJobSnapshot(null)).toEqual({ running: [], recent: [] })
  })
})

describe('BackgroundJobsIndicator', () => {
  it('renders nothing without running jobs', () => {
    const { container } = render(<BackgroundJobsIndicator running={[]} recent={[{ ...task, status: 'completed' }]} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the count and opens the in-progress panel', () => {
    render(<BackgroundJobsIndicator running={[bash, task]} />)
    const toggle = screen.getByRole('button', { name: 'backgroundJobs.runningCount:count=2' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('dialog', { name: 'backgroundJobs.panelTitle' })).toBeInTheDocument()
    expect(screen.getAllByTestId('background-job-row')).toHaveLength(2)
    expect(screen.getByText('node prototypes/serve.js')).toBeInTheDocument()
    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText(/backgroundJobs\.elapsedMinutes:minutes=12/)).toBeInTheDocument()
  })

  it('omits the stop button when no cancel interface is provided', () => {
    render(<BackgroundJobsIndicator running={[bash]} />)
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.runningCount:count=1' }))
    expect(screen.queryByRole('button', { name: 'backgroundJobs.stop' })).toBeNull()
  })

  it('shows a visible error when stopping fails', async () => {
    const onCancel = vi.fn().mockRejectedValue(new Error('boom'))
    render(<BackgroundJobsIndicator running={[bash]} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.runningCount:count=1' }))
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.stop' }))
    expect(onCancel).toHaveBeenCalledWith('bg_1')
    expect(await screen.findByRole('alert')).toHaveTextContent('backgroundJobs.stopFailed:message=boom')
  })

  it('loads job output when a row is expanded', async () => {
    const onInspect = vi.fn().mockResolvedValue({ command: 'node prototypes/serve.js', output: 'listening' })
    render(<BackgroundJobsIndicator running={[bash]} onInspect={onInspect} />)
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.runningCount:count=1' }))
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.details' }))
    expect(await screen.findByText('listening')).toBeInTheDocument()
    expect(onInspect).toHaveBeenCalledWith('bg_1')
  })

  it('stays open on outside clicks and folds back only via its collapse button', () => {
    render(<BackgroundJobsIndicator running={[bash]} />)
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.runningCount:count=1' }))
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('dialog', { name: 'backgroundJobs.panelTitle' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.collapse' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'backgroundJobs.runningCount:count=1' })).toBeInTheDocument()
  })

  it('maximizes to show uncapped output and re-reads output on refresh', async () => {
    const onInspect = vi.fn()
      .mockResolvedValueOnce({ command: 'sleep 600', output: 'first' })
      .mockResolvedValueOnce({ command: 'sleep 600', output: 'second' })
    render(<BackgroundJobsIndicator running={[bash]} onInspect={onInspect} />)
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.runningCount:count=1' }))
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.maximize' }))
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.details' }))
    expect((await screen.findByText('first')).className).not.toContain('max-h-48')
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.refreshOutput' }))
    expect(await screen.findByText('second')).toBeInTheDocument()
    expect(onInspect).toHaveBeenCalledTimes(2)
  })
})

describe('SessionBackgroundJobs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.clearAllMocks()
    state.value = { isStreaming: true }
    capabilities.backgroundJobs = true
    capabilities.backgroundJobCancel = true
  })
  afterEach(() => vi.useRealTimers())

  it('never queries a disk preview or read-only session', () => {
    state.value = { diskPreview: true }
    const { container, rerender } = render(<SessionBackgroundJobs sessionId="s" />)
    state.value = { readOnly: true }
    rerender(<SessionBackgroundJobs sessionId="other" />)
    expect(getJobs).not.toHaveBeenCalled()
    expect(container.firstChild).toBeNull()
  })

  it('does not query when the backend lacks the asyncJobs command', () => {
    capabilities.backgroundJobs = false
    render(<SessionBackgroundJobs sessionId="s" />)
    expect(getJobs).not.toHaveBeenCalled()
  })

  it('polls while jobs run, hides and stops when they finish', async () => {
    getJobs.mockResolvedValueOnce({ running: [bash], recent: [] }).mockResolvedValueOnce({ running: [], recent: [{ ...bash, status: 'completed', endTime: now }] })
    render(<SessionBackgroundJobs sessionId="s" />)
    expect(await screen.findByRole('button', { name: 'backgroundJobs.runningCount:count=1' })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_JOB_POLL_MS) })
    await waitFor(() => expect(screen.queryByRole('button', { name: /backgroundJobs\.runningCount/ })).toBeNull())
    expect(getJobs).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_JOB_POLL_MS * 3) })
    expect(getJobs).toHaveBeenCalledTimes(2)
  })

  it('hides without polling when the runtime is not open', async () => {
    getJobs.mockRejectedValue(Object.assign(new Error('closed'), { code: 'RUNTIME_NOT_OPEN' }))
    const { container } = render(<SessionBackgroundJobs sessionId="s" />)
    await waitFor(() => expect(getJobs).toHaveBeenCalledTimes(1))
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_JOB_POLL_MS * 2) })
    expect(getJobs).toHaveBeenCalledTimes(1)
    expect(container.firstChild).toBeNull()
  })

  it('hides the stop button when the backend lacks asyncJobs.cancel', async () => {
    capabilities.backgroundJobCancel = false
    getJobs.mockResolvedValue({ running: [bash], recent: [] })
    render(<SessionBackgroundJobs sessionId="s" />)
    fireEvent.click(await screen.findByRole('button', { name: 'backgroundJobs.runningCount:count=1' }))
    expect(screen.queryByRole('button', { name: 'backgroundJobs.stop' })).toBeNull()
  })

  it('surfaces an error when the backend reports the job was not cancelled', async () => {
    getJobs.mockResolvedValue({ running: [bash], recent: [] })
    cancelJob.mockResolvedValue({ cancelled: false })
    render(<SessionBackgroundJobs sessionId="s" />)
    fireEvent.click(await screen.findByRole('button', { name: 'backgroundJobs.runningCount:count=1' }))
    fireEvent.click(screen.getByRole('button', { name: 'backgroundJobs.stop' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('backgroundJobs.notCancelled')
    expect(cancelJob).toHaveBeenCalledWith('s', 'bg_1')
  })
})
