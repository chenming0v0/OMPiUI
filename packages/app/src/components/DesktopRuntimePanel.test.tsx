import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmpRuntimeCandidate, OmpRuntimeInspection } from '@ompiui/protocol'
import { DesktopRuntimePanel } from './DesktopRuntimePanel'
import { serviceStore } from '../store/serviceStore'
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

async function show(backendRunning = true, onApply = vi.fn()) {
  render(<DesktopRuntimePanel backendRunning={backendRunning} onApply={onApply} />)
  await act(async () => {})
  return onApply
}

describe('desktop runtime panel', () => {
  beforeEach(async () => {
    serviceStore.setEnvVars([])
    mocks.catalog.mockReset().mockResolvedValue({ available: inspection, current: inspection, currentError: null })
    mocks.save.mockReset().mockResolvedValue(undefined)
    await i18n.changeLanguage('zh-CN')
  })
  afterEach(cleanup)

  it('shows actual runtime version, source, executable and all detected installations without writing', async () => {
    await show()
    expect(screen.getByText('当前后端使用')).toBeInTheDocument()
    expect(screen.getByText('OMP v18.12.6')).toBeInTheDocument()
    expect(screen.getByText('已附带内置 OMP 运行时。')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: '已检测到' })
    expect(within(list).getAllByRole('button')).toHaveLength(2)
    expect(within(list).getByText(external.path)).toBeInTheDocument()
    expect(screen.queryByText(external.command)).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not call a healthy backend an available runtime when no OMP was found', async () => {
    const missing = { ...inspection, selected: null, candidates: [], bundled: false, error: 'OMP executable not found' }
    mocks.catalog.mockResolvedValue({ available: missing, current: missing, currentError: null })
    await show()
    expect(screen.getByText('未检测到运行时')).toBeInTheDocument()
    expect(screen.getByText('此安装未附带 OMP 运行时。')).toBeInTheDocument()
    expect(screen.getByText(/后端已启动不代表可以执行任务/)).toBeInTheDocument()
    expect(screen.queryByText('OMP executable not found')).toBeNull()
    expect(screen.queryByText('已就绪')).toBeNull()
  })

  it('labels discovery as the next startup choice when the backend is stopped', async () => {
    mocks.catalog.mockResolvedValue({ available: inspection, current: null })
    await show(false)
    expect(screen.getByText('下次启动使用')).toBeInTheDocument()
    expect(screen.queryByText('当前后端使用')).toBeNull()
    expect(screen.getByText('OMP v18.12.6')).toBeInTheDocument()
  })

  it('saves a candidate without relabeling the active runtime or automatically restarting', async () => {
    const apply = await show()
    fireEvent.change(screen.getByRole('combobox', { name: '快捷选择运行时' }), { target: { value: external.path } })
    expect(mocks.save).not.toHaveBeenCalled()
    mocks.catalog.mockResolvedValue({
      available: { ...inspection, selected: external, configuredBin: external.path },
      current: inspection,
    })
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await act(async () => {})
    expect(mocks.save).toHaveBeenCalledWith(external.path, undefined)
    expect(screen.getByText('OMP v18.12.6')).toBeInTheDocument()
    expect(screen.getByText('已保存的选择尚未应用到当前后端。')).toBeInTheDocument()
    expect(apply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '应用并重启后端' }))
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('retains the active runtime and reports a failed save', async () => {
    mocks.save.mockRejectedValue(new Error('Cannot verify OMP executable'))
    await show()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: ':custom:' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'OMP 可执行文件路径' }), {
      target: { value: 'C:\\Missing\\omp.exe' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await act(async () => {})
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot verify OMP executable')
    expect(screen.getByText('OMP v18.12.6')).toBeInTheDocument()
    expect(screen.queryByText('选择已保存，下次启动或重启后端时生效。')).toBeNull()
  })

  it('does not present future configuration as current when the backend query fails', async () => {
    mocks.catalog.mockResolvedValue({
      available: inspection,
      current: null,
      currentError: 'Backend does not provide runtime information',
    })
    await show()
    expect(screen.getByText('无法确认运行时')).toBeInTheDocument()
    expect(screen.queryByText('OMP v18.12.6')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Backend does not provide runtime information')
  })
})
