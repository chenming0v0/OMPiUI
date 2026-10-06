import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FullscreenProvider } from '../../../../contexts'
import type { PiToolExecution } from '../../../../omp/domain/index.js'
import { ToolPartView } from '../../parts/ToolPartView'
import i18n from '../../../../i18n'

void i18n.changeLanguage('zh-CN')

const phases = [
  { name: '调查', tasks: [{ content: '核对模型配置', status: 'completed' }] },
  { name: '实现', tasks: [
    { content: '重构设置页面', status: 'in_progress' },
    { content: '等待服务重启', status: 'blocked', blocker: '服务仍在执行任务' },
    { content: '不再采用旧布局', status: 'abandoned' },
    { content: '验证桌面效果', status: 'pending' },
  ] },
]

function execution(details: unknown, args: Record<string, unknown> = { op: 'view' }, isError = false): PiToolExecution {
  return {
    call: { type: 'toolCall', name: 'todo', id: 'todo-call', arguments: args },
    result: {
      role: 'toolResult', toolName: 'todo', toolCallId: 'todo-call', timestamp: 20,
      content: [{ type: 'text', text: isError ? 'Task not found' : 'Remaining items (3): raw summary' }],
      details, isError,
    },
  }
}

function view(value: PiToolExecution, key: string) {
  return <FullscreenProvider><ToolPartView execution={value} partKey={key} defaultExpanded /></FullscreenProvider>
}

describe('Todo tool rendering', () => {
  it('renders native phase snapshots as task rows rather than raw Input/Output', () => {
    const { container } = render(view(execution({ op: 'view', phases, storage: 'session' }), 'native-phases'))

    expect(screen.getByRole('button', { name: '任务 2/5' })).toHaveAttribute('aria-expanded', 'true')
    for (const name of ['调查', '实现', '核对模型配置', '重构设置页面', '验证桌面效果', '服务仍在执行任务']) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
    for (const name of ['已完成', '进行中', '等待中', '已放弃', '待开始']) {
      expect(screen.getByRole('img', { name })).toBeInTheDocument()
    }
    expect(container.textContent).not.toContain('Remaining items')
    expect(screen.queryByText('Input')).not.toBeInTheDocument()
    expect(screen.queryByText('Output')).not.toBeInTheDocument()
  })

  it('updates completed counts and respects an authoritative empty result', () => {
    const args = { op: 'init', items: ['旧任务'] }
    const { rerender } = render(view(execution({ phases }, args), 'native-update'))
    rerender(view(execution({ phases: [{ name: '实现', tasks: [{ content: '重构设置页面', status: 'completed' }] }] }, args), 'native-update'))
    expect(screen.getByRole('button', { name: '任务 1/1' })).toBeInTheDocument()
    expect(screen.queryByText('核对模型配置')).not.toBeInTheDocument()
    const cleared = execution({ op: 'init', phases: [], storage: 'session' }, { ...args, list: [] })
    cleared.result!.content = [{ type: 'text', text: 'Todo list cleared.' }]
    rerender(view(cleared, 'native-update'))
    expect(screen.getByText('Todo list cleared.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /任务/ })).not.toBeInTheDocument()
    expect(screen.queryByText('旧任务')).not.toBeInTheDocument()
    expect(screen.queryByText('重构设置页面')).not.toBeInTheDocument()
  })

  it('explains an empty snapshot even when the tool supplies no text', () => {
    const empty = execution({ phases: [] })
    empty.result!.content = []
    render(view(empty, 'native-empty'))
    expect(screen.getByText('当前任务列表为空。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /任务/ })).not.toBeInTheDocument()
  })

  it('previews native init tasks while the result is pending', () => {
    const value = execution(undefined, { op: 'init', list: [{ phase: '验证', items: ['检查布局', '检查滚动'] }] })
    value.result = undefined
    render(view(value, 'native-pending'))
    expect(screen.getByRole('button', { name: '任务 0/2' })).toBeInTheDocument()
    expect(screen.getByText('检查布局')).toBeInTheDocument()
    expect(screen.getByText('检查滚动')).toBeInTheDocument()
  })

  it('keeps legacy TodoWrite rows and task-list collapse working', async () => {
    const value = execution(undefined, { todos: [{ id: 'legacy', content: '校对构建入口', status: 'in_progress', priority: 'high' }] })
    value.call.name = 'todowrite'
    render(view(value, 'legacy-list'))
    const header = screen.getByRole('button', { name: '任务 0/1' })
    expect(screen.getByText('校对构建入口')).toBeInTheDocument()
    expect(screen.getByText('!')).toBeInTheDocument()
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(screen.queryByText('校对构建入口')).not.toBeInTheDocument())
    fireEvent.click(header)
    expect(screen.getByText('校对构建入口')).toBeInTheDocument()
  })

  it('does not conceal a failed native operation behind its unchanged snapshot', () => {
    render(view(execution({ phases }, { op: 'done', task: 'missing' }, true), 'native-error'))
    expect(screen.getByText('Task not found')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /任务/ })).not.toBeInTheDocument()
  })
})
