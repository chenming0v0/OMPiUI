import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleCheck, Cloud, ExternalLink, Loader2, LogOut, Monitor, RefreshCw, ShieldCheck, TriangleAlert,
} from 'lucide-react'
import { DSH_REMOTE_ORIGIN, dshRecord } from '@ompiui/protocol/dsh-remote'
import { beginDshLogin, listDshLoginProviders, pollDshLogin, type DshAppConnection, type DshLoginProvider } from '../../../services/dshRemote'
import { closeDshRemoteViewer, onDshRemoteViewerClosed, openDshRemoteViewer } from '../../../utils/dshRemoteViewer'
import { getHttpFetch, isTauri, isTauriMobile } from '../../../utils/tauri'
import { serverStorage } from '../../../utils'
import { QrCode } from '../../../components/QrCode'
import { serverStore } from '../../../store/serverStore'
import { dshControllerStore, useDshController } from '../../../store/dshControllerStore'
import { useServerStore } from '../../../hooks'
import { AuthAlert, AuthStatusPill, ConnectionMethods, authPrimaryButtonClass, authSecondaryButtonClass, type AuthTone } from './AuthPanelUI'
import { settingsFieldClass } from './SettingsUI'

const primary = `${authPrimaryButtonClass} min-h-8 px-3 text-[length:var(--fs-xs)]`
const secondary = `${authSecondaryButtonClass} min-h-8 text-[length:var(--fs-xs)]`
const portal = `${DSH_REMOTE_ORIGIN}/app`
const HOST_POLL_MS = 5_000
const ROLE_KEY = 'ompiui-dsh-role'

