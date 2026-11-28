import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TailscaleInfo } from '@ompiui/protocol'
import { disconnectTailscale, fetchTailscale, startTailscaleLogin } from '../../../omp/transport/index.js'
import { useTailscaleLoginFlow } from '../../../hooks/useTailscaleLoginFlow'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'
import { isTauri } from '../../../utils/tauri'
import { TailscaleControls } from './TailscaleControls'
import type { LampTone } from './ChannelBoard'

const STATUS_POLL_MS = 5_000

/**
 * 当前后端内置的虚拟组网节点：状态、登录流程和控件。
 * 有运行时的时候它在「被控端」，没有的时候在「控制端」，两处共用这一份。
 */
export function useBackendTailscale() {
  const { t } = useTranslation('settings')
  const [tailscale, setTailscale] = useState<TailscaleInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const poll = async (signal: AbortSignal) => {
    const next = await fetchTailscale(signal)
    if (!signal.aborted) {
      setTailscale(next)
      setStatusError('')
    }
    return { backendState: next.backendState, authUrl: next.authUrl ?? null }
  }
  const flow = useTailscaleLoginFlow({
    start: async signal => {
      const result = await startTailscaleLogin()
      if (signal.aborted) return {}
      // POST 已给出链接时立刻打开，不让后续 GET 的延迟或失败拦住授权。
      if (result.authUrl) return { authUrl: result.authUrl }
      return poll(signal)
    },
    poll,
    open: openTailscaleLogin,
    timeoutMessage: t('service.remoteTailscaleAuthUrlTimeout'),
    connectionTimeoutMessage: t('service.remoteTailscaleConnectionTimeout'),
    statusPollMs: STATUS_POLL_MS,
    paused: busy,
    onPollError: err => setStatusError(err instanceof Error ? err.message : String(err)),
  })

  const disconnect = () => {
    const signal = flow.reset()
    setBusy(true)
    setError('')
    void (async () => {
      await disconnectTailscale()
      if (!signal.aborted) await flow.refreshStatus(true)
    })()
      .catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (mounted.current) setBusy(false) })
  }

  const running = !statusError && tailscale?.backendState === 'Running'
  const approval = tailscale?.backendState === 'NeedsMachineAuth'
  const waiting = flow.phase !== 'idle' && flow.phase !== 'error'
  // 上次登录过：后端启动后先自动恢复连接。
  const restoring = Boolean(tailscale?.enabled && (tailscale.backendState === 'Starting' || tailscale.backendState === 'NoState'))
    || flow.phase === 'connecting'
  const tile: { tone: LampTone; state: string } = running
    ? { tone: 'on', state: tailscale?.ips[0] ?? t('host.connected') }
    : approval
      ? { tone: 'warn', state: t('host.tsApproval') }
      : restoring
        ? { tone: 'busy', state: t('host.tsRestoring') }
        : waiting
          ? { tone: 'busy', state: t('host.tsAuthorizing') }
          : !tailscale
            ? (statusError ? { tone: 'off', state: t('host.unavailable') } : { tone: 'busy', state: t('host.loading') })
            : { tone: 'off', state: t('host.tsSignedOut') }

  const controls = (options: { inline?: boolean; hideStatus?: boolean; layout?: 'default' | 'phone' } = {}) => tailscale && (
    <TailscaleControls state={tailscale.backendState}
      authUrl={flow.authUrl}
      ips={tailscale.ips}
      enabled={tailscale.enabled} available={tailscale.mode === 'embedded' && tailscale.installed}
      busy={busy} error={error || statusError || flow.error || tailscale.lastError}
      authPhase={flow.phase} authLinkMode={!isTauri()} showAuthQr={false} {...options}
      onAuthLinkClick={() => { setError(''); flow.clearError() }}
      onOpenAuthUrl={url => { setError(''); void flow.reopenAuthPage(url) }}
      onLogin={() => { setError(''); void flow.beginLogin() }}
      onDisconnect={disconnect} />
  )

  return { tailscale, statusError, running, approval, waiting, restoring, busy, tile, disconnect, controls }
}
