export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'abandoned' | 'blocked'
  priority?: 'high' | 'medium' | 'low'
  phase?: string
  blocker?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function task(value: unknown, id: string, phase?: string): TodoItem | undefined {
  const item = record(value)
  if (!item || typeof item.content !== 'string') return undefined
  const status = item.status
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed' &&
      status !== 'cancelled' && status !== 'abandoned' && status !== 'blocked') return undefined
  return {
    id: typeof item.id === 'string' ? item.id : `${id}:${item.content}`,
    content: item.content,
    status,
    phase,
    priority: item.priority === 'high' || item.priority === 'medium' || item.priority === 'low' ? item.priority : undefined,
    blocker: typeof item.blocker === 'string' ? item.blocker : undefined,
  }
}

/** Undefined means no snapshot; [] is an authoritative empty snapshot. */
export function readTodoItems(value: unknown): TodoItem[] | undefined {
  const source = record(value)
  if (!source) return undefined
  if (Array.isArray(source.phases)) {
    const items: TodoItem[] = []
    for (const [phaseIndex, value] of source.phases.entries()) {
      const phase = record(value)
      if (!phase || typeof phase.name !== 'string' || !Array.isArray(phase.tasks)) return undefined
      for (const [index, value] of phase.tasks.entries()) {
        const item = task(value, `${phaseIndex}:${index}`, phase.name)
        if (!item) return undefined
        items.push(item)
      }
    }
    return items
  }
  if (Array.isArray(source.todos)) {
    const items = source.todos.map((value, index) => task(value, String(index)))
    return items.every((item): item is TodoItem => item !== undefined) ? items : undefined
  }
  // Native init has no snapshot until its result arrives. Preview only its task list,
  // never interpret start/done/append arguments as a replacement snapshot.
  if (source.op === 'init') {
    const list = Array.isArray(source.list) ? source.list : [{ phase: source.phase, items: source.items }]
    const items: TodoItem[] = []
    for (const [phaseIndex, value] of list.entries()) {
      const phase = record(value)
      if (!phase || !Array.isArray(phase.items)) return undefined
      for (const [index, content] of phase.items.entries()) {
        if (typeof content !== 'string') return undefined
        items.push({
          id: `${phaseIndex}:${index}:${content}`,
          content,
          status: 'pending',
          phase: typeof phase.phase === 'string' ? phase.phase : undefined,
        })
      }
    }
    return items
  }
  return undefined
}
