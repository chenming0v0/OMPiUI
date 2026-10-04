import { useEffect, useMemo, useState } from 'react'
import { subagentDisplayTitle } from '../../../omp/ompSubagentFormat'
import { listPiChildSessions } from '../../../omp/transport/index.js'
import { serverStore } from '../../../store/serverStore'
import type { UiSession } from '../../../types/session'

export interface ChildSessionsResult {
  /** 已加载子会话列表归属的父会话 id；未加载时为 null */
  parentId: string | null
  sessions: UiSession[]
}

/**
 * 拉取选中会话的 OMP 子代理会话列表。仅在父会话文件路径已知时请求；
 * 会话列表刷新（omompiui:sessions-changed）后重取，让运行中刚落盘的子会话出现。
 *
 * 结果是粘性的：选中子会话本身时（它不在主列表里，解析不出父路径），
 * 保留上一次的列表，让子会话行保持在侧边栏可见、可高亮。
 */
export function useChildSessions(
  selectedSessionId: string | null | undefined,
  sessionByid: Map<string, UiSession> | undefined,
): ChildSessionsResult {
  const [loaded, setLoaded] = useState<{ parentId: string; parentPath: string; list: UiSession[] } | null>(null)
  const parentSession = useMemo(
    () => (selectedSessionId ? sessionByid?.get(selectedSessionId) ?? null : null),
    [selectedSessionId, sessionByid],
  )
  const parentPath = parentSession?.path ?? null

  useEffect(() => {
    if (!parentPath || !parentSession) return
    let cancelled = false
    const generation = serverStore.getActiveServerGeneration()
    const load = () => {
      void listPiChildSessions(parentPath)
        .then(result => {
          if (cancelled || serverStore.getActiveServerGeneration() !== generation) return
          const listed = Array.isArray(result) ? result : []
          const list = listed.map((item): UiSession | null => {
            if (!item || typeof item !== 'object') return null
            const record = item as Record<string, unknown>
            if (typeof record.id !== 'string' || typeof record.path !== 'string') return null
            return {
              id: record.id,
              directory: typeof record.cwd === 'string' ? record.cwd : '',
              title: subagentDisplayTitle(
                typeof record.name === 'string' ? record.name : undefined,
                record.path.replace(/\\/g, '/').split('/').at(-1)?.replace(/\.jsonl$/i, ''),
              ) || 'task',
              firstMessage: typeof record.firstMessage === 'string' ? record.firstMessage : undefined,
              messageCount: typeof record.messageCount === 'number' ? record.messageCount : undefined,
              createdAt: typeof record.created === 'string' ? Date.parse(record.created) || 0 : 0,
              updatedAt: typeof record.modified === 'number' ? record.modified : 0,
              path: record.path,
              parentSessionPath: parentPath,
              isChildSession: true,
            }
          }).filter((session): session is UiSession => session !== null)
          setLoaded({ parentId: parentSession.id, parentPath, list })
        })
        .catch(() => undefined)
    }
    load()
    // 会话列表刷新（子会话落盘/重命名）后重取；合帧防抖，避免
    // sessions.updated 风暴把 worker 的同步父文件解析打满
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChanged = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 400)
    }
    window.addEventListener('omompiui:sessions-changed', onChanged)
    window.addEventListener('ompiui:sessions-changed', onChanged)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('omompiui:sessions-changed', onChanged)
      window.removeEventListener('ompiui:sessions-changed', onChanged)
    }
  }, [parentPath, parentSession])

  // parentPath 变化但新数据未到时显示空（派生清空，避免陈旧列表闪现）；
  // parentPath 为 null（选中了子会话）时保留已加载列表
  if (!loaded) return EMPTY_RESULT
  if (parentPath === null || loaded.parentPath === parentPath) {
    return { parentId: loaded.parentId, sessions: loaded.list }
  }
  return EMPTY_RESULT
}

const EMPTY_RESULT: ChildSessionsResult = { parentId: null, sessions: [] }
