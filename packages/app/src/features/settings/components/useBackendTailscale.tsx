import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TailscaleInfo } from '@ompiui/protocol'
import { disconnectTailscale, fetchTailscale, startTailscaleLogin } from '../../../omp/transport/index.js'
import { useTailscaleLoginFlow } from '../../../hooks/useTailscaleLoginFlow'
import { serverStore } from '../../../store/serverStore'
import {
  disconnectDesktopTailscale, fetchDesktopTailscale, isDesktopTailscalePlatform,
  refreshDesktopTailscaleRoutes, startDesktopTailscaleLogin,
} from '../../../utils/desktopTailscale'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'
import { isTauri } from '../../../utils/tauri'
import { TailscaleControls } from './TailscaleControls'
import type { LampTone } from './ChannelBoard'

const STATUS_POLL_MS = 5_000

const activeBackend = { fetch: fetchTailscale, login: startTailscaleLogin, disconnect: disconnectTailscale }
const localBackend = { fetch: fetchDesktopTailscale, login: startDesktopTailscaleLogin, disconnect: disconnectDesktopTailscale }

/**
 * 后端内置的虚拟组网节点：状态、登录流程和控件。
 * 「被控端」操作当前连着的后端（active）；桌面「控制端」固定操作本机后端（local），
 * 因为向外连接用的是这台电脑自己的节点。
 */
export function useBackendTailscale(target: 'active' | 'local' = 'active') {
  const { t } = useTranslation('settings')
  const api = target === 'local' ? localBackend : activeBackend
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
    const next = await api.fetch(signal)
    if (!signal.aborted) {
      setTailscale(next)
      setStatusError('')
    }
    return { backendState: next.backendState, authUrl: next.authUrl ?? null }
  }
  const flow = useTailscaleLoginFlow({
    start: async signal => {
      const result = await api.login()
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
      await api.disconnect()
      if (!signal.aborted) await flow.refreshStatus(true)
    })()
      .catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (mounted.current) setBusy(false) })
  }

  // 桌面版向外连接走本机节点：它登录或退出后，已保存的 Tailnet 服务器要立刻换路由并重新探测。
  const drivesLocalNode = isDesktopTailscalePlatform() && (target === 'local' || serverStore.isActiveLocalServer())
  const nodeRunning = tailscale ? tailscale.backendState === 'Running' : null
  const lastNodeRunning = useRef<boolean | null>(null)
  useEffect(() => {
    if (!drivesLocalNode || nodeRunning === null) return
    if (lastNodeRunning.current !== null && lastNodeRunning.current !== nodeRunning) refreshDesktopTailscaleRoutes(nodeRunning)
    lastNodeRunning.current = nodeRunning
  }, [drivesLocalNode, nodeRunning])

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
