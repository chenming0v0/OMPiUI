import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ExternalLink, Loader2, LogOut, RefreshCw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { beginDshLogin, isDshControllerAuthFailure, listDshLoginProviders, pollDshLogin, type DshAppConnection, type DshAppSession, type DshLoginProvider } from '../../../services/dshRemote'
import { closeDshRemoteViewer, watchDshRemoteViewer, openDshRemoteViewer } from '../../../utils/dshRemoteViewer'
import { isTauriMobile } from '../../../utils/tauri'
import { QrCode } from '../../../components/QrCode'
import { DeepSeekIcon } from '../../../components/Icons'
import { serviceStore } from '../../../store/serviceStore'
import { dshControllerStore, useDshController } from '../../../store/dshControllerStore'
import { AuthAlert } from './AuthPanelUI'
import { Lamp, NextAction, PanelRow, PanelSplit } from './ChannelBoard'

async function openSite(url: string, signal?: AbortSignal) {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  signal?.throwIfAborted()
  await openUrl(url)
}

// The settings panel can unmount while the browser still uses the lease.
interface BrowserAttempt {
  id: string
  stop: AbortController
  handoffStop: AbortController
  connection?: DshAppConnection
  unlisten?: () => void
}
let browserAttempt: BrowserAttempt | undefined
let loginAttempt: AbortController | undefined
let releasingBrowser: Promise<void> | undefined

function beginBrowserAttempt(): BrowserAttempt | undefined {
  if (browserAttempt) return
  browserAttempt = { id: crypto.randomUUID(), stop: new AbortController(), handoffStop: new AbortController() }
  return browserAttempt
}

function beginLoginAttempt(): AbortController {
  loginAttempt?.abort()
  return loginAttempt = new AbortController()
}

function finishLoginAttempt(stop: AbortController): void {
  if (loginAttempt === stop) loginAttempt = undefined
}

async function disconnectBrowser(ended = false): Promise<void> {
  const active = browserAttempt
  const browser = dshControllerStore.get().browser
  browserAttempt = undefined
  dshControllerStore.update({ browser: ended && browser ? { ...browser, phase: 'ended' } : null })
  if (!active) { await releasingBrowser; return }
  active.handoffStop.abort()
  active.unlisten?.()
  const release = (async () => {
    // A live lease must be given a chance to send the close RPC before aborting its socket.
    if (active.connection) await active.connection.close()
    active.stop.abort()
    await closeDshRemoteViewer(active.id).catch(() => undefined)
  })()
  releasingBrowser = release
  try { await release } finally { if (releasingBrowser === release) releasingBrowser = undefined }
}

function handleControllerFailure(session: DshAppSession, failure: unknown): boolean {
  if (!isDshControllerAuthFailure(failure) || dshControllerStore.get().session !== session) return false
  session.invalidate()
  void disconnectBrowser()
  dshControllerStore.update({ session: null, hosts: [], authError: failure.code })
  return true
}

async function loadControllerHosts(session: DshAppSession, signal: AbortSignal) {
  const local = isTauriMobile() ? null : await invoke<string | null>('dsh_remote_local_host_id', { envVars: serviceStore.envVarsRecord })
  signal.throwIfAborted()
  return session.listHosts(signal, local)
}

/**
 * 打开一台电脑：向它申请网页租约，再把一次性授权交给系统浏览器。
 * 成功或已被别的流程接管时返回 null，失败时返回错误码（空串表示没有具体错误码）。
 */
