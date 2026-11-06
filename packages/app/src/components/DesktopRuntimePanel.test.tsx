import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmpRuntimeCandidate, OmpRuntimeInspection } from '@ompiui/protocol'
import { DesktopRuntimePanel } from './DesktopRuntimePanel'
import { serviceStore } from '../store/serviceStore'
import { desktopDiagnosticsStore, type DesktopServiceDiagnostics } from '../store/desktopDiagnosticsStore'
import { desktopRuntimeStore } from '../store/desktopRuntimeStore'
import i18n from '../i18n'

const mocks = vi.hoisted(() => ({ catalog: vi.fn(), save: vi.fn() }))
vi.mock('../services/desktopService', () => ({
  getDesktopRuntimeCatalog: mocks.catalog,
  saveDesktopRuntimeSelection: mocks.save,
}))

const bundled: OmpRuntimeCandidate = {
  path: 'C:\\OMPiUI\\omp-runtime\\bin\\omp.exe',
  source: 'bundled',
  version: '18.12.6',
  command: 'C:\\OMPiUI\\omp-runtime\\bin\\omp.exe',
  args: [],
  error: null,
  runtimeRoot: 'C:\\OMPiUI\\omp-runtime',
}
const external: OmpRuntimeCandidate = {
  path: 'C:\\Tools\\omp.cmd',
  source: 'path',
  version: '18.13.0',
  command: 'C:\\Tools\\bun.exe',
  args: ['C:\\Tools\\cli.js'],
  error: null,
}
const inspection: OmpRuntimeInspection = {
  selected: bundled,
  candidates: [bundled, external],
  bundled: true,
  error: null,
  configuredBin: null,
  configuredRuntimeDir: null,
}
const running: DesktopServiceDiagnostics = {
  revision: 1,
  phase: 'running',
  requestedAt: 1_791_721_000_000,
  spawnedAt: 1_791_721_001_000,
  completedAt: 1_791_721_002_000,
  pid: 42,
  error: null,
  events: [],
  reachable: true,
  workerReady: true,
  ompVersion: '18.12.6',
  healthError: null,
  output: [],
}
const switched = { available: { ...inspection, selected: external, configuredBin: external.path }, current: inspection }

