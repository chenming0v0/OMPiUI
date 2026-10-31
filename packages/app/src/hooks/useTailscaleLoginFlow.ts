import { useCallback, useEffect, useRef, useState } from 'react'

export type TailscaleAuthPhase = 'idle' | 'starting' | 'waitingAuthUrl' | 'authorizing' | 'error'

export type TailscaleAuthSnapshot = { backendState?: string | null; authUrl?: string | null }

type Options = {
  start: () => Promise<TailscaleAuthSnapshot>
  poll: () => Promise<TailscaleAuthSnapshot>
  open: (url: string) => Promise<void>
  timeoutMessage: string
  pollMs?: number
  timeoutMs?: number
}

/**
 * 登录流程状态机：点击登录后 busy 一直可见，直到拿到授权链接打开浏览器或超时报错。
 * 授权链接出现是异步的（tsnet / 内嵌桥先发起登录，稍后 status 里才有 AuthURL），
 * 所以这里用短轮询等待，而不是把点击立即还给上一次轮询。
 */
export function useTailscaleLoginFlow({ start, poll, open, timeoutMessage, pollMs = 1_000, timeoutMs = 30_000 }: Options) {
  const [phase, setPhase] = useState<TailscaleAuthPhase>('idle')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const latest = useRef({ start, poll, open, timeoutMessage, pollMs, timeoutMs })
  useEffect(() => {
    latest.current = { start, poll, open, timeoutMessage, pollMs, timeoutMs }
  })
  const timer = useRef<number | null>(null)
  const startedAt = useRef(0)
  const visibilityPoll = useRef<() => void>(() => {})

  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    document.removeEventListener('visibilitychange', visibilityPoll.current)
  }, [])

  const pollOnce = useCallback(async () => {
    if (timer.current === null || document.visibilityState === 'hidden') return
    if (Date.now() - startedAt.current >= latest.current.timeoutMs) {
      stopPolling()
      setPhase('error')
      setError(latest.current.timeoutMessage)
      return
    }
    try {
      const next = await latest.current.poll()
      const url = next.authUrl ?? null
      if (!url) return
      stopPolling()
      setAuthUrl(url)
      setPhase('authorizing')
      try {
        await latest.current.open(url)
      } catch (err) {
        setPhase('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    } catch (err) {
      stopPolling()
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [stopPolling])

  // 页面隐藏时系统会停掉定时器节奏，回到前台立即补一次，避免授权链接白白等一个周期。
  useEffect(() => {
    visibilityPoll.current = () => {
      if (document.visibilityState === 'visible') void pollOnce()
    }
  }, [pollOnce])

  const reset = useCallback(() => {
    stopPolling()
    startedAt.current = 0
    setPhase('idle')
    setAuthUrl(null)
    setError('')
  }, [stopPolling])

  const beginLogin = useCallback(async () => {
    stopPolling()
    startedAt.current = Date.now()
    setPhase('starting')
    setAuthUrl(null)
    setError('')
    try {
      const next = await latest.current.start()
      if (next.backendState === 'Running') {
        reset()
        return
      }
      const url = next.authUrl ?? null
      if (url) {
        setAuthUrl(url)
        setPhase('authorizing')
        try {
          await latest.current.open(url)
        } catch (err) {
          setPhase('error')
          setError(err instanceof Error ? err.message : String(err))
        }
        return
      }
      setPhase('waitingAuthUrl')
      timer.current = window.setInterval(() => void pollOnce(), latest.current.pollMs)
      document.addEventListener('visibilitychange', visibilityPoll.current)
      void pollOnce()
    } catch (err) {
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [pollOnce, reset, stopPolling])

  const reopenAuthPage = useCallback(async (url?: string) => {
    // 优先用调用方传入的链接：授权链接可能来自状态轮询，而不一定是本次流程拿到的。
    const target = url ?? authUrl
    if (!target) return
    setError('')
    try {
      await latest.current.open(target)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [authUrl])

  useEffect(() => stopPolling, [stopPolling])

  return { phase, authUrl, error, beginLogin, reopenAuthPage, reset }
}