async function openHost(session: DshAppSession, hostId: string): Promise<string | null> {
  const active = beginBrowserAttempt()
  if (!active) return null
  dshControllerStore.update({ browser: { hostId, phase: 'opening' } })
  try {
    await releasingBrowser
    active.stop.signal.throwIfAborted()
    const connection = await session.connect(hostId, active.stop.signal)
    if (browserAttempt !== active) { await connection.close(); return null }
    active.connection = connection
    void connection.closed.then(({ error }) => {
      if (browserAttempt !== active) return
      if (!handleControllerFailure(session, error)) void disconnectBrowser(true)
    })
    const unlisten = await watchDshRemoteViewer(active.id, {
      closed: () => { if (browserAttempt === active) void disconnectBrowser(true) },
      delivered: () => { if (browserAttempt === active) dshControllerStore.update({ browser: { hostId, phase: 'delivered' } }) },
    })
    if (browserAttempt !== active) { unlisten(); return null }
    active.unlisten = unlisten
    await openDshRemoteViewer(active.id, connection.grant, active.handoffStop.signal)
    if (browserAttempt === active && dshControllerStore.get().browser?.phase === 'opening') {
      dshControllerStore.update({ browser: { hostId, phase: 'opened' } })
    }
    return null
  } catch (failure) {
    if (browserAttempt !== active || handleControllerFailure(session, failure)) return null
    void disconnectBrowser()
    return (failure as { code?: string })?.code ?? ''
  }
}

/** 登录后读取账号下的电脑。控制端面板和服务器页都靠它保持列表是新的。 */
function useDshHosts() {
  const { session } = useDshController()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!session) return
    const stop = new AbortController()
    void loadControllerHosts(session, AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]))
      .then(hosts => {
        if (!stop.signal.aborted && dshControllerStore.get().session === session) dshControllerStore.update({ hosts })
      })
      .catch(failure => { if (!stop.signal.aborted && !handleControllerFailure(session, failure)) setFailed(true) })
    return () => stop.abort()
  }, [session])

  const refresh = async () => {
    if (!session) return
    setFailed(false)
    setBusy(true)
    try {
      const next = await loadControllerHosts(session, AbortSignal.timeout(15_000))
      if (dshControllerStore.get().session === session) dshControllerStore.update({ hosts: next })
    } catch (failure) { if (!handleControllerFailure(session, failure)) setFailed(true) }
    finally { setBusy(false) }
  }
  return { busy, failed: failed && Boolean(session), refresh }
}

// ============================================
// 控制端 → DS 远程：登录账号，看到账号下的电脑
// ============================================

