// ============================================
// useVcsInfo - VCS 信息 Hook
// 轮询获取当前项目的 Git 分支信息
// ============================================

import { useState, useEffect, useCallback, useRef } from 'react'
import type { GitInfoResponse } from '@ompiui/protocol'
import { getHostGitInfo } from '../omp/transport/index.js'
import { resolveWorkspacePath } from '../omp/workspaces'
import { serverStore } from '../store/serverStore'

const POLL_INTERVAL = 15000 // 15s 轮询
const shared = new Map<string, { at: number; pending: boolean; flight: Promise<GitInfoResponse> }>()
serverStore.onServerChange(() => shared.clear())

function sharedGitInfo(workspace: string, force: boolean) {
  const cached = shared.get(workspace)
  if (cached && (cached.pending || ((!force || Date.now() - cached.at < 1000) && Date.now() - cached.at < POLL_INTERVAL))) return cached.flight
  const flight = getHostGitInfo(workspace).catch(error => {
    if (shared.get(workspace)?.flight === flight) shared.delete(workspace)
    throw error
  }).finally(() => {
    const current = shared.get(workspace)
    if (current?.flight === flight) {
      current.pending = false
      current.at = Date.now()
    }
  })
  shared.set(workspace, { at: Date.now(), pending: true, flight })
  if (shared.size > 64) shared.delete(shared.keys().next().value!)
  return flight
}

export interface UseVcsInfoResult {
  vcsInfo: GitInfoResponse | null
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export function useVcsInfo(directory?: string): UseVcsInfoResult {
  const [vcsInfo, setVcsInfo] = useState<GitInfoResponse | null>(null)
  const [isLoading, setIsLoading] = useState(Boolean(directory))
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const flightRef = useRef<string | undefined>(undefined)

  const fetchVcs = useCallback(async (force = false) => {
    if (document.hidden || (directory && flightRef.current === directory)) return
    const requestId = ++requestIdRef.current

    if (!directory) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setVcsInfo(null)
        setError(null)
        setIsLoading(false)
      }
      return
    }

    flightRef.current = directory
    setIsLoading(true)
    try {
      const workspacePath = await resolveWorkspacePath(directory)
      const info = workspacePath ? await sharedGitInfo(workspacePath, force) : null
      if (mountedRef.current && requestId === requestIdRef.current) {
        setVcsInfo(info)
        setError(null)
      }
    } catch (e) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to fetch VCS info')
        setVcsInfo(null)
      }
    } finally {
      if (requestId === requestIdRef.current) flightRef.current = undefined
      if (mountedRef.current && requestId === requestIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [directory])

  // 初始加载 + 目录变化时重新获取：请求-响应模式，重置/loading 与请求同步设置
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    mountedRef.current = true
    setVcsInfo(null)
    setError(null)
    setIsLoading(Boolean(directory))
    void fetchVcs()
    return () => {
      mountedRef.current = false
    }
  }, [directory, fetchVcs])

  useEffect(() => serverStore.onServerChange(() => {
    requestIdRef.current++
    flightRef.current = undefined
    void fetchVcs(true)
  }), [fetchVcs])

  // 轮询
  useEffect(() => {
    if (!directory) return

    const visible = () => { if (!document.hidden) void fetchVcs() }
    const timer = setInterval(visible, POLL_INTERVAL)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [directory, fetchVcs])

  return { vcsInfo, isLoading, error, refresh: () => { void fetchVcs(true) } }
}
