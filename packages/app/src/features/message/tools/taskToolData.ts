import { isJsonObject, type JsonObject } from '@ompiui/protocol'
import type { PiToolExecution } from '../../../omp/domain/index.js'
import { getToolExecutionStatus } from '../../../omp/domain/index.js'
import { deriveTaskOutcome, type TaskOutcome } from '../../../omp/taskOutcome'

export const XD_TASK_ADDRESS = 'xd://task'

export type TaskArgumentsState = 'ready' | 'streaming' | 'invalid'

export interface TaskToolView {
  source: 'task' | 'xd-write'
  /** UI 语义投影：保留原 call.id，name 固定为 task，arguments / result.details 为解包后的 task 输入与详情。 */
  execution: PiToolExecution
  argumentsState: TaskArgumentsState
  argumentsError?: string
  /** 上游拒绝的参数里仍能认出的子任务名，只用于失败行标题。 */
  attemptedNames?: string[]
  rawCall: { name: string; path?: string; content?: string }
}

type ParsedContent = { state: TaskArgumentsState; input?: JsonObject; error?: string }

function parseTaskContent(content: unknown, generating: boolean): ParsedContent {
  if (isJsonObject(content)) return { state: 'ready', input: content }
  if (typeof content !== 'string' || !content.trim()) {
    return generating ? { state: 'streaming' } : { state: 'invalid', error: 'Missing task content' }
  }
  try {
    const value: unknown = JSON.parse(content)
    return isJsonObject(value) ? { state: 'ready', input: value } : { state: 'invalid', error: 'Task content must be a JSON object' }
  } catch (error) {
    return generating ? { state: 'streaming' } : { state: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

function taskTitle(input: JsonObject, intent: unknown): string | undefined {
  if (typeof input.description === 'string' && input.description.trim()) return undefined
  const tasks = Array.isArray(input.tasks) ? input.tasks.filter(isJsonObject) : []
  const label = (task: JsonObject) => [task.description, task.name].find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  if (tasks.length === 1) return label(tasks[0])
  if (typeof intent === 'string' && intent.trim()) return intent
  const names = tasks.map(label).filter((value): value is string => Boolean(value))
  return names.length ? names.join(' · ') : undefined
}

function attemptedTaskNames(content: unknown): string[] | undefined {
  if (typeof content !== 'string') return undefined
  const names = [...content.matchAll(/"name"\s*:\s*"([^"\\\n]{1,120})"/g)].map(match => match[1])
  return names.length ? names : undefined
}

/** 只识别原生 task 与 write xd://task；靠工具名、精确地址与 details.xdev 元数据，不看输出文本。 */
export function getTaskToolView(execution: PiToolExecution): TaskToolView | undefined {
  const { call, result } = execution
  if (call.name.toLowerCase() === 'task') {
    return { source: 'task', execution, argumentsState: 'ready', rawCall: { name: call.name } }
  }
  if (call.name !== 'write' || !isJsonObject(call.arguments) || call.arguments.path !== XD_TASK_ADDRESS) return undefined
  const details = isJsonObject(result?.details) ? result.details : undefined
  const xdev = isJsonObject(details?.xdev) && details.xdev.tool === 'task' ? details.xdev : undefined
  const parsed: ParsedContent = xdev && isJsonObject(xdev.args)
    ? { state: 'ready', input: xdev.args }
    : parseTaskContent(call.arguments.content, getToolExecutionStatus(execution) === 'pending')
  const content = call.arguments.content
  const title = parsed.input ? taskTitle(parsed.input, call.arguments.i) : undefined
  const projectedArguments = parsed.input ? title ? { ...parsed.input, description: title } : parsed.input : {}
  return {
    source: 'xd-write',
    execution: {
      ...execution,
      call: { ...call, name: 'task', arguments: projectedArguments },
      ...(result ? { result: { ...result, toolName: 'task', details: xdev && isJsonObject(xdev.inner) ? xdev.inner : result.details } } : {}),
    },
    argumentsState: parsed.state,
    argumentsError: parsed.error,
    ...(parsed.state === 'invalid' ? { attemptedNames: attemptedTaskNames(content) } : {}),
    rawCall: { name: call.name, path: XD_TASK_ADDRESS, content: typeof content === 'string' ? content : undefined },
  }
}

/** 渲染层统一入口：task 形式返回语义投影，其它工具原样返回。 */
export function resolveTaskExecution(execution: PiToolExecution): PiToolExecution {
  return getTaskToolView(execution)?.execution ?? execution
}

export interface TaskProgressEntry {
  index: number
  id?: string
  agent?: string
  status?: string
  description?: string
  assignment?: string
  durationMs?: number
}

const stringField = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined

/** OMP task details.progress[]：异步派发时这是每个子代理唯一的落盘元数据。 */
export function extractTaskProgress(details: Record<string, unknown> | undefined): TaskProgressEntry[] {
  const progress = details?.progress
  if (!Array.isArray(progress)) return []
  return progress.filter(isJsonObject).map((entry, position) => ({
    index: typeof entry.index === 'number' ? entry.index : position,
    id: stringField(entry.id),
    agent: stringField(entry.agent),
    status: stringField(entry.status),
    description: stringField(entry.description),
    assignment: stringField(entry.assignment),
    durationMs: typeof entry.durationMs === 'number' && entry.durationMs > 0 ? entry.durationMs : undefined,
  }))
}

/** details.async 存在说明工具只返回了派发回执，子代理结果随后经 async-result 投递。 */
export function isAsyncTaskDispatch(details: Record<string, unknown> | undefined): boolean {
  return isJsonObject(details?.async)
}

export interface AsyncTaskResult {
  jobId: string
  status: string
  durationMs?: number
  output: string
  errors: string[]
  timestamp: number
  /** Only structured job fields, never attributes parsed from the delivery body. */
  details: Record<string, unknown>
  outcome: TaskOutcome
}

const asyncResultIndex = new WeakMap<readonly unknown[], Map<string, AsyncTaskResult[]>>()

function entryTime(value: unknown): number {
  if (typeof value === 'number') return value
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** 按 jobId 索引会话里的 async-result 投递（只读已加载条目，按引用缓存）。 */
export function indexAsyncTaskResults(entries: readonly unknown[]): Map<string, AsyncTaskResult[]> {
  const cached = asyncResultIndex.get(entries)
  if (cached) return cached
  const index = new Map<string, AsyncTaskResult[]>()
  for (const entry of entries) {
    if (!isJsonObject(entry) || entry.type !== 'custom_message' || entry.customType !== 'async-result') continue
    const details = isJsonObject(entry.details) ? entry.details : undefined
    const jobs = (Array.isArray(details?.jobs) ? details.jobs : []).filter(isJsonObject)
      .filter(job => job.type === 'task' && typeof job.jobId === 'string')
    const output = typeof entry.content === 'string' ? entry.content : Array.isArray(entry.content)
      ? entry.content.filter(isJsonObject).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
    for (const job of jobs) {
      const jobId = String(job.jobId)
      const structured = { ...(isJsonObject(job.meta) ? job.meta : {}), ...job }
      const errors = typeof structured.error === 'string' && structured.error.trim() ? [structured.error] : []
      const list = index.get(jobId) ?? []
      list.push({ jobId, status: stringField(job.status) ?? 'unknown', durationMs: typeof job.durationMs === 'number' ? job.durationMs : undefined,
        output, errors, timestamp: entryTime(entry.timestamp), details: structured, outcome: deriveTaskOutcome(structured) })
      index.set(jobId, list)
    }
  }
  asyncResultIndex.set(entries, index)
  return index
}

/** 同名任务可被复用：取派发之后的第一次投递。 */
export function findAsyncTaskResult(index: Map<string, AsyncTaskResult[]>, jobId: string, dispatchedAt: number | undefined): AsyncTaskResult | undefined {
  const list = index.get(jobId)
  if (!list?.length) return undefined
  return dispatchedAt ? list.find(result => !result.timestamp || result.timestamp >= dispatchedAt) : list[0]
}

/** 批量 task 的子任务标题列表；单任务或非 task 返回 undefined。按 OpenCode 的样子拆成多行。 */
export function getTaskBatchTitles(execution: PiToolExecution): string[] | undefined {
  const resolved = resolveTaskExecution(execution)
  if (resolved.call.name !== 'task') return undefined
  const args = resolved.call.arguments as Record<string, unknown> | undefined
  const tasks = args && Array.isArray(args.tasks) ? args.tasks.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && !Array.isArray(t)) : []
  if (tasks.length < 2) return undefined
  return tasks.map((t, i) => [t.name, t.description].find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? `#${i + 1}`)
}