export function DshRemoteConnectSettings({ onOpenServers }: { onOpenServers?: () => void }) {
  const { t } = useTranslation('settings')
  const { session, hosts, authError } = useDshController()
  const hostList = useDshHosts()
  const [providers, setProviders] = useState<DshLoginProvider[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providersError, setProvidersError] = useState(false)
  const [login, setLogin] = useState<{ id: string; url: string; expiresAt: number; attempt: AbortController }>()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const connectError = (code: string) => t(`dshRemote.connectError.${code || 'default'}`, { defaultValue: t('dshRemote.connectError.default') })

  const discover = useCallback(async () => {
    setProvidersError(false)
    setProvidersLoading(true)
    try {
      const next = await listDshLoginProviders(AbortSignal.timeout(12_000))
      setProviders(next)
      if (!next.length) setProvidersError(true)
    } catch { setProviders([]); setProvidersError(true) }
    finally { setProvidersLoading(false) }
  }, [])

  useEffect(() => { if (!session && !login) void discover() }, [session, login, discover])

  useEffect(() => {
    dshControllerStore.update({ signingIn: Boolean(login) })
    return () => dshControllerStore.update({ signingIn: false })
  }, [login])

  useEffect(() => {
    if (!login) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1_000)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [login])

  useEffect(() => {
    if (!login) return
    const abort = new AbortController()
    const stop = AbortSignal.any([abort.signal, login.attempt.signal])
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const result = Date.now() >= login.expiresAt ? 'expired' : await pollDshLogin(login.id, stop)
        if (stop.aborted) {
          if (typeof result !== 'string') await result.revoke().catch(() => undefined)
          return
        }
        if (result === 'pending') timer = setTimeout(check, 2_000)
        else {
          finishLoginAttempt(login.attempt)
          setLogin(undefined)
          if (result === 'expired') setError(t('dshRemote.loginExpired'))
          else dshControllerStore.update({ session: result, hosts: [], authError: null })
        }
      } catch {
        if (!stop.aborted) { finishLoginAttempt(login.attempt); setLogin(undefined); setError(t('dshRemote.loginFailed')) }
      }
    }
    timer = setTimeout(check, 2_000)
    return () => { abort.abort(); clearTimeout(timer) }
  }, [login, t])

  const signIn = async (provider: DshLoginProvider) => {
    const stop = beginLoginAttempt()
    setBusy(true)
    setError('')
    dshControllerStore.update({ authError: null })
    let started = false
    try {
      const next = await beginDshLogin(provider, AbortSignal.any([stop.signal, AbortSignal.timeout(12_000)]))
      stop.signal.throwIfAborted()
      started = true
      setLogin({ ...next, attempt: stop })
      await openSite(next.url, stop.signal).catch(() => undefined)
    } catch { if (!stop.signal.aborted) setError(t('dshRemote.loginFailed')) }
    finally { if (!started) finishLoginAttempt(stop); setBusy(false) }
  }

  const revoke = async () => {
    if (!session) return
    setBusy(true)
    setError('')
    try {
      await disconnectBrowser()
      await session.revoke()
      if (dshControllerStore.get().session === session) dshControllerStore.update({ session: null, hosts: [] })
    } catch { setError(t('dshRemote.logoutFailed')) }
    finally { setBusy(false) }
  }

  const remaining = login ? Math.max(0, Math.floor((login.expiresAt - now) / 1000)) : 0
  const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
  const alert = error || (authError ? connectError(authError) : '') || (hostList.failed ? t('dshRemote.hostListFailed') : '')

  let body: React.ReactNode
  if (session) {
    body = <>
      <div className="cb-list">
        <div className="cb-list-head">
          <span className="cb-row-title">{t('controller.dshComputers')}</span>
          <button type="button" className="cb-link" disabled={hostList.busy} onClick={() => void hostList.refresh()}>
            <RefreshCw size={12} className={hostList.busy ? 'animate-spin' : undefined} />{t('dshRemote.refresh')}
          </button>
        </div>
        {hosts.length ? hosts.map(host => (
          <div key={host.id} className="cb-device" data-dim={host.online === false ? '' : undefined}>
            <Lamp tone={host.online === true ? 'on' : 'off'} />
            <span className="cb-device-main">
              <span className="cb-device-name">{host.name}</span>
              <span className="cb-device-meta">
                {t(host.online === true ? 'dshRemote.online' : host.online === false ? 'dshRemote.offline' : 'dshRemote.unknown')}
              </span>
            </span>
          </div>
        )) : (
          <div className="cb-empty">
            <p>{t('dshRemote.noHosts')}</p>
            <p className="cb-hint mt-1">{t('dshRemote.noHostsHint')}</p>
          </div>
        )}
        {hosts.length > 0 && (
          <p className="cb-hint">
            {t('controller.dshUseInServers')}{' '}
            {onOpenServers && (
              <button type="button" className="cb-link" onClick={onOpenServers}>{t('controller.openServers')}<ChevronRight size={13} /></button>
            )}
          </p>
        )}
      </div>
      <PanelSplit>
        <PanelRow title={t('controller.dshAccount')} hint={t('controller.dshAccountHint')}>
          <button type="button" className="cb-btn" disabled={busy} onClick={() => void revoke()}>
            <LogOut size={14} />{t('dshRemote.logout')}
          </button>
        </PanelRow>
      </PanelSplit>
    </>
  } else if (login) {
    body = (
      <div className="cb-login">
        <div className="cb-qr"><QrCode text={login.url} size={140} /></div>
        <div className="min-w-0">
          <h3 className="text-[length:var(--fs-base)] font-semibold leading-snug text-text-100">{t('controller.dshScanTitle')}</h3>
          <p className="mt-1 text-[length:var(--fs-sm)] leading-relaxed text-text-200">
            {t('dshRemote.waitingLogin')} {t('dshRemote.expiresIn', { time: clock })}
          </p>
          <div className="cb-actions">
            <button type="button" className="cb-btn" onClick={() => void openSite(login.url, login.attempt.signal).catch(() => setError(t('dshRemote.loginFailed')))}>
              <ExternalLink size={14} />{t('dshRemote.openLogin')}
            </button>
            <button type="button" className="cb-btn" onClick={() => { login.attempt.abort(); finishLoginAttempt(login.attempt); setLogin(undefined) }}>
              {t('dshRemote.cancel')}
            </button>
          </div>
        </div>
      </div>
    )
  } else {
    body = (
      <NextAction icon={<DeepSeekIcon size={18} />} title={t('controller.dshLoginTitle')}
        actions={providersLoading ? (
          <span className="cb-hint flex items-center gap-2"><Loader2 size={13} className="animate-spin" />{t('dshRemote.loginLoading')}</span>
        ) : providers.length ? providers.map((provider, index) => (
          <button key={provider.id} type="button" className="cb-btn" data-variant={index === 0 ? 'primary' : undefined}
            disabled={busy} onClick={() => void signIn(provider)}>
            {t('controller.dshLoginWith', { provider: provider.label })}
          </button>
        )) : (
          <button type="button" className="cb-btn" data-variant="primary" disabled={busy} onClick={() => void discover()}>
            {t('dshRemote.login')}
          </button>
        )}>
        <p>{t('dshRemote.loginDesc')}</p>
        {providersError && !providersLoading && <p className="mt-1">{t('dshRemote.noProviders')}</p>}
      </NextAction>
    )
  }

  return (
    <div data-testid="dsh-remote-client" className="min-w-0">
      {alert && <div className="mb-4"><AuthAlert>{alert}</AuthAlert></div>}
      {body}
    </div>
  )
}

