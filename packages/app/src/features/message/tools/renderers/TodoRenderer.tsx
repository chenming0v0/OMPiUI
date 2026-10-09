import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, CheckIcon, ClockIcon, CloseIcon, CircleIcon } from '../../../../components/Icons'
import type { ToolRendererProps } from '../types'
import { toolResultText } from '../toolResultContent'
import { useDisclosureScrollLock } from '../../../../hooks'
import { extractTodos } from './todoUtils'
import type { TodoItem } from '../../../../omp/domain/todo'
import { useUiDisclosureState } from '../../../../utils/uiDisclosureState'
import { chevronClass, MessageExpandPanel, useMessageExpandRender } from '../../messageExpand'

// ============================================
// Todo Renderer
// ============================================

export function TodoRenderer({ execution, partKey }: ToolRendererProps) {
  const { t } = useTranslation('message')
  const todos = extractTodos(execution)
  if (todos.length === 0) {
    const outcome = toolResultText(execution.result).trim()

    return (
      <div className="px-3 py-2 text-[length:var(--fs-sm)] text-text-400 whitespace-pre-wrap break-words">
        {outcome || t('todo.empty')}
      </div>
    )
  }

  return <TodoList todos={todos} stateKey={`message:${partKey}:todo-list`} />
}

// ============================================
// TodoList Component
// ============================================

function TodoList({ todos, stateKey }: { todos: TodoItem[]; stateKey: string }) {
  const { t } = useTranslation('message')
  const [collapsed, setCollapsed] = useUiDisclosureState(stateKey, false)
  const shouldRenderBody = useMessageExpandRender(!collapsed)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const completed = todos.filter(t => t.status === 'completed' || t.status === 'abandoned').length
  const total = todos.length

  return (
    <div ref={rootRef} className="border border-border-200/50 rounded-md overflow-hidden bg-bg-100 text-[length:var(--fs-sm)]">
      {/* Header */}
      <button
        ref={headerRef}
        type="button"
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between px-3 h-8 bg-bg-200/50 hover:bg-bg-200 cursor-pointer select-none transition-colors"
        onClick={() => withScrollLock(() => setCollapsed(!collapsed))}
      >
        <div className="flex items-center gap-2">
          <span className={chevronClass(!collapsed, 'md', 'text-text-400')}>
            <ChevronDownIcon />
          </span>
          <span className="text-text-300 font-medium font-mono">{t('todo.tasks')}</span>
        </div>
        <span className="text-text-500 tabular-nums font-mono">{t('todo.completedCount', { completed, total })}</span>
      </button>

      {/* List */}
      <MessageExpandPanel open={!collapsed} innerClassName="overflow-hidden">
        {shouldRenderBody && (
          <div className="divide-y divide-border-200/30">
            {todos.map((todo, index) => (
              <Fragment key={todo.id}>
                {todo.phase !== undefined && (index === 0 || todos[index - 1].phase !== todo.phase) && (
                  <div className="px-3 py-1.5 bg-bg-200/30 text-text-400 font-medium break-words">{todo.phase}</div>
                )}
                <div
                  className={`flex items-center gap-2 px-3 py-2 ${
                    todo.status === 'completed' || todo.status === 'abandoned' || todo.status === 'cancelled' ? 'text-text-500' : 'text-text-200'
                  }`}
                >
                  <span className="shrink-0 flex items-center" role="img" aria-label={t(`todo.status.${todo.status}`)}>{getTodoIcon(todo.status)}</span>
                  <span className={`min-w-0 flex-1 break-words ${todo.status === 'completed' ? 'line-through' : ''}`}>
                    {todo.content}
                    {todo.status === 'blocked' && todo.blocker && (
                      <span className="block text-text-400 text-[length:var(--fs-xs)]">{todo.blocker}</span>
                    )}
                  </span>
                  {todo.status === 'blocked' && (
                    <span className="text-[length:var(--fs-xxs)] text-warning-100 bg-warning-100/10 px-1 rounded shrink-0">{t('todo.status.blocked')}</span>
                  )}
                  {todo.priority === 'high' && todo.status !== 'completed' && (
                    <span className="text-[length:var(--fs-xxs)] text-warning-100 bg-warning-100/10 px-1 rounded shrink-0">!</span>
                  )}
                </div>
              </Fragment>
            ))}
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
}

function getTodoIcon(status: TodoItem['status']) {
  const size = 14
  const cls = {
    completed: 'text-accent-secondary-100',
    in_progress: 'text-accent-main-100',
    cancelled: 'text-text-500',
    abandoned: 'text-text-500',
    blocked: 'text-warning-100',
    pending: 'text-text-500',
  }[status]

  switch (status) {
    case 'completed':
      return <CheckIcon size={size} className={cls} strokeWidth={2.5} />
    case 'in_progress':
      return <ClockIcon size={size} className={cls} />
    case 'cancelled':
    case 'abandoned':
      return <CloseIcon size={size} className={cls} />
    case 'blocked':
      return <ClockIcon size={size} className={cls} />
    default:
      return <CircleIcon size={size} className={cls} />
  }
}
