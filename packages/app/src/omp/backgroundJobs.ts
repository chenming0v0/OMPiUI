import { useEffect, useState } from 'react'
import { piSessionStateStore } from './state/index.js'
import { getPiAsyncJobs } from './transport/index.js'

export interface BackgroundJob {
  id: string
  type: string
  status: string
  label: string
  command?: string
  startTime: number
  endTime?: number
}

export interface BackgroundJobsSnapshot {
  running: BackgroundJob[]
  recent: BackgroundJob[]
}

export const BACKGROUND_JOB_POLL_MS = 3000
const EMPTY: BackgroundJobsSnapshot = { running: [], recent: [] }
const RUNTIME_GONE = new Set(['CAPABILITY_DISABLED', 'RUNTIME_NOT_OPEN', 'SESSION_NOT_FOUND', 'RUNTIME_CLOSING'])

function parseJob(raw: unknown): BackgroundJob | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || typeof value.startTime !== 'number') return null
  return {
    id: value.id,
    type: typeof value.type === 'string' ? value.type : '',
    status: typeof value.status === 'string' ? value.status : 'running',
    label: typeof value.label === 'string' && value.label ? value.label : value.id,
    command: typeof value.command === 'string' ? value.command : undefined,
    startTime: value.startTime,
    endTime: typeof value.endTime === 'number' ? value.endTime : undefined,
  }
}

export function parseAsyncJobSnapshot(raw: unknown): BackgroundJobsSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY
  const value = raw as Record<string, unknown>
  const list = (items: unknown) => (Array.isArray(items) ? items.map(parseJob).filter((job): job is BackgroundJob => job !== null) : [])
  return { running: list(value.running).filter(job => job.status === 'running'), recent: list(value.recent) }
}

function runtimeActive(sessionId: string): boolean {
  const state = piSessionStateStore.getState(sessionId)
  return !!state && state.diskPreview !== true && state.readOnly !== true
}

function activityKey(sessionId: string): string {
  const state = piSessionStateStore.getState(sessionId)
  return `${runtimeActive(sessionId)}:${state?.isStreaming === true}:${state?.isBashRunning === true}`
}

export function useBackgroundJobs(sessionId: string | null | undefined, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<BackgroundJobsSnapshot>(EMPTY)
  const [error, setError] = useState<Error | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    if (!sessionId || !enabled) return
    let key = activityKey(sessionId)
    return piSessionStateStore.subscribe(() => {
      const next = activityKey(sessionId)
      if (next === key) return
      key = next
      setRefreshToken(token => token + 1)
    })
  }, [sessionId, enabled])

  // Reset when the session changes; adjusted during render so callers never
  // observe another session's jobs.
  const [prevSessionId, setPrevSessionId] = useState(sessionId)
  if (prevSessionId !== sessionId) {
    setPrevSessionId(sessionId)
    setSnapshot(EMPTY)
    setError(null)
  }

  // Clear jobs for sessions without an active runtime; adjusted during render
  // so the hook never displays jobs of a dead runtime.
  const runtimeInactive = !sessionId || !enabled || (!!sessionId && !runtimeActive(sessionId))
  const [prevInactive, setPrevInactive] = useState(runtimeInactive)
  if (prevInactive !== runtimeInactive) {
    setPrevInactive(runtimeInactive)
    if (runtimeInactive) setSnapshot(EMPTY)
  }

  useEffect(() => {
    if (!sessionId || !enabled || !runtimeActive(sessionId)) {
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      if (!runtimeActive(sessionId)) {
        setSnapshot(EMPTY)
        return
      }
      try {
        const next = parseAsyncJobSnapshot(await getPiAsyncJobs(sessionId, controller.signal))
        if (controller.signal.aborted) return
        setSnapshot(next)
        setError(null)
        if (next.running.length > 0) timer = setTimeout(load, BACKGROUND_JOB_POLL_MS)
      } catch (err) {
        if (controller.signal.aborted) return
        const code = (err as { code?: unknown } | null)?.code
        if (typeof code === 'string' && RUNTIME_GONE.has(code)) {
          setSnapshot(EMPTY)
          setError(null)
          return
        }
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    }
    void load()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, enabled, refreshToken])

  const refresh = () => setRefreshToken(token => token + 1)
  return { ...snapshot, error, refresh }
}
