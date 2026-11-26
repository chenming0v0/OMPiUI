import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleCheck, Cloud, ExternalLink, Loader2, LogOut, Monitor, RefreshCw, ShieldCheck, TriangleAlert,
} from 'lucide-react'
import { DSH_REMOTE_ORIGIN } from '@ompiui/protocol/dsh-remote'
import { beginDshLogin, isDshControllerAuthFailure, listDshLoginProviders, pollDshLogin, type DshAppConnection, type DshAppSession, type DshLoginProvider } from '../../../services/dshRemote'
import { closeDshRemoteViewer, watchDshRemoteViewer, openDshRemoteViewer } from '../../../utils/dshRemoteViewer'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { serverStorage } from '../../../utils'
import { QrCode } from '../../../components/QrCode'
import { serviceStore } from '../../../store/serviceStore'
import { dshControllerStore, useDshController } from '../../../store/dshControllerStore'
import { useServerStore } from '../../../hooks'
import { AuthAlert, AuthStatusPill, ConnectionMethods, authPrimaryButtonClass, authSecondaryButtonClass, type AuthTone } from './AuthPanelUI'
import { settingsFieldClass } from './SettingsUI'

const primary = `${authPrimaryButtonClass} min-h-8 px-3 text-[length:var(--fs-xs)]`
const secondary = `${authSecondaryButtonClass} min-h-8 text-[length:var(--fs-xs)]`
const portal = `${DSH_REMOTE_ORIGIN}/app`
const HOST_POLL_MS = 5_000
const ROLE_KEY = 'ompiui-dsh-role'

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
  const { browser } = useDshController()
  const [role, setRole] = useState<DshRole>(() => serverStorage.get(ROLE_KEY) === 'controller' ? 'controller' : 'host')
  const switchRole = (next: DshRole) => {
    if (role === 'controller' && next === 'host') {
      loginAttempt?.abort()
      if (dshControllerStore.get().browser?.phase === 'opening') void disconnectBrowser()
    }
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
        ? <>
          <DshHostSettings />
          {browser && browser.phase !== 'opening' && (
            <div className="flex items-center justify-between gap-2">
              <span role="status">{t(`dshRemote.handoffState.${browser.phase}`)}</span>
              {browser.phase !== 'ended' && <button className={secondary} onClick={() => void disconnectBrowser()}>{t('dshRemote.disconnect')}</button>}
            </div>
          )}
        </>
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

type HostAction = 'register' | 'enable' | 'disable' | 'revoke' | 'reset'
async function queryLocalHost(action?: HostAction, code?: string): Promise<DshHostStatus> {
  const response = await invoke<{ status?: DshHostStatus; error?: { code: string; message?: string } }>('dsh_remote_host_manage', {
    envVars: serviceStore.envVarsRecord, action, code,
  })
  if (!response.status) throw new HostRequestError(response.error?.code ?? 'DSH_UNAVAILABLE', response.error?.message)
  return response.status
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
    const load = async () => {
      if (polling || document.visibilityState === 'hidden') return
      polling = true
      try {
        const next = await queryLocalHost()
        if (!stop) { setStatus(next); setUnreachable(false) }
      } catch (error) {
        if (!stop) {
          setStatus(error instanceof HostRequestError && error.code === 'DSH_LOOPBACK_REQUIRED'
            ? { available: false, reason: 'loopback', enabled: false, registered: false, deviceId: null, state: 'unregistered' } : undefined)
          setUnreachable(true)
        }
      }
      finally { polling = false }
    }
    void load()
    const timer = setInterval(load, HOST_POLL_MS)
    return () => { stop = true; clearInterval(timer) }
  }, [])

  useEffect(() => { if (!confirmRevoke) return; const timer = setTimeout(() => setConfirmRevoke(false), 5_000); return () => clearTimeout(timer) }, [confirmRevoke])

  const manage = async (action: HostAction) => {
    setBusy(true)
    setError('')
    try {
      const next = await queryLocalHost(action, action === 'register' ? code.trim() : undefined)
      setStatus(next)
      if (action === 'register') setCode('')
      if (action === 'revoke' || action === 'reset') setConfirmRevoke(false)
    } catch (failure) {
      setError(failure instanceof HostRequestError
        ? hostError(failure.code, failure.message)
        : t('dshRemote.hostOperationFailed'))
    } finally { setBusy(false) }
  }

  const unreadable = status?.lastError?.code === 'DSH_STATE_UNREADABLE'
  const state = unreadable ? 'error' : !status?.available
    ? 'unavailable'
    : (!status.registered ? 'unregistered' : status.state === 'stopped' && !status.enabled ? 'disabled' : status.state)
  const tone: AuthTone = state === 'online' ? 'success' : state === 'connecting' ? 'progress'
    : state === 'error' ? 'warning' : 'idle'
  const badge = !status
    ? t('dshRemote.hostLoading')
    : !status.available && !unreadable
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
    : !status.available && !unreadable
      ? unavailable
      : lastError ? hostError(lastError.code, lastError.message) : undefined

  return (
    <RemotePanel icon={<Monitor size={18} />} role={t('dshRemote.hostRole')} testId="dsh-remote-host"
      title={t('dshRemote.hostTitle')} description={t('dshRemote.hostDescription')}
      status={<AuthStatusPill tone={tone} role="status">{badge}</AuthStatusPill>}>
      {error && <AuthAlert>{error}</AuthAlert>}
      {!error && message && (status?.available || unreadable) && state !== 'unregistered' && state !== 'disabled' && (
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
      ) : unreadable ? (
        <button type="button" className={`${secondary} w-fit`} disabled={busy}
          onClick={() => confirmRevoke ? void manage('reset') : setConfirmRevoke(true)}>
          {t(confirmRevoke ? 'dshRemote.confirmReset' : 'dshRemote.resetBinding')}
        </button>
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

async function loadControllerHosts(session: DshAppSession, signal: AbortSignal) {
  const local = isTauriMobile() ? null : await invoke<string | null>('dsh_remote_local_host_id', { envVars: serviceStore.envVarsRecord })
  signal.throwIfAborted()
  return session.listHosts(signal, local)
}

export function DshRemoteConnectSettings({ connectionRow = false, onManage }: { connectionRow?: boolean; onManage?: () => void }) {
  const { t } = useTranslation('settings')
  const { session, hosts, browser, authError } = useDshController()
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
          else {
            dshControllerStore.update({ session: result, hosts: [], authError: null })
            onManage?.()
          }
        }
      } catch {
        if (!stop.aborted) { finishLoginAttempt(login.attempt); setLogin(undefined); setError(t('dshRemote.loginFailed')) }
      }
    }
    timer = setTimeout(check, 2_000)
    return () => { abort.abort(); clearTimeout(timer) }
  }, [login, onManage, t])

  useEffect(() => {
    if (!session) return
    const stop = new AbortController()
    void loadControllerHosts(session, AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]))
      .then(hosts => {
        if (!stop.signal.aborted && dshControllerStore.get().session === session) dshControllerStore.update({ hosts })
      })
      .catch(failure => { if (!stop.signal.aborted && !handleControllerFailure(session, failure)) setError(t('dshRemote.hostListFailed')) })
    return () => stop.abort()
  }, [session, t])

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

  const refreshHosts = async () => {
    if (!session) return
    setError('')
    setBusy(true)
    try {
      const next = await loadControllerHosts(session, AbortSignal.timeout(15_000))
      if (dshControllerStore.get().session === session) dshControllerStore.update({ hosts: next })
    } catch (failure) { if (!handleControllerFailure(session, failure)) setError(t('dshRemote.hostListFailed')) }
    finally { setBusy(false) }
  }

  const connect = async (hostId: string) => {
    if (!session || !hostId) return
    const active = beginBrowserAttempt()
    if (!active) return
    dshControllerStore.update({ browser: { hostId, phase: 'opening' } })
    setError('')
    try {
      await releasingBrowser
      active.stop.signal.throwIfAborted()
      const connection = await session.connect(hostId, active.stop.signal)
      if (browserAttempt !== active) { await connection.close(); return }
      active.connection = connection
      void connection.closed.then(({ error }) => {
        if (browserAttempt !== active) return
        if (!handleControllerFailure(session, error)) void disconnectBrowser(true)
      })
      const unlisten = await watchDshRemoteViewer(active.id, {
        closed: () => { if (browserAttempt === active) void disconnectBrowser(true) },
        delivered: () => { if (browserAttempt === active) dshControllerStore.update({ browser: { hostId, phase: 'delivered' } }) },
      })
      if (browserAttempt !== active) { unlisten(); return }
      active.unlisten = unlisten
      await openDshRemoteViewer(active.id, connection.grant, active.handoffStop.signal)
      if (browserAttempt === active && dshControllerStore.get().browser?.phase === 'opening') {
        dshControllerStore.update({ browser: { hostId, phase: 'opened' } })
      }
    } catch (failure) {
      if (browserAttempt !== active) return
      if (!handleControllerFailure(session, failure)) {
        void disconnectBrowser()
        setError(connectError((failure as { code?: string })?.code ?? ''))
      }
    }
  }

  const reopen = async () => {
    if (!browser || browser.phase === 'opening') return
    // A browser grant is single-use: release the old lease and allocate a new one.
    void disconnectBrowser()
    await connect(browser.hostId)
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
  const onlineHosts = useMemo(() => hosts.filter(host => host.online === true).length, [hosts])

  const tone: AuthTone = browser && browser.phase !== 'ended' ? 'progress' : session ? 'success' : 'idle'
  const badge = browser ? t(`dshRemote.handoffState.${browser.phase}`) : session ? t('dshRemote.authorized') : t('dshRemote.notSignedIn')

  const loginView = login ? (
    <div className="grid gap-3 rounded-lg border border-border-200/60 bg-bg-200/30 p-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
      <div className="w-fit rounded-lg bg-bg-100 p-1.5"><QrCode text={login.url} size={132} /></div>
      <div className="grid min-w-0 gap-2">
        <p className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('dshRemote.waitingLogin')}</p>
        <p className="text-[length:var(--fs-xs)] text-text-400">{t('dshRemote.expiresIn', { time: clock })}</p>
        <div className="flex flex-wrap gap-2">
          <button className={primary} onClick={() => void openSite(login.url, login.attempt.signal).catch(() => setError(t('dshRemote.loginFailed')))}>
            <ExternalLink size={12} />{t('dshRemote.openLogin')}
          </button>
          <button className={secondary} onClick={() => { login.attempt.abort(); finishLoginAttempt(login.attempt); setLogin(undefined) }}>{t('dshRemote.cancel')}</button>
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
            {browser.phase === 'opening' && <Loader2 size={14} className="shrink-0 animate-spin" />}
            {t(`dshRemote.handoffState.${browser.phase}`)}
          </p>
          {(browser.phase === 'opened' || browser.phase === 'delivered') && (
            <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('dshRemote.connectedHint')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button className={primary} disabled={busy || browser.phase === 'opening'} onClick={() => void reopen()}>
              <ExternalLink size={12} />{t('dshRemote.openAgain')}
            </button>
            <button className={secondary} disabled={busy} onClick={() => void disconnectBrowser()}>
              {t(browser.phase === 'ended' ? 'dshRemote.cancel' : 'dshRemote.disconnect')}
            </button>
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
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${host.online === true ? toneDot.online : toneDot.offline}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--fs-sm)] text-text-100">{host.name}</span>
                      <span className="block text-[length:var(--fs-xs)] text-text-400">
                        {t(host.online === true ? 'dshRemote.online' : host.online === false ? 'dshRemote.offline' : 'dshRemote.unknown')}
                      </span>
                    </span>
                    <span className="shrink-0 text-[length:var(--fs-xs)] text-accent-main-100 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{t('dshRemote.connect')}</span>
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
      {(error || authError) && <AuthAlert>{error || connectError(authError ?? '')}</AuthAlert>}
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
