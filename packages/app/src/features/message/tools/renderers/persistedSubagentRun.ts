import type { OmpSubagentRun, OmpSubagentStatus } from '../../../../omp/ompSubagentStore'

/**
 * 落盘回退 —— 注册表为空时从持久化结果重建子代理 run。
 *
 * OMP RPC 的子代理注册表是进程内的（RpcSubagentRegistry），终态 run 还会被
 * 删除：worker 重启/换实例/页面重开后 attach，state.subagents 为空，
 * TaskRenderer 拿不到 run，Subtask 面板永远显示"等待响应"。
 * 但 task 工具结果 details.results[] 持久化了每个子代理的 id/agent/任务/
 * 退出码/用量，转录也落盘在 <父会话目录>/<子代理id>.jsonl（outputPath 的
 * 同目录）。据此重建只读 run，转录经 subagent.messages 的磁盘兜底读回。
 */

export interface PersistedSubagentResult {
  index?: number
  id?: string
  agent?: string
  description?: string
  task?: string
  assignment?: string
  exitCode?: number
  aborted?: boolean
  tokens?: number
  durationMs?: number
  outputPath?: string
}

function dirnameOf(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut > 0 ? trimmed.slice(0, cut) : trimmed
}

/** 子会话转录文件：优先 outputPath 同目录，退回父会话文件同名目录 */
export function deriveChildSessionFile(
  result: PersistedSubagentResult,
  parentSessionFile?: string,
): string | undefined {
  const id = typeof result.id === 'string' ? result.id : undefined
  if (!id) return undefined
  if (typeof result.outputPath === 'string' && result.outputPath.trim()) {
    return `${dirnameOf(result.outputPath)}/${id}.jsonl`
  }
  if (typeof parentSessionFile === 'string' && parentSessionFile.endsWith('.jsonl')) {
    return `${parentSessionFile.slice(0, -'.jsonl'.length)}/${id}.jsonl`
  }
  return undefined
}

export function extractFirstPersistedResult(
  details: Record<string, unknown> | undefined,
): PersistedSubagentResult | undefined {
  const results = details?.results
  if (!Array.isArray(results)) return undefined
  const first = results.find(item => item && typeof item === 'object' && !Array.isArray(item))
  return first ? first as unknown as PersistedSubagentResult : undefined
}

export function buildPersistedSubagentRun(
  callId: string,
  result: PersistedSubagentResult,
  sessionFile: string | undefined,
): OmpSubagentRun | undefined {
  if (typeof result.id !== 'string' || !result.id) return undefined
  const status: OmpSubagentStatus = result.aborted === true
    ? 'aborted'
    : (result.exitCode ?? 0) === 0
      ? 'completed'
      : 'failed'
  return {
    id: `persisted:${callId}:${result.index ?? 0}`,
    sessionId: 'persisted',
    parentToolCallId: callId,
    agent: typeof result.agent === 'string' && result.agent ? result.agent : 'task',
    description: typeof result.description === 'string' ? result.description : undefined,
    task: typeof result.task === 'string' ? result.task : typeof result.assignment === 'string' ? result.assignment : '',
    status,
    sessionFile,
    index: typeof result.index === 'number' ? result.index : 0,
    detached: false,
    // historyLoaded 置位：让实时路径的 useSubagentHistoryBackfill 跳过，
    // 转录由调用方的回退 hook 自己拉取
    historyLoaded: true,
    transcript: [],
    startedAt: 0,
  }
}
