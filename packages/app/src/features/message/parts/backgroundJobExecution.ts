import type { PiCustomMessageItem, PiToolExecution } from '../../../omp/domain/index.js'
import { readBackgroundJobs, type BackgroundJobView } from './customMessagePresentation'

const RUNNING_JOB_STATUSES = new Set(['running', 'pending', 'started', 'queued'])

/**
 * 把后台任务投递合成工具执行：name 作为行内 title，type 只用于取图标。
 * 没有真实起止时间，用 0 → durationMs 表示耗时，只影响时长显示。
 * backgroundJob 标记让行首显示「后台任务」而不是合成的工具名。
 *
 * 工具名固定是 job：后台任务投递不是真正的工具调用。冒用 bash / task 会让
 * ToolBody 选中 BashRenderer / TaskRenderer——它们要的是真实调用参数、子任务
 * 进度和全屏上下文，合成执行一概没有，结果就是一张自成一体的背景卡片：
 * 和上下行对不齐，也接不上组内连线。统一走 DefaultRenderer 的 Input/Output
 * 折叠，外观才和其它工具行完全一致。
 */
export function backgroundJobExecution(job: BackgroundJobView, callId: string): PiToolExecution {
  const toolName = 'job'
  const rawType = (job.type ?? '').trim().toLowerCase()
  const call: PiToolExecution['call'] = {
    type: 'toolCall',
    id: callId,
    name: toolName,
    arguments: { description: job.name, ...(rawType ? { kind: rawType } : {}) },
  }
  if (RUNNING_JOB_STATUSES.has(job.status)) return { call, isRunning: true, startedAt: 0, backgroundJob: true }

  const text = [job.body.trim(), ...job.errors].filter(Boolean).join('\n\n') || job.summary || ''
  const failed = job.status === 'failed' || job.status === 'aborted' || job.errors.length > 0
  // 头部耗时由 ToolPartView 从 startedAt/completedAt 算，原生 duration 是
  // 「5m 44s」这种字符串，先折算成毫秒才能复用同一套格式化。
  const durationMs = job.durationMs ?? parseDurationLabel(job.duration)
  return {
    call,
    backgroundJob: true,
    startedAt: durationMs !== undefined ? 0 : undefined,
    completedAt: durationMs,
    result: {
      role: 'toolResult',
      toolCallId: callId,
      toolName,
      content: [{ type: 'text', text }],
      isError: failed,
      timestamp: durationMs,
    } as unknown as PiToolExecution['result'],
  }
}

const executionCache = new WeakMap<PiCustomMessageItem, PiToolExecution[] | null>()

/**
 * 一条 async-result 投递里的全部 job，按投递条目 + 序号生成稳定且唯一的 call id。
 * 按条目引用缓存：时间线合并与渲染都会调用，结果引用稳定才不击穿 memo。
 */
export function backgroundJobExecutions(item: PiCustomMessageItem): PiToolExecution[] | undefined {
  if (!item.display) return undefined
  const cached = executionCache.get(item)
  if (cached !== undefined) return cached ?? undefined
  const jobs = readBackgroundJobs(item)
  const executions = jobs?.length
    ? jobs.map((job, index) => backgroundJobExecution(job, `job:${item.entryId}:${job.id}:${index}`))
    : null
  executionCache.set(item, executions)
  return executions ?? undefined
}

const DURATION_PART = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi
const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** 解析原生 "1m 11s" / "332ms" 形式的耗时为毫秒；无法解析时返回 undefined。 */
export function parseDurationLabel(label: string | undefined): number | undefined {
  if (!label) return undefined
  let total = 0
  let matched = false
  for (const match of label.matchAll(DURATION_PART)) {
    matched = true
    total += Number.parseFloat(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()]
  }
  return matched ? Math.round(total) : undefined
}
