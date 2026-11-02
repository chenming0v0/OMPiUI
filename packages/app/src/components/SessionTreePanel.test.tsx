import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolDescriptor } from '@ompiui/protocol'
import { serverStore } from '../store/serverStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTreePanel } from './SessionTreePanel'

const fixtures = vi.hoisted(() => ({
  state: { diskPreview: true, isIdle: true, activeTools: [], queue: { steering: [], followUp: [], steeringMode: null, followUpMode: null } } as Record<string, unknown> | null,
  capabilities: { queueManage: true, interruptModeManage: true, toolsManage: true, compactionManage: true, retryManage: true, sessionControlsRead: true, sessionInitialize: true },
  controls: vi.fn(), initialize: vi.fn(), tools: vi.fn(), refresh: vi.fn(), interrupt: vi.fn(),
}))
vi.mock('../omp/hooks/index.js', () => ({ usePiSessionRuntimeState: () => fixtures.state }))
vi.mock('../omp/capabilities', () => ({ usePiCapabilities: () => fixtures.capabilities }))
vi.mock('../omp/transport/index.js', () => ({ getPiSessionControls: (...args: unknown[]) => fixtures.controls(...args), initializePiSession: (...args: unknown[]) => fixtures.initialize(...args), getPiTree: vi.fn().mockResolvedValue([]) }))
vi.mock('../omp/controllers/index.js', () => ({ loadPiSessionTools: (...args: unknown[]) => fixtures.tools(...args), refreshPiSessionState: (...args: unknown[]) => fixtures.refresh(...args), setPiInterruptMode: (...args: unknown[]) => fixtures.interrupt(...args) }))
vi.mock('./SessionTreeCanvas', () => ({ SessionTreeCanvas: () => null }))
vi.mock('../features/message/MessageRenderer', () => ({ MessageRenderer: () => null }))
vi.mock('../hooks/useVerticalSplitResize', () => ({ useVerticalSplitResize: () => ({ splitHeight: 240, isResizing: false, handleResizeStart: vi.fn(), handleTouchResizeStart: vi.fn(), adjustSplitHeight: vi.fn(), resetSplitHeight: vi.fn() }) }))

