import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopServiceStatus } from './DesktopServiceStatus'
import { desktopDiagnosticsStore, type DesktopServiceDiagnostics } from '../store/desktopDiagnosticsStore'
import i18n from '../i18n'

const mocks = vi.hoisted(() => ({ desktop: true, mobile: false, read: vi.fn() }))
vi.mock('../utils/tauri', () => ({ isTauri: () => mocks.desktop, isTauriMobile: () => mocks.mobile }))
vi.mock('../services/desktopService', () => ({ readDesktopServiceDiagnostics: mocks.read }))

const native: DesktopServiceDiagnostics = {
  revision: 1,
  phase: 'checking',
  requestedAt: 1_791_721_000_000,
  spawnedAt: null,
  completedAt: null,
  pid: null,
  error: null,
  events: [{ time: 1_791_721_000_000, phase: 'checking' }],
  reachable: null,
  workerReady: null,
  healthError: null,
  output: [],
}

describe('desktop backend indicator', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(native.requestedAt! + 70_000)
    mocks.desktop = true
    mocks.mobile = false
    mocks.read.mockReset().mockResolvedValue(native)
    desktopDiagnosticsStore.finish()
    desktopDiagnosticsStore.receive(native)
    await i18n.changeLanguage('zh-CN')
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each(['browser', 'mobile'])('does not render or query native service on %s', async platform => {
    mocks.desktop = platform !== 'browser'
    mocks.mobile = platform === 'mobile'
    render(<DesktopServiceStatus />)
    await act(async () => {})
    expect(screen.queryByRole('button')).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('shows the waiting phase, elapsed time and timeline before a backend exists', async () => {
    render(<DesktopServiceStatus />)
    await act(async () => {})
    expect(screen.getByRole('button', { name: /检查已有服务/ })).toHaveTextContent('70 秒')
    fireEvent.click(screen.getByRole('button'))
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole('dialog', { name: '本地后端' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /检查已有服务/ })).toHaveTextContent('71 秒')
    expect(screen.getByText('本次启动记录')).toBeInTheDocument()
    expect(screen.getByText('暂无后端输出。进程尚未创建时，请查看上面的启动阶段。')).toBeInTheDocument()
  })

  it('distinguishes a reachable backend from an OMP worker that is still warming', async () => {
    const running = {
      ...native,
      revision: 4,
      phase: 'running' as const,
      reachable: true,
      workerReady: false,
      spawnedAt: native.requestedAt! + 72_000,
      completedAt: native.requestedAt! + 73_000,
      pid: 42,
    }
    mocks.read.mockResolvedValue(running)
    render(<DesktopServiceStatus />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /运行中/ }))
    expect(screen.getByText('初始化中')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    mocks.read.mockResolvedValue({ ...running, workerReady: true })
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByText('已就绪')).toBeInTheDocument()
    expect(screen.queryByText('初始化中')).toBeNull()
  })

  it('shows a launch invocation failure even when native diagnostics cannot be read', async () => {
    mocks.read.mockRejectedValue(new Error('IPC unavailable'))
    desktopDiagnosticsStore.finish('failed to start OMPiUI server')
    render(<DesktopServiceStatus />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /操作失败/ }))
    expect(screen.getByText('failed to start OMPiUI server')).toBeInTheDocument()
    expect(screen.getByText('暂时无法读取桌面服务状态，正在重试。')).toBeInTheDocument()
  })

  it('replaces an old local error when another window successfully starts a new attempt', async () => {
    desktopDiagnosticsStore.finish('previous launch failed')
    mocks.read.mockResolvedValue({
      ...native,
      requestedAt: Date.now() + 1,
      phase: 'running',
      reachable: true,
      workerReady: true,
    })
    render(<DesktopServiceStatus />)
    await act(async () => {})
    expect(screen.getByRole('button', { name: /运行中/ })).toBeInTheDocument()
    expect(desktopDiagnosticsStore.getSnapshot().commandError).toBeNull()
  })
})
