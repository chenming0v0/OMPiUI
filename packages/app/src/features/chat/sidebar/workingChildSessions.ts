import { useSyncExternalStore } from 'react'
import { ompSubagentStore } from '../../../omp/ompSubagentStore'
import { subagentDisplayTitle } from '../../../omp/ompSubagentFormat'
import type { UiSession } from '../../../types/session'

/** 尚未解析出真实会话 id 的运行中子代理行；点击时按 path 只读解析 */
export const WORKING_CHILD_ID_PREFIX = 'subagent-run:'

/** 子会话文件路径比较键（Windows 路径大小写不敏感、分隔符统一） */
export function childPathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

const EMPTY: Map<string, UiSession[]> = new Map()
let cachedKey = ''
let cachedValue = EMPTY

/**
 * 父会话 id → 正在工作的子代理行（OpenCodeUI：活跃子会话自动挂到父会话下，结束即消失）。
 * 只在“哪些子代理在跑”变化时换引用；进度帧不触发侧栏重渲染。
 */
function selectWorkingChildSessions(): Map<string, UiSession[]> {
  const working = ompSubagentStore.getSnapshot().runs
    .filter(run => (run.status === 'running' || run.status === 'pending') && run.sessionFile)
    .sort((a, b) => a.startedAt - b.startedAt)
  const rows = working.map(run => ({
    parentId: run.sessionId,
    session: {
      id: `${WORKING_CHILD_ID_PREFIX}${run.id}`,
      directory: '',
      title: subagentDisplayTitle(run.description, run.task, run.agent) ?? run.agent,
      createdAt: run.startedAt,
      updatedAt: run.startedAt,
      path: run.sessionFile,
      isChildSession: true,
      subagentRunning: true,
    } satisfies UiSession,
  }))
  const key = rows.map(row => `${row.parentId}\u0000${row.session.id}\u0000${row.session.path}\u0000${row.session.title}`).join('\u0001')
  if (key === cachedKey) return cachedValue
  const map = new Map<string, UiSession[]>()
  for (const row of rows) map.set(row.parentId, [...(map.get(row.parentId) ?? []), row.session])
  cachedKey = key
  cachedValue = map.size > 0 ? map : EMPTY
  return cachedValue
}

export function useWorkingChildSessions(): Map<string, UiSession[]> {
  return useSyncExternalStore(ompSubagentStore.subscribe, selectWorkingChildSessions, selectWorkingChildSessions)
}
