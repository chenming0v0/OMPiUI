import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('preserves configuration read errors', async () => {
    fixtures.controls.mockRejectedValue(new Error('OMP_SOURCE_MISSING'))
    render(<SessionTreePanel sessionId="cold" mode="controls" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('OMP_SOURCE_MISSING')
    expect(fixtures.initialize).not.toHaveBeenCalled()
  })
})
