import { useEffect, useMemo, useState } from 'react'
import { listPiChildSessions } from '../../../omp/transport/index.js'
import { serverStore } from '../../../store/serverStore'
import type { UiSession } from '../../../types/session'

/**
 * 拉取选中会话的 OMP 子代理会话列表。仅在父会话文件路径已知时请求；
 * 会话列表刷新（omompiui:sessions-changed）后重取，让运行中刚落盘的子会话出现。
 */
export function useChildSessions(
  selectedSessionId: string | null | undefined,
  sessionByid: Map<string, UiSession> | undefined,
): UiSession[] {
  const [loaded, setLoaded] = useState<{ parent: string; list: UiSession[] } | null>(null)
  const parentPath = useMemo(
    () => (selectedSessionId ? sessionByid?.get(selectedSessionId)?.path ?? null : null),
    [selectedSessionId, sessionByid],
  )

  useEffect(() => {
    if (!parentPath) return
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
              title: typeof record.name === 'string' && record.name
                ? record.name
                : typeof record.firstMessage === 'string' && record.firstMessage
                  ? record.firstMessage.slice(0, 60)
                  : 'task',
              firstMessage: typeof record.firstMessage === 'string' ? record.firstMessage : undefined,
              messageCount: typeof record.messageCount === 'number' ? record.messageCount : undefined,
              createdAt: typeof record.created === 'string' ? Date.parse(record.created) || 0 : 0,
              updatedAt: typeof record.modified === 'number' ? record.modified : 0,
              path: record.path,
              parentSessionPath: parentPath,
              isChildSession: true,
            }
          }).filter((session): session is UiSession => session !== null)
          setLoaded({ parent: parentPath, list })
        })
        .catch(() => undefined)
    }
    load()
    // 会话列表刷新（子会话落盘/重命名）后重取，让刚出现的子会话及时显示
    window.addEventListener('omompiui:sessions-changed', load)
    return () => {
      cancelled = true
      window.removeEventListener('omompiui:sessions-changed', load)
    }
  }, [parentPath])

  // parentPath 变化但新数据未到时，直接显示空（派生清空，避免陈旧列表闪现）
  return loaded && loaded.parent === parentPath ? loaded.list : EMPTY_CHILDREN
}

const EMPTY_CHILDREN: UiSession[] = []