async function openSite(url: string) {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

// The settings panel can close while the system browser still uses the lease.
// Kept outside React so the lease survives the panel unmounting.
class DshBrowserSession {
  private stop?: AbortController
  private unlisten?: () => void

  get busy(): boolean { return this.stop !== undefined }
  isCurrent(stop: AbortController): boolean { return this.stop === stop }
  begin(stop: AbortController): void { this.stop = stop }
  adopt(unlisten: () => void): void { this.unlisten = unlisten }

  async disconnect(): Promise<void> {
    this.stop?.abort()
    this.stop = undefined
    this.unlisten?.()
    this.unlisten = undefined
    const browser = dshControllerStore.get().browser
    dshControllerStore.update({ browser: null })
    browser?.close()
    await closeDshRemoteViewer().catch(() => undefined)
  }
}
const browserSession = new DshBrowserSession()
const disconnectBrowser = () => browserSession.disconnect()

/** 受控端 / 控制端共用的外壳：角色标签、标题说明、右侧状态。 */
function RemotePanel({ icon, role, title, description, status, testId, children }: {
  icon: React.ReactNode
  role: string
  title: string
  description: string
  status?: React.ReactNode
  testId: string
  children: React.ReactNode
}) {
  return (
    <section data-testid={testId} className="min-w-0 overflow-hidden rounded-xl border border-border-200/60 bg-bg-100">
      <header className="flex items-start gap-3 px-4 pt-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-main-100/10 text-accent-main-100">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded-full border border-border-200/60 bg-bg-200/60 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-text-400">
              {role}
            </span>
            <h3 className="text-[length:var(--fs-md)] font-medium leading-tight text-text-100">{title}</h3>
          </div>
          <p className="mt-1 text-[length:var(--fs-xs)] leading-relaxed text-text-400">{description}</p>
        </div>
        {status && <div className="shrink-0 pt-0.5">{status}</div>}
      </header>
      <div className="grid min-w-0 gap-4 p-4">{children}</div>
    </section>
  )
}

/** 带编号的引导步骤，避免用户面对一堆并列按钮猜流程。 */
function Step({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-3">
      <span aria-hidden className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-bg-200 text-[length:var(--fs-xs)] font-medium text-text-300">
        {index}
      </span>
      <div className="grid min-w-0 gap-1.5">
        <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{title}</div>
        {children}
      </div>
    </div>
  )
}

const toneDot: Record<'online' | 'offline', string> = {
  online: 'bg-success-100',
  offline: 'bg-text-500',
}

type DshRole = 'host' | 'controller'

export default function DshRemoteSettings({ onManage }: { onManage?: () => void }) {
  const { t } = useTranslation('settings')
  const desktop = isTauri()
  const mobile = isTauriMobile()
  const [role, setRole] = useState<DshRole>(() => serverStorage.get(ROLE_KEY) === 'controller' ? 'controller' : 'host')
  const switchRole = (next: DshRole) => {
    setRole(next)
    serverStorage.set(ROLE_KEY, next)
  }

  if (!desktop) {
    return (
      <RemotePanel icon={<Cloud size={18} />} role={t('dshRemote.controllerRole')} testId="dsh-remote-browser"
        title={t('dshRemote.browserTitle')} description={t('dshRemote.browserDescription')}>
        <p className="rounded-lg border border-dashed border-border-200 bg-bg-200/40 px-3 py-2.5 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
          {t('dshRemote.browserHint')}
        </p>
      </RemotePanel>
    )
  }

  // 手机只能当控制端：受控端要跑本机服务端。
  if (mobile) return <DshRemoteConnectSettings onManage={onManage} />

  return (
    <div className="grid min-w-0 gap-3">
      <ConnectionMethods<DshRole> selected={role} onChange={switchRole} options={[
        ['host', t('dshRemote.roleHost'), <Monitor size={14} />],
        ['controller', t('dshRemote.roleController'), <Cloud size={14} />],
      ]} />
      {role === 'host'
        ? <DshHostSettings />
        : <DshRemoteConnectSettings onManage={onManage} />}
    </div>
  )
}

// ============================================
// 受控端：让其他设备访问这台电脑
// ============================================

interface DshHostStatus {
  available: boolean
  reason?: 'loopback' | 'web' | null
  enabled: boolean
  registered: boolean
  deviceId: string | null
  state: 'unregistered' | 'disabled' | 'connecting' | 'online' | 'error' | 'stopped'
  lastError?: { code: string; message: string } | null
  updatedAt?: number
}

class HostRequestError extends Error {
  readonly code: string
  constructor(code: string, message = '') { super(message); this.code = code }
}

async function queryLocalHost(action?: 'register' | 'enable' | 'disable' | 'revoke', code?: string, signal?: AbortSignal): Promise<DshHostStatus> {
  const server = serverStore.getLocalServer()
  if (!server?.token) throw new HostRequestError('DSH_UNAVAILABLE')
  const address = new URL(server.url)
  if (!['http:', 'https:'].includes(address.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
    || address.username || address.password) {
    throw new HostRequestError('DSH_LOOPBACK_REQUIRED')
  }
  const fetch = await getHttpFetch()
  const options = {
    method: action ? 'POST' : 'GET', signal: signal ?? AbortSignal.timeout(20_000), redirect: 'error' as const, maxRedirections: 0,
    headers: { authorization: `Bearer ${server.token}`, ...(action ? { 'content-type': 'application/json' } : {}) },
    body: action ? JSON.stringify({ action, ...(code ? { code } : {}) }) : undefined,
  }
  const response = await fetch(new URL('/api/v1/host/dsh-remote', address).href, options)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = dshRecord(dshRecord(body)?.error)
    throw new HostRequestError(typeof error?.code === 'string' ? error.code : '', typeof error?.message === 'string' ? error.message : '')
  }
  return body as DshHostStatus
}

function DshHostSettings() {
  const { activeServerGeneration } = useServerStore()
  return <DshHostPanel key={activeServerGeneration} />
}

function DshHostPanel() {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<DshHostStatus>()
  const [unreachable, setUnreachable] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  const hostError = (code: string, message = '') =>
    t(`dshRemote.hostError.${code || 'default'}`, { defaultValue: message || t('dshRemote.hostError.default') })

  useEffect(() => {
    let stop = false
    let polling = false
    const abort = new AbortController()
    const load = async () => {
      if (polling || document.visibilityState === 'hidden') return
      polling = true
      try {
        const next = await queryLocalHost(undefined, undefined, AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]))
        if (!stop) { setStatus(next); setUnreachable(false) }
      } catch { if (!stop) { setStatus(undefined); setUnreachable(true) } }
      finally { polling = false }
    }
    void load()
    const timer = setInterval(load, HOST_POLL_MS)
    return () => { stop = true; abort.abort(); clearInterval(timer) }
  }, [])

  useEffect(() => { if (!confirmRevoke) return; const timer = setTimeout(() => setConfirmRevoke(false), 5_000); return () => clearTimeout(timer) }, [confirmRevoke])

  const manage = async (action: 'register' | 'enable' | 'disable' | 'revoke') => {
    setBusy(true)
    setError('')
    try {
      const next = await queryLocalHost(action, action === 'register' ? code.trim() : undefined)
      setStatus(next)
      if (action === 'register') setCode('')
      if (action === 'revoke') setConfirmRevoke(false)
    } catch (failure) {
      setError(failure instanceof HostRequestError
        ? hostError(failure.code, failure.message)
        : t('dshRemote.hostOperationFailed'))
    } finally { setBusy(false) }
  }

  const state = !status?.available
    ? 'unavailable'
    : (!status.registered ? 'unregistered' : status.state === 'stopped' && !status.enabled ? 'disabled' : status.state)
  const tone: AuthTone = state === 'online' ? 'success' : state === 'connecting' ? 'progress'
    : state === 'error' ? 'warning' : 'idle'
  const badge = !status
    ? t('dshRemote.hostLoading')
    : !status.available
      ? t('dshRemote.hostUnavailableShort')
      : state === 'unregistered'
        ? t('dshRemote.hostState.unregistered')
        : state === 'disabled'
          ? t('dshRemote.hostState.disabled')
          : t(`dshRemote.hostState.${state}`)

  const lastError = status?.lastError
  const unavailable = status?.reason === 'loopback' ? t('dshRemote.hostLoopbackOnly') : t('dshRemote.hostNoWeb')
  const message = !status
    ? undefined
    : !status.available
      ? unavailable
      : lastError ? hostError(lastError.code, lastError.message) : undefined

  return (
    <RemotePanel icon={<Monitor size={18} />} role={t('dshRemote.hostRole')} testId="dsh-remote-host"
      title={t('dshRemote.hostTitle')} description={t('dshRemote.hostDescription')}
      status={<AuthStatusPill tone={tone} role="status">{badge}</AuthStatusPill>}>
      {error && <AuthAlert>{error}</AuthAlert>}
      {!error && message && status?.available && state !== 'unregistered' && state !== 'disabled' && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warning-100/25 bg-warning-100/10 px-3 py-2 text-[length:var(--fs-xs)] leading-relaxed text-warning-100">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />{message}
        </p>
      )}

      {!status ? (
        unreachable ? (
          <p className="rounded-lg border border-dashed border-border-200 bg-bg-200/40 px-3 py-2.5 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
            {t('dshRemote.hostUnavailable')}
          </p>
        ) : (
          <div className="flex items-center gap-2 text-[length:var(--fs-xs)] text-text-400">
            <Loader2 size={13} className="animate-spin" />{t('dshRemote.hostLoading')}
          </div>
        )
      ) : !status.available ? (
        <p className="rounded-lg border border-dashed border-border-200 bg-bg-200/40 px-3 py-2.5 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
          {unavailable}
        </p>
      ) : !status.registered ? (
        <div className="grid gap-4">
          <Step index={1} title={t('dshRemote.stepPortal')}>
            <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('dshRemote.stepPortalDesc')}</p>
            <button type="button" className={`${secondary} w-fit`} onClick={() => void openSite(portal).catch(() => setError(t('dshRemote.portalFailed')))}>
              <ExternalLink size={12} />{t('dshRemote.portal')}
            </button>
          </Step>
          <Step index={2} title={t('dshRemote.stepBind')}>
            <form className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_auto] sm:items-center" onSubmit={event => { event.preventDefault(); if (!busy) void manage('register') }}>
              <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
                className={`${settingsFieldClass} font-mono uppercase tracking-[0.2em]`}
                placeholder="XXXX-XXXX" maxLength={9} aria-label={t('dshRemote.hostCode')}
                value={code} onChange={event => setCode(event.target.value.toUpperCase())} />
              <button type="submit" className={`${primary} w-fit`} disabled={busy || !/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code.trim())}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}{t('dshRemote.register')}
              </button>
            </form>
            <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('dshRemote.bindNote')}</p>
          </Step>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--fs-xs)] text-text-400">
            <span>{t('dshRemote.boundAs')}</span>
            {status.deviceId && <span className="font-mono text-text-500">{status.deviceId}</span>}
          </div>

          {state === 'disabled' && (
            <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('dshRemote.hostDisabledDesc')}</p>
          )}
          {state === 'online' && (
            <div className="flex items-start gap-2 rounded-lg border border-success-100/25 bg-success-100/10 px-3 py-2 text-[length:var(--fs-xs)] leading-relaxed text-success-100">
              <CircleCheck size={13} className="mt-0.5 shrink-0" />{t('dshRemote.hostOnlineDesc')}
            </div>
          )}
          {state === 'connecting' && (
            <p className="flex items-center gap-2 text-[length:var(--fs-xs)] text-text-400">
              <Loader2 size={13} className="animate-spin" />{t('dshRemote.hostConnectingDesc')}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={status.enabled ? secondary : primary} disabled={busy}
              onClick={() => void manage(status.enabled ? 'disable' : 'enable')}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : status.enabled ? null : <ShieldCheck size={12} />}
              {t(status.enabled ? 'dshRemote.disable' : 'dshRemote.enable')}
            </button>
            {confirmRevoke ? (
              <>
                <button type="button" className={`${secondary} text-danger-100`} disabled={busy} onClick={() => void manage('revoke')}>
                  {t('dshRemote.confirmRevoke')}
                </button>
                <button type="button" className={secondary} disabled={busy} onClick={() => setConfirmRevoke(false)}>
                  {t('dshRemote.cancel')}
                </button>
              </>
            ) : (
              <button type="button" className={`${secondary} text-text-400`} disabled={busy} onClick={() => setConfirmRevoke(true)}>
                {t('dshRemote.revoke')}
              </button>
            )}
          </div>
        </div>
      )}
    </RemotePanel>
  )
}