describe('cold session controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fixtures.capabilities = { queueManage: true, interruptModeManage: true, toolsManage: true, compactionManage: true, retryManage: true, sessionControlsRead: true, sessionInitialize: true }
    fixtures.state = { diskPreview: true, isIdle: true, activeTools: [], queue: { steering: [], followUp: [], steeringMode: null, followUpMode: null } }
    fixtures.controls.mockResolvedValue({ source: 'configuration', interruptMode: 'wait', compaction: { autoEnabled: true }, retry: { autoEnabled: false } })
    fixtures.initialize.mockResolvedValue({ isStreaming: false })
    fixtures.refresh.mockResolvedValue(undefined)
    fixtures.interrupt.mockResolvedValue(undefined)
    fixtures.tools.mockResolvedValue([{ name: 'read' }])
  })

  it('reads configuration without initializing and does not present unavailable tools as 0/0', async () => {
    render(<SessionTreePanel sessionId="cold" mode="controls" />)
    expect(await screen.findByRole('button', { name: /Interrupt behavior|中断行为/ })).toHaveTextContent(/Wait|等待完成/)
    expect(screen.queryByText(/0\/0/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Steering$|^本轮追加$/ })).toHaveTextContent(/Not started|尚未启动/)
    expect(fixtures.initialize).not.toHaveBeenCalled()
    expect(fixtures.tools).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Initialize session|初始化会话/ }))
    await waitFor(() => expect(fixtures.initialize).toHaveBeenCalledWith('cold'))
    expect(fixtures.refresh).toHaveBeenCalledWith('cold')
  })

  it('waits for state before requesting live tools', async () => {
    fixtures.state = null
    const view = render(<SessionTreePanel sessionId="cold" mode="controls" />)
    expect(fixtures.controls).not.toHaveBeenCalled()
    expect(fixtures.tools).not.toHaveBeenCalled()
    fixtures.state = { diskPreview: true, isIdle: true, queue: {} }
    view.rerender(<SessionTreePanel sessionId="cold" mode="controls" onNavigateSession={vi.fn()} />)
    await waitFor(() => expect(fixtures.controls).toHaveBeenCalled())
    expect(fixtures.tools).not.toHaveBeenCalled()
    expect(fixtures.initialize).not.toHaveBeenCalled()
  })

  it('does not send unsupported commands and recovers when capabilities arrive', async () => {
    fixtures.capabilities.sessionControlsRead = false
    fixtures.capabilities.sessionInitialize = false
    const view = render(<SessionTreePanel sessionId="cold" mode="controls" />)
    expect(screen.getByRole('status')).toHaveTextContent(/matching newer backend|配套的新版后端/)
    expect(screen.getByRole('button', { name: /Initialize session|初始化会话/ })).toBeDisabled()
    expect(fixtures.controls).not.toHaveBeenCalled()
    expect(fixtures.initialize).not.toHaveBeenCalled()
    fixtures.capabilities = { ...fixtures.capabilities, sessionControlsRead: true, sessionInitialize: true }
    view.rerender(<SessionTreePanel sessionId="cold" mode="controls" onNavigateSession={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Interrupt behavior|中断行为/ })).toHaveTextContent(/Wait|等待完成/))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('retries a failed configuration query without initializing', async () => {
    fixtures.controls.mockRejectedValueOnce(new Error('Configuration read failed'))
    render(<SessionTreePanel sessionId="cold" mode="controls" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Configuration read failed')
    fireEvent.click(screen.getByRole('button', { name: /Reload configuration|重新读取配置/ }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Interrupt behavior|中断行为/ })).toHaveTextContent(/Wait|等待完成/)
    expect(fixtures.controls).toHaveBeenCalledTimes(2)
    expect(fixtures.initialize).not.toHaveBeenCalled()
  })

  it('shows native tools after the session becomes live', async () => {
    fixtures.state = { isIdle: true, activeTools: ['read'], queue: { steeringMode: 'all', followUpMode: 'all' } }
    render(<SessionTreePanel sessionId="live" mode="controls" />)
    expect(await screen.findByText('read')).toBeInTheDocument()
    expect(screen.getByText(/1\/1/)).toBeInTheDocument()
    expect(fixtures.controls).not.toHaveBeenCalled()
    expect(fixtures.initialize).not.toHaveBeenCalled()
  })

  it('preserves a live registry failure instead of showing an empty tools count', async () => {
    fixtures.state = { isIdle: true, activeTools: [], queue: {} }
    fixtures.tools.mockRejectedValue(new Error('Runtime resources unavailable'))
    render(<SessionTreePanel sessionId="live" mode="controls" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime resources unavailable')
    expect(screen.queryByText(/0\/0/)).not.toBeInTheDocument()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps tool rows mounted through polling, streaming, queue and active-tool changes', async () => {
    fixtures.state = { isIdle: true, activeTools: ['read'], queue: {} }
    const view = render(<SessionTreePanel sessionId="live" mode="controls" />)
    const row = await screen.findByText('read')
    for (const patch of [
      { head: { revision: 2 } }, { isIdle: false, isStreaming: true },
      { queue: { steering: ['next'] } }, { activeTools: [] },
      { isIdle: true, isStreaming: false },
    ]) {
      fixtures.state = { ...fixtures.state, ...patch }
      view.rerender(<SessionTreePanel sessionId="live" mode="controls" onNavigateSession={vi.fn()} />)
      expect(screen.getByText('read')).toBe(row)
      expect(row).toBeInTheDocument()
    }
    expect(screen.getByText(/0\/1/)).toBeInTheDocument()
    expect(fixtures.tools).toHaveBeenCalledTimes(1)
  })

  it('debounces registry notifications and keeps rows while a refresh is pending', async () => {
    fixtures.state = { isIdle: true, activeTools: ['read'], queue: {} }
    render(<SessionTreePanel sessionId="live" mode="controls" />)
    const row = await screen.findByText('read')
    const pending = Promise.withResolvers<ToolDescriptor[]>()
    fixtures.tools.mockReturnValueOnce(pending.promise)
    vi.useFakeTimers()
    const updated = (sessionId: string) => window.dispatchEvent(new CustomEvent('ompiui:registry-updated', { detail: { sessionId } }))
    await act(async () => { updated('other'); await vi.advanceTimersByTimeAsync(250) })
    expect(fixtures.tools).toHaveBeenCalledTimes(1)
    await act(async () => {
      updated('live')
      await vi.advanceTimersByTimeAsync(150)
      updated('live')
      await vi.advanceTimersByTimeAsync(150)
      updated('live')
      await vi.advanceTimersByTimeAsync(199)
    })
    expect(fixtures.tools).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(fixtures.tools).toHaveBeenCalledTimes(2)
    expect(screen.getByText('read')).toBe(row)
    expect(screen.getByText(/1\/1/)).toBeInTheDocument()
    await act(async () => { pending.resolve([{ name: 'read' }, { name: 'bash' }]) })
    expect(screen.getByText('read')).toBe(row)
    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText(/1\/2/)).toBeInTheDocument()
  })

  it('preserves the last roster on refresh failure and recovers on the next registry update', async () => {
    fixtures.state = { isIdle: true, activeTools: ['read'], queue: {} }
    render(<SessionTreePanel sessionId="live" mode="controls" />)
    const row = await screen.findByText('read')
    fixtures.tools.mockRejectedValueOnce(new Error('Registry temporarily unavailable'))
    vi.useFakeTimers()
    const updated = () => window.dispatchEvent(new CustomEvent('ompiui:registry-updated', { detail: { sessionId: 'live' } }))
    await act(async () => { updated(); await vi.advanceTimersByTimeAsync(200) })
    expect(screen.getByRole('alert')).toHaveTextContent('Registry temporarily unavailable')
    expect(screen.getByText('read')).toBe(row)
    expect(screen.getByText(/1\/1/)).toBeInTheDocument()
    await act(async () => { updated(); await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('read')).toBe(row)
  })

  it('cancels stale loads and debounce timers when switching sessions', async () => {
    fixtures.state = { isIdle: true, activeTools: ['read'], queue: {} }
    const pending = Promise.withResolvers<ToolDescriptor[]>()
    fixtures.tools.mockReturnValueOnce(pending.promise)
    const view = render(<SessionTreePanel sessionId="first" mode="controls" />)
    const signal = fixtures.tools.mock.calls[0][1] as AbortSignal
    vi.useFakeTimers()
    act(() => { window.dispatchEvent(new CustomEvent('ompiui:registry-updated', { detail: { sessionId: 'first' } })) })
    fixtures.tools.mockResolvedValueOnce([{ name: 'bash' }])
    await act(async () => { view.rerender(<SessionTreePanel sessionId="second" mode="controls" />) })
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve([{ name: 'old-tool' }]); await vi.advanceTimersByTimeAsync(300) })
    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.queryByText('old-tool')).not.toBeInTheDocument()
    expect(fixtures.tools).toHaveBeenCalledTimes(2)
  })

  it('does not expose the previous server roster while the new server is loading', async () => {
    let generation = 100
    vi.spyOn(serverStore, 'getActiveServerGeneration').mockImplementation(() => generation)
    fixtures.state = { isIdle: true, activeTools: ['read'], queue: {} }
    const view = render(<SessionTreePanel sessionId="live" mode="controls" />)
    await screen.findByText('read')
    const pending = Promise.withResolvers<ToolDescriptor[]>()
    fixtures.tools.mockReturnValueOnce(pending.promise)
    generation++
    view.rerender(<SessionTreePanel sessionId="live" mode="controls" onNavigateSession={vi.fn()} />)
    expect(screen.queryByText('read')).not.toBeInTheDocument()
    await act(async () => { pending.resolve([{ name: 'new-server-tool' }]) })
    expect(screen.getByText('new-server-tool')).toBeInTheDocument()
  })

  it('clears the live roster in disk preview and reloads it only on explicit runtime availability', async () => {
    fixtures.state = { isIdle: true, activeTools: ['read'], queue: {} }
    const view = render(<SessionTreePanel sessionId="live" mode="controls" />)
    await screen.findByText('read')
    fixtures.state = { ...fixtures.state, diskPreview: true }
    view.rerender(<SessionTreePanel sessionId="live" mode="controls" onNavigateSession={vi.fn()} />)
    await waitFor(() => expect(fixtures.controls).toHaveBeenCalled())
    expect(screen.queryByText('read')).not.toBeInTheDocument()
    expect(fixtures.tools).toHaveBeenCalledTimes(1)
    expect(fixtures.initialize).not.toHaveBeenCalled()
    fixtures.state = { ...fixtures.state, diskPreview: false }
    view.rerender(<SessionTreePanel sessionId="live" mode="controls" onNavigateSession={vi.fn()} />)
    expect(await screen.findByText('read')).toBeInTheDocument()
    expect(fixtures.tools).toHaveBeenCalledTimes(2)
  })

  it('preserves configuration read errors', async () => {
    fixtures.controls.mockRejectedValue(new Error('OMP_SOURCE_MISSING'))
    render(<SessionTreePanel sessionId="cold" mode="controls" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('OMP_SOURCE_MISSING')
    expect(fixtures.initialize).not.toHaveBeenCalled()
  })
})
