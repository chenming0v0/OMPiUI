import { useCallback, useEffect, useRef, useState } from 'react'

export type TailscaleAuthPhase = 'idle' | 'starting' | 'waitingAuthUrl' | 'opening' | 'authReady' | 'authorizing' | 'error'

export type TailscaleAuthSnapshot = { backendState?: string | null; authUrl?: string | null }

type Options = {
  start: (signal: AbortSignal) => Promise<TailscaleAuthSnapshot>
  poll: (signal: AbortSignal) => Promise<TailscaleAuthSnapshot>
  open: (url: string) => Promise<void | 'manual'>
  timeoutMessage: string
  pollMs?: number
  timeoutMs?: number
  statusPollMs?: number
  paused?: boolean
  onPollError?: (error: unknown) => void
}

/** 登录和普通状态刷新共用单飞轮询；取消标记也交给调用方保护其状态更新。 */
export function useTailscaleLoginFlow({ start, poll, open, timeoutMessage, pollMs = 1_000, timeoutMs = 30_000, statusPollMs, paused = false, onPollError }: Options) {
  const [phase, setPhase] = useState<TailscaleAuthPhase>('idle')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const latest = useRef({ start, poll, open, timeoutMessage, pollMs, timeoutMs, paused, onPollError })
  useEffect(() => {
    latest.current = { start, poll, open, timeoutMessage, pollMs, timeoutMs, paused, onPollError }
  })
  const controller = useRef(new AbortController())
  const timer = useRef<number | null>(null)
  const pending = useRef<AbortSignal | null>(null)
  const starting = useRef(false)
  const opening = useRef(false)
  const waiting = useRef(false)
  const startedAt = useRef(0)
  const currentUrl = useRef<string | null>(null)

  const stopPolling = useCallback(() => {
    waiting.current = false
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
  }, [])

  const reset = useCallback(() => {
    controller.current.abort()
    controller.current = new AbortController()
    pending.current = null
    starting.current = false
    opening.current = false
    stopPolling()
    currentUrl.current = null
    setPhase('idle')
    setAuthUrl(null)
    setError('')
    return controller.current.signal
  }, [stopPolling])

  const openAuthPage = useCallback(async (url: string, signal: AbortSignal) => {
    if (signal.aborted || opening.current) return
    stopPolling()
    opening.current = true
    currentUrl.current = url
    setAuthUrl(url)
    setError('')
    setPhase('opening')
    try {
      const result = await latest.current.open(url)
      if (!signal.aborted) setPhase(result === 'manual' ? 'authReady' : 'authorizing')
    } catch (err) {
      if (!signal.aborted) {
        setPhase('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (!signal.aborted) opening.current = false
    }
  }, [stopPolling])

  const refreshStatus = useCallback(async (force = false) => {
    const signal = controller.current.signal
    if (signal.aborted || pending.current === signal || starting.current || opening.current ||
      (!force && latest.current.paused) || document.visibilityState === 'hidden') return
    pending.current = signal
    try {
      const next = await latest.current.poll(signal)
      if (signal.aborted) return
      if (next.backendState === 'Running' || next.backendState === 'NeedsMachineAuth') {
        reset()
        return
      }
      const url = next.authUrl ?? null
      if (waiting.current) {
        // 回到前台时先读取权威状态：后台期间到达的链接优先于墙钟超时。
        if (url) {
          await openAuthPage(url, signal)
        } else if (Date.now() - startedAt.current >= latest.current.timeoutMs) {
          stopPolling()
          setPhase('error')
          setError(latest.current.timeoutMessage)
        }
      } else if (url !== currentUrl.current) {
        currentUrl.current = url
        setAuthUrl(url)
        setError('')
        setPhase(url ? 'authReady' : 'idle')
      }
    } catch (err) {
      if (signal.aborted) return
      latest.current.onPollError?.(err)
      if (waiting.current) {
        stopPolling()
        setPhase('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      // 旧请求不能释放新一代请求的单飞锁。
      if (pending.current === signal) pending.current = null
    }
  }, [openAuthPage, reset, stopPolling])

  const beginLogin = useCallback(async () => {
    if (starting.current || opening.current) return
    reset()
    const signal = controller.current.signal
    starting.current = true
    startedAt.current = Date.now()
    setPhase('starting')
    try {
      const next = await latest.current.start(signal)
      if (signal.aborted) return
      starting.current = false
      if (next.backendState === 'Running' || next.backendState === 'NeedsMachineAuth') {
        reset()
        return
      }
      if (next.authUrl) {
        await openAuthPage(next.authUrl, signal)
        return
      }
      waiting.current = true
      setPhase('waitingAuthUrl')
      timer.current = window.setInterval(() => void refreshStatus(), latest.current.pollMs)
      void refreshStatus()
    } catch (err) {
      if (!signal.aborted) {
        starting.current = false
        setPhase('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [openAuthPage, refreshStatus, reset])

  const reopenAuthPage = useCallback(async (url?: string) => {
    const target = url ?? currentUrl.current
    if (!target || opening.current || starting.current) return
    const signal = reset()
    await openAuthPage(target, signal)
  }, [openAuthPage, reset])

  const clearError = useCallback(() => setError(''), [])

  useEffect(() => {
    // StrictMode 会执行 setup → cleanup → setup，第二次 setup 需要新的取消标记。
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const signal = controller.current.signal
    if (statusPollMs !== undefined) queueMicrotask(() => { if (!signal.aborted) void refreshStatus() })
    const statusTimer = statusPollMs === undefined ? null : window.setInterval(() => void refreshStatus(), statusPollMs)
    const resume = () => {
      if (waiting.current || statusPollMs !== undefined) void refreshStatus()
    }
    document.addEventListener('visibilitychange', resume)
    return () => {
      controller.current.abort()
      stopPolling()
      if (statusTimer !== null) window.clearInterval(statusTimer)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [refreshStatus, statusPollMs, stopPolling])

  return { phase, authUrl, error, beginLogin, reopenAuthPage, reset, refreshStatus, clearError }
}
