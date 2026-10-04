/**
 * SubagentHud 行为测试：
 * - 只在有 detached run 时渲染；运行中/终态行分别带 stop / dismiss
 * - 点击行跳父会话；stop 调 abort；dismiss 后行消失
 * - 折叠开关只留头部计数
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentHud } from './SubagentHud'
import { ompSubagentStore } from '../../../omp/ompSubagentStore'

const abortPiOperationMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (
    typeof options?.count === 'number' ? `${key}:${options.count}` : key
  ) }),
}))

vi.mock('../../../omp/controllers/index.js', () => ({
  abortPiOperation: (...args: unknown[]) => abortPiOperationMock(...(args as [string])),
}))

function seedStore() {
  ompSubagentStore.applyLifecycle('session-running', {
    id: 'hud-spec-running', detached: true, status: 'started', agent: 'explore',
    description: 'Search the code', index: 0,
  })
  ompSubagentStore.applyLifecycle('session-done', {
    id: 'hud-spec-done', detached: true, status: 'completed', agent: 'task',
    description: 'Finished work', index: 1,
  })
}

/** store 的 listener 通知合并到下一帧（rAF）；memo 组件不会因同 props rerender 而刷新 */
async function flushStoreNotify() {
  await act(async () => {
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => resolve())
    })
  })
}

describe('SubagentHud', () => {
  beforeEach(() => {
    abortPiOperationMock.mockClear()
    localStorage.clear()
    ompSubagentStore.clearAll()
  })

  it('renders nothing when no detached runs exist', () => {
    const { container } = render(<SubagentHud selectedSessionId={null} onSelectSession={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists running and finished detached agents with their actions', async () => {
    seedStore()
    const onSelect = vi.fn()
    render(<SubagentHud selectedSessionId={null} onSelectSession={onSelect} />)
    await flushStoreNotify()

    expect(screen.getByText('sidebar.subagentHud')).toBeInTheDocument()
    // 运行中行：agent 徽标 + 描述 + stop
    const runningRow = screen.getByText('Search the code').closest('div')!.parentElement!
    expect(within(runningRow).getByText('explore')).toBeInTheDocument()
    expect(within(runningRow).getByRole('button', { name: 'sidebar.subagentHudStop' })).toBeInTheDocument()
    // 终态行：dismiss
    const doneRow = screen.getByText('Finished work').closest('div')!.parentElement!
    expect(within(doneRow).getByRole('button', { name: 'sidebar.subagentHudDismiss' })).toBeInTheDocument()
  })

  it('clicking a row navigates to the parent session; stop aborts it', async () => {
    seedStore()
    const onSelect = vi.fn()
    render(<SubagentHud selectedSessionId={null} onSelectSession={onSelect} />)
    await flushStoreNotify()

    fireEvent.click(screen.getByText('Search the code'))
    expect(onSelect).toHaveBeenCalledWith({ id: 'session-running', directory: undefined })

    fireEvent.click(screen.getByRole('button', { name: 'sidebar.subagentHudStop' }))
    expect(abortPiOperationMock).toHaveBeenCalledWith('session-running')
  })

  it('dismiss removes the finished row; clear-finished empties terminal rows', async () => {
    seedStore()
    const onSelect = vi.fn()
    render(<SubagentHud selectedSessionId={null} onSelectSession={onSelect} />)
    await flushStoreNotify()

    const doneRow = screen.getByText('Finished work').closest('div')!.parentElement!
    fireEvent.click(within(doneRow).getByRole('button', { name: 'sidebar.subagentHudDismiss' }))
    await flushStoreNotify()
    expect(screen.queryByText('Finished work')).not.toBeInTheDocument()

    // 剩余运行中行没有清除入口；再补一个终态后用头部按钮一键清除
    act(() => {
      ompSubagentStore.applyLifecycle('session-again', {
        id: 'hud-spec-again', detached: true, status: 'failed', agent: 'task',
        description: 'Failed work', index: 2,
      })
    })
    await flushStoreNotify()
    expect(screen.getByRole('button', { name: 'sidebar.subagentHudClearFinished:1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.subagentHudClearFinished:1' }))
    await flushStoreNotify()
    expect(screen.queryByText('Failed work')).not.toBeInTheDocument()
    expect(screen.getByText('Search the code')).toBeInTheDocument()
  })

  it('collapses to the header with the running count', async () => {
    seedStore()
    render(<SubagentHud selectedSessionId={null} onSelectSession={vi.fn()} />)
    await flushStoreNotify()

    fireEvent.click(screen.getByRole('button', { name: 'sidebar.subagentHudCollapse' }))
    expect(screen.queryByText('Search the code')).not.toBeInTheDocument()
    expect(screen.getByText('sidebar.subagentHud')).toBeInTheDocument()
    // 头部计数显示运行中数量
    expect(screen.getByText('1')).toBeInTheDocument()
  })
})