// ============================================
// 控制端：用这台电脑访问其他电脑
// ============================================

export function DshRemoteConnectSettings({ connectionRow = false, onManage }: { connectionRow?: boolean; onManage?: () => void }) {
  const { t } = useTranslation('settings')
  const { session, hosts, browser } = useDshController()
  const [providers, setProviders] = useState<DshLoginProvider[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providersError, setProvidersError] = useState(false)
  const [login, setLogin] = useState<{ id: string; url: string; expiresAt: number }>()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [pendingHost, setPendingHost] = useState('')
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
    if (!login) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [login])

  useEffect(() => {
    if (!login) return
    const abort = new AbortController()
    const stop = abort.signal
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
          setLogin(undefined)
          if (result === 'expired') setError(t('dshRemote.loginExpired'))
          else {
            dshControllerStore.update({ session: result, hosts: [] })
            onManage?.()
          }
        }
      } catch {
        if (!stop.aborted) { setLogin(undefined); setError(t('dshRemote.loginFailed')) }
      }
    }
    timer = setTimeout(check, 2_000)
    return () => { abort.abort(); clearTimeout(timer) }
  }, [login, onManage, t])

  useEffect(() => {
    if (!session) return
    const stop = new AbortController()
    void session.listHosts(AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]))
      .then(hosts => {
        if (!stop.signal.aborted && dshControllerStore.get().session === session) dshControllerStore.update({ hosts })
      })
      .catch(() => { if (!stop.signal.aborted) setError(t('dshRemote.hostListFailed')) })
    return () => stop.abort()
  }, [session, t])

  const signIn = async (provider: DshLoginProvider) => {
    setBusy(true)
    setError('')
    try {
      const next = await beginDshLogin(provider, AbortSignal.timeout(12_000))
      setNow(Date.now())
      setLogin(next)
      // The link/QR stays usable if the OS refuses to open the browser from the app.
      await openSite(next.url).catch(() => undefined)
    } catch { setError(t('dshRemote.loginFailed')) }
    finally { setBusy(false) }
  }

  const refreshHosts = async () => {
    if (!session) return
    setError('')
    setBusy(true)
    try {
      const next = await session.listHosts(AbortSignal.timeout(15_000))
      if (dshControllerStore.get().session === session) dshControllerStore.update({ hosts: next })
    } catch { setError(t('dshRemote.hostListFailed')) }
    finally { setBusy(false) }
  }

  const connect = async (hostId: string) => {
    if (!session || !hostId || browserSession.busy) return
    const stop = new AbortController()
    browserSession.begin(stop)
    setBusy(true)
    setPendingHost(hostId)
    setError('')
    let connection: DshAppConnection | undefined
    try {
      connection = await session.connect(hostId, stop.signal)
      const active = connection
      void active.closed.then(() => {
        if (browserSession.isCurrent(stop)) void disconnectBrowser()
      })
      const unlisten = await onDshRemoteViewerClosed(() => { if (browserSession.isCurrent(stop)) void disconnectBrowser() })
      if (!browserSession.isCurrent(stop)) { unlisten(); return }
      browserSession.adopt(unlisten)
      await openDshRemoteViewer(active.grant)
      if (browserSession.isCurrent(stop)) dshControllerStore.update({ browser: active })
      else await closeDshRemoteViewer()
    } catch (failure) {
      if (browserSession.isCurrent(stop)) {
        connection?.close()
        await disconnectBrowser()
        setError(connectError((failure as { code?: string })?.code ?? ''))
      }
    } finally { setBusy(false); setPendingHost('') }
  }

  const reopen = async () => {
    if (!browser) return
    setError('')
    try { await openDshRemoteViewer(browser.grant) }
    catch { setError(connectError('')) }
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
  const onlineHosts = useMemo(() => hosts.filter(host => host.online !== false).length, [hosts])

  const tone: AuthTone = browser ? 'progress' : session ? 'success' : 'idle'
  const badge = browser ? t('dshRemote.handoff') : session ? t('dshRemote.authorized') : t('dshRemote.notSignedIn')

  const loginView = login ? (
    <div className="grid gap-3 rounded-lg border border-border-200/60 bg-bg-200/30 p-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
      <div className="w-fit rounded-lg bg-bg-100 p-1.5"><QrCode text={login.url} size={132} /></div>
      <div className="grid min-w-0 gap-2">
        <p className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('dshRemote.waitingLogin')}</p>
        <p className="text-[length:var(--fs-xs)] text-text-400">{t('dshRemote.expiresIn', { time: clock })}</p>
        <div className="flex flex-wrap gap-2">
          <button className={primary} onClick={() => void openSite(login.url).catch(() => setError(t('dshRemote.loginFailed')))}>
            <ExternalLink size={12} />{t('dshRemote.openLogin')}
          </button>
          <button className={secondary} onClick={() => setLogin(undefined)}>{t('dshRemote.cancel')}</button>
        </div>
      </div>
    </div>
  ) : session ? null : providersLoading ? (
    <div className="flex items-center gap-2 text-[length:var(--fs-xs)] text-text-400">
      <Loader2 size={13} className="animate-spin" />{t('dshRemote.loginLoading')}
    </div>
  ) : providers.length ? (
    <div className="flex flex-wrap gap-2">
      {providers.map(provider => (
        <button key={provider.id} className={secondary} disabled={busy} onClick={() => void signIn(provider)}>{provider.label}</button>
      ))}
    </div>
  ) : (
    <div className="grid justify-items-start gap-2">
      {providersError && <p className="text-[length:var(--fs-xs)] text-text-400">{t('dshRemote.noProviders')}</p>}
      <button className={primary} disabled={busy} onClick={() => void discover()}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : null}{t('dshRemote.login')}
      </button>
    </div>
  )

  const signedInView = session ? (
    <>
      {browser ? (
        <div className="grid gap-2 rounded-lg border border-accent-main-100/25 bg-accent-main-100/5 p-3">
          <p className="flex items-center gap-2 text-[length:var(--fs-sm)] font-medium text-text-100">
            <CircleCheck size={14} className="shrink-0 text-success-100" />{t('dshRemote.connected')}
          </p>
          <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('dshRemote.connectedHint')}</p>
          <div className="flex flex-wrap gap-2">
            <button className={primary} onClick={() => void reopen()}>
              <ExternalLink size={12} />{t('dshRemote.openAgain')}
            </button>
            <button className={secondary} disabled={busy} onClick={() => void disconnectBrowser()}>{t('dshRemote.disconnect')}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--fs-xs)] text-text-400">
              {hosts.length ? t('dshRemote.hostsAvailable', { count: onlineHosts }) : t('dshRemote.hosts')}
            </span>
            <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200 hover:text-text-200 disabled:opacity-40"
              title={t('dshRemote.refresh')} aria-label={t('dshRemote.refresh')} disabled={busy} onClick={() => void refreshHosts()}>
              <RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />
            </button>
          </div>
          {hosts.length ? (
            <ul className="grid min-w-0 gap-1.5">
              {hosts.map(host => (
                <li key={host.id}>
                  <button type="button" disabled={busy || host.online === false}
                    className="group flex w-full min-w-0 items-center gap-3 rounded-lg border border-border-200/60 bg-bg-100 px-3 py-2.5 text-left transition-colors hover:border-border-300 hover:bg-bg-200/60 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void connect(host.id)}>
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${host.online === false ? toneDot.offline : toneDot.online}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--fs-sm)] text-text-100">{host.name}</span>
                      <span className="block text-[length:var(--fs-xs)] text-text-400">
                        {host.online === false ? t('dshRemote.offline') : t('dshRemote.online')}
                      </span>
                    </span>
                    {pendingHost === host.id
                      ? <Loader2 size={14} className="shrink-0 animate-spin text-text-400" />
                      : <span className="shrink-0 text-[length:var(--fs-xs)] text-accent-main-100 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{t('dshRemote.connect')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid gap-1 rounded-lg border border-dashed border-border-200 bg-bg-200/30 px-3 py-4">
              <p className="text-[length:var(--fs-sm)] text-text-300">{t('dshRemote.noHosts')}</p>
              <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('dshRemote.noHostsHint')}</p>
            </div>
          )}
        </>
      )}
    </>
  ) : null

  const content = (
    <>
      {error && <AuthAlert>{error}</AuthAlert>}
      {!session && !login && (
        <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('dshRemote.loginDesc')}</p>
      )}
      {loginView}
      {signedInView}
      {session && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-200/60 pt-3">
          {!connectionRow && onManage
            ? <button className={`${secondary} text-text-400`} onClick={onManage}>{t('dshRemote.manageConnection')}</button>
            : <span />}
          <button className={`${secondary} text-text-400`} disabled={busy} onClick={() => void revoke()}>
            <LogOut size={12} />{t('dshRemote.logout')}
          </button>
        </div>
      )}
    </>
  )

  if (connectionRow) return <div className="grid min-w-0 gap-3 border-t border-border-200/60 px-3 py-3">{content}</div>
  return (
    <RemotePanel icon={<Cloud size={18} />} role={t('dshRemote.controllerRole')} testId="dsh-remote-client"
      title={t('dshRemote.clientTitle')} description={t('dshRemote.clientDescription')}
      status={<AuthStatusPill tone={tone} role="status">{badge}</AuthStatusPill>}>
      {content}
    </RemotePanel>
  )
}