// ============================================
// 服务器页：账号下的电脑。它们跟着登录状态走，不落盘。
// ============================================

export function DshServerRows() {
  const { t } = useTranslation('settings')
  const { session, hosts, browser } = useDshController()
  useDshHosts()
  const [error, setError] = useState<{ hostId: string; text: string } | null>(null)
  const live = useMemo(() => Boolean(browser && browser.phase !== 'ended'), [browser])
  if (!session || !hosts.length) return null

  const open = async (hostId: string) => {
    setError(null)
    // A browser grant is single-use: release the old lease and allocate a new one.
    if (browser) void disconnectBrowser()
    const code = await openHost(session, hostId)
    if (code !== null) {
      setError({ hostId, text: t(`dshRemote.connectError.${code || 'default'}`, { defaultValue: t('dshRemote.connectError.default') }) })
    }
  }

  return <>
    {hosts.map(host => {
      const handoff = browser?.hostId === host.id ? browser : null
      return (
        <div key={host.id} className="cb-srv" data-testid="dsh-server-row">
          <Lamp tone={host.online === true ? 'on' : 'off'} />
          <div className="cb-srv-main">
            <span className="cb-srv-title">
              <span className="cb-srv-name" title={host.name}>{host.name}</span>
              <span className="cb-via"><DeepSeekIcon size={11} />{t('servers.via.dsh')}</span>
            </span>
            <span className="cb-srv-meta">
              <span role={handoff ? 'status' : undefined}>
                {handoff
                  ? t(`dshRemote.handoffState.${handoff.phase}`)
                  : t(host.online === true ? 'dshRemote.online' : host.online === false ? 'dshRemote.offline' : 'dshRemote.unknown')}
              </span>
            </span>
          </div>
          <div className="cb-srv-actions gap-1.5">
            {handoff ? <>
              <button type="button" className="cb-btn" data-size="sm" disabled={handoff.phase === 'opening'} onClick={() => void open(host.id)}>
                {handoff.phase === 'opening' ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}{t('dshRemote.openAgain')}
              </button>
              <button type="button" className="cb-btn" data-size="sm" onClick={() => void disconnectBrowser()}>
                {t(handoff.phase === 'ended' ? 'dshRemote.cancel' : 'dshRemote.disconnect')}
              </button>
            </> : (
              <button type="button" className="cb-btn" data-size="sm" disabled={host.online === false || live} onClick={() => void open(host.id)}>
                <ExternalLink size={12} />{t('dshRemote.connect')}
              </button>
            )}
          </div>
          {handoff && (handoff.phase === 'opened' || handoff.phase === 'delivered') && (
            <p className="cb-srv-extra cb-hint">{t('dshRemote.connectedHint')}</p>
          )}
          {error?.hostId === host.id && <div className="cb-srv-extra"><AuthAlert>{error.text}</AuthAlert></div>}
        </div>
      )
    })}
  </>
}