// 检测与保存都是 Promise 链，等一个宏任务让整条链跑完再断言。
function flush() {
  return act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function show(onRestart?: () => Promise<void>) {
  render(<DesktopRuntimePanel onRestart={onRestart} />)
  await flush()
}

function inUseCard() {
  return screen.getByRole('region', { name: '正在使用的运行时' })
}

describe('desktop runtime panel', () => {
  beforeEach(async () => {
    desktopRuntimeStore.reset()
    serviceStore.setEnvVars([])
    serviceStore.setStartedByUs(true)
    serviceStore.setStarting(false)
    desktopDiagnosticsStore.finish()
    desktopDiagnosticsStore.receive(running)
    mocks.catalog.mockReset().mockResolvedValue({ available: inspection, current: inspection, currentError: null })
    mocks.save.mockReset().mockImplementation(async (path: string | null) => {
      serviceStore.setEnvVars(path ? [{ key: 'OMPI_OMP_BIN', value: path }] : [])
      return path === external.path ? switched : null
    })
    await i18n.changeLanguage('zh-CN')
  })
  afterEach(cleanup)

  it('shows the runtime in use with its kind and path and lists every installation without writing', async () => {
    await show()
    expect(within(inUseCard()).getByText('OMP 18.12.6')).toBeInTheDocument()
    expect(within(inUseCard()).getByText('应用内置')).toBeInTheDocument()
    expect(within(inUseCard()).getByText(bundled.path)).toBeInTheDocument()
    const options = within(screen.getByRole('radiogroup', { name: '选择运行时' })).getAllByRole('radio')
    expect(options).toHaveLength(4)
    expect(options[0]).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(external.path)).toBeInTheDocument()
    expect(screen.queryByText(external.command)).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('reuses the cached detection when reopened for the same backend and environment', async () => {
    await show()
    cleanup()
    await show()
    expect(mocks.catalog).toHaveBeenCalledTimes(1)
    expect(within(inUseCard()).getByText('OMP 18.12.6')).toBeInTheDocument()
  })

  it('warns only when a ready worker reports no OMP', async () => {
    desktopDiagnosticsStore.receive({ ...running, ompVersion: null })
    mocks.catalog.mockResolvedValue({
      available: { ...inspection, selected: null, candidates: [], bundled: false, error: 'OMP executable not found' },
      current: null,
    })
    await show()
    expect(within(inUseCard()).getByText('OMP 不可用')).toBeInTheDocument()
    expect(screen.getByText(/没有可用的 OMP/)).toBeInTheDocument()
    expect(screen.getByText(/此安装未附带 OMP 运行时/)).toBeInTheDocument()
  })

  it('shows the switch target instead of a warning while the backend restarts', async () => {
    await show()
    act(() => desktopDiagnosticsStore.begin('preparing'))
    expect(within(inUseCard()).getByText('正在启动后端')).toBeInTheDocument()
    expect(within(inUseCard()).getByText('将使用 OMP 18.12.6 · 应用内置')).toBeInTheDocument()
    expect(screen.queryByText('OMP 不可用')).toBeNull()
    expect(mocks.catalog).toHaveBeenCalledTimes(1)
  })

  it('describes the next start when the backend is stopped', async () => {
    desktopDiagnosticsStore.receive({ ...running, phase: 'stopped', reachable: false, ompVersion: null })
    await show()
    expect(within(inUseCard()).getByText('后端未运行')).toBeInTheDocument()
    expect(within(inUseCard()).getByText('下次启动将使用 OMP 18.12.6 · 应用内置')).toBeInTheDocument()
  })

  it('switches with one action: saves the selection and restarts an owned backend', async () => {
    const restart = vi.fn().mockResolvedValue(undefined)
    await show(restart)
    fireEvent.click(screen.getByRole('radio', { name: /OMP 18\.13\.0/ }))
    expect(screen.getByText('切换到 OMP 18.13.0 · 独立安装')).toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '切换并重启后端' }))
    await flush()
    expect(mocks.save).toHaveBeenCalledWith(external.path, undefined)
    expect(restart).toHaveBeenCalledTimes(1)
    // 保存时的校验结果直接复用，不重复检测。
    expect(mocks.catalog).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('radio', { name: /OMP 18\.13\.0/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('saves without restarting a backend the app does not own and shows what is still in use', async () => {
    serviceStore.setStartedByUs(false)
    const restart = vi.fn()
    await show(restart)
    fireEvent.click(screen.getByRole('radio', { name: /OMP 18\.13\.0/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await flush()
    expect(restart).not.toHaveBeenCalled()
    expect(
      screen.getByText('已选择 OMP 18.13.0 · 独立安装，但后端仍在使用 OMP 18.12.6 · 应用内置。'),
    ).toBeInTheDocument()
    expect(within(inUseCard()).getByText('OMP 18.12.6')).toBeInTheDocument()
  })

  it('matches a saved path regardless of Windows case and separators', async () => {
    serviceStore.setEnvVars([{ key: 'OMPI_OMP_BIN', value: 'c:/tools/OMP.cmd' }])
    await show()
    expect(screen.getByRole('radio', { name: /OMP 18\.13\.0/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/切换到/)).toBeNull()
  })

  it('keeps the active runtime and reports a failed save', async () => {
    mocks.save.mockRejectedValue(new Error('Cannot verify OMP executable'))
    await show(vi.fn())
    fireEvent.click(screen.getByRole('radio', { name: /指定路径/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'OMP 可执行文件路径' }), {
      target: { value: 'C:\\Missing\\omp.exe' },
    })
    fireEvent.click(screen.getByRole('button', { name: '切换并重启后端' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot verify OMP executable')
    expect(within(inUseCard()).getByText('OMP 18.12.6')).toBeInTheDocument()
  })

  it('falls back to the worker-reported version when the backend cannot report its runtime', async () => {
    mocks.catalog.mockResolvedValue({
      available: inspection,
      current: null,
      currentError: 'Backend does not provide runtime information',
    })
    await show()
    expect(within(inUseCard()).getByText('OMP 18.12.6')).toBeInTheDocument()
    expect(within(inUseCard()).getByText('后端未返回运行时路径。')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Backend does not provide runtime information')
  })
})
