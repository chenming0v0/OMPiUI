import type { PiToolExecution } from '../../../../omp/domain/index.js'
import { readTodoItems, type TodoItem } from '../../../../omp/domain/todo'

export function extractTodos(execution: PiToolExecution): TodoItem[] {
  return readTodoItems(execution.result?.details) ?? readTodoItems(execution.call.arguments) ?? []
}

export function hasTodos(execution: PiToolExecution): boolean {
  if (execution.result?.isError) return false
  return readTodoItems(execution.result?.details) !== undefined || readTodoItems(execution.call.arguments) !== undefined
}
