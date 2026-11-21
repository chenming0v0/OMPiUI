import { useEffect, useState, useSyncExternalStore } from 'react'
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
 * 会话列表刷新（ompiui:sessions-changed）后重取，让运行中刚落盘的子会话出现。
 *
 * 结果是粘性的：选中子会话本身时（它不在主列表里，解析不出父路径），
 * 保留上一次的列表，让子会话行保持在侧边栏可见、可高亮。
 */
export function useChildSessions(
  selectedSessionId: string | null | undefined,
  sessionByid: Map<string, UiSession> | undefined,
  enabled = true,
): ChildSessionsResult {
  const generation = useSyncExternalStore(
    listener => serverStore.subscribe(listener),
    () => serverStore.getActiveServerGeneration(),
    () => serverStore.getActiveServerGeneration(),
  )
  const serverId = serverStore.getActiveServerId()
  const [loaded, setLoaded] = useState<{
    parentId: string; parentPath: string; list: UiSession[]; generation: number; serverId: string
  } | null>(null)
  const parentSession = selectedSessionId ? sessionByid?.get(selectedSessionId) : undefined
  const viewingLoadedChild = loaded?.serverId === serverId && loaded.list.some(session => session.id === selectedSessionId)
  const parentId = parentSession?.id ?? (viewingLoadedChild ? loaded?.parentId : null)
  const parentPath = parentSession?.path ?? (viewingLoadedChild ? loaded?.parentPath : null) ?? null

  useEffect(() => {
    if (!enabled || !parentPath || !parentId) return
    let cancelled = false
    let inFlight = false
    let dirty = false
    let controller: AbortController | undefined
    const load = () => {
      if (inFlight) {
        dirty = true
        return
      }
      inFlight = true
      controller = new AbortController()
      void listPiChildSessions(parentPath, controller.signal)
        .then(result => {
          if (cancelled || dirty || serverStore.getActiveServerGeneration() !== generation) return
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
          setLoaded({ parentId, parentPath, list, generation, serverId })
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
          if (!cancelled && dirty) {
            dirty = false
            load()
          }
        })
    }
    load()
    // 合帧防抖；在途读取期间只标脏，完成后补取，不让旧响应覆盖新列表。
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChanged = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 400)
    }
    window.addEventListener('ompiui:sessions-changed', onChanged)
    return () => {
      cancelled = true
      controller?.abort()
      if (timer) clearTimeout(timer)
      window.removeEventListener('ompiui:sessions-changed', onChanged)
    }
  }, [enabled, parentPath, parentId, generation, serverId])

  // 服务器代次变化时立即隐藏旧数据；同一服务器重挂接仍可按原父身份补取。
  if (!loaded || loaded.generation !== generation || loaded.serverId !== serverId) return EMPTY_RESULT
  if (parentPath === null || (loaded.parentPath === parentPath && loaded.parentId === parentId)) {
    return { parentId: loaded.parentId, sessions: loaded.list }
  }
  return EMPTY_RESULT
}

const EMPTY_RESULT: ChildSessionsResult = { parentId: null, sessions: [] }
