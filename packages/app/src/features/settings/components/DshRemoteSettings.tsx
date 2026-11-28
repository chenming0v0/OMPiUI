import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Download, ExternalLink, Loader2, LogOut, Monitor, RefreshCw, ScanLine } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import {
  DshApiError, beginDshLogin, listDshLoginProviders, pollDshLogin, resolveDshPairing, restoreDshPairedSession,
  type DshAppSession, type DshLoginProvider, type DshPhonePairing,
} from '../../../services/dshRemote'
import { connectDshServer, disconnectDshServer, handleDshControllerFailure as handleControllerFailure } from '../../../services/dshServerConnection'
import { serverStore } from '../../../store/serverStore'
import { scanPairingQr } from '../../../utils/qrScanner'
import { isTauriMobile } from '../../../utils/tauri'
import { QrCode } from '../../../components/QrCode'
import { DeepSeekIcon } from '../../../components/Icons'
import { serviceStore } from '../../../store/serviceStore'
import { dshControllerStore, useDshController } from '../../../store/dshControllerStore'
import { exportDshDiagnostics, recordDshDiagnostic } from '../../../services/dshConnectionDiagnostics'
import { saveData } from '../../../utils/downloadUtils'
import { AuthAlert } from './AuthPanelUI'
import { Lamp, NextAction, PanelRow, PanelSplit } from './ChannelBoard'

async function openSite(url: string, signal?: AbortSignal) {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  signal?.throwIfAborted()
  await openUrl(url)
}

// 恢复这台控制设备自己的账号或配对授权，保留原来的登录方式。
if (!dshControllerStore.get().session) {
  try {
    const saved = restoreDshPairedSession()
    if (saved) dshControllerStore.update({ session: saved })
  } catch { dshControllerStore.update({ authError: 'DSH_STORAGE_FAILED' }) }
}
let loginAttempt: AbortController | undefined

function beginLoginAttempt(): AbortController {
  loginAttempt?.abort()
  return loginAttempt = new AbortController()
}

function finishLoginAttempt(stop: AbortController): void {
  if (loginAttempt === stop) loginAttempt = undefined
}

async function loadControllerHosts(session: DshAppSession, signal: AbortSignal) {
  const attemptId = crypto.randomUUID()
  const startedAt = Date.now()
  recordDshDiagnostic('host_list.request', { attemptId })
  try {
    const local = isTauriMobile() ? null : await invoke<string | null>('dsh_remote_local_host_id', { envVars: serviceStore.envVarsRecord })
    signal.throwIfAborted()
    const hosts = await session.listHosts(signal, local)
    recordDshDiagnostic('host_list.success', {
      attemptId, durationMs: Date.now() - startedAt, hostCount: hosts.length,
      onlineCount: hosts.filter(host => host.online === true).length,
      offlineCount: hosts.filter(host => host.online === false).length,
      unknownCount: hosts.filter(host => host.online === undefined).length,
    })
    return hosts
  } catch (error) {
    recordDshDiagnostic('host_list.failure', {
      attemptId, durationMs: Date.now() - startedAt,
      status: error instanceof DshApiError ? error.status : undefined,
      code: diagnosticCodeForUi(error),
    })
    throw error
  }
}

function diagnosticCodeForUi(error: unknown): string | undefined {
  if (error instanceof DshApiError) return error.code
  if (error instanceof DOMException && error.name === 'AbortError') return 'REQUEST_ABORTED'
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'TIMEOUT'
  if (error instanceof TypeError) return 'TypeError'
  return error instanceof Error ? 'Error' : undefined
}

/** 授权状态查询可重试的暂时故障；协议错误和明确拒绝应结束本次登录。 */
export function isDshLoginRetryableError(error: unknown): boolean {
  if (error instanceof DshApiError) return error.status === 429 || (error.status >= 500 && error.status < 600)
  return error instanceof TypeError || ((error instanceof Error || error instanceof DOMException) && error.name === 'TimeoutError')
}

/** 登录后读取账号下的电脑。控制端面板和服务器页都靠它保持列表是新的。 */
function useDshHosts() {
  const { session } = useDshController()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!session) return
    request.current?.abort()
    const stop = new AbortController()
    request.current = stop
    setFailed(false)
    setBusy(true)
    try {
      const next = await loadControllerHosts(session, AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]))
      if (!stop.signal.aborted && dshControllerStore.get().session === session) dshControllerStore.update({ hosts: next })
    } catch (failure) {
      if (!stop.signal.aborted && dshControllerStore.get().session === session && !handleControllerFailure(session, failure)) setFailed(true)
    } finally {
      if (!stop.signal.aborted) setBusy(false)
    }
  }, [session])

  useEffect(() => {
    void refresh()
    return () => request.current?.abort()
  }, [refresh])
  return { busy: busy && Boolean(session), failed: failed && Boolean(session), refresh }
}

// ============================================
// 控制端 → DS 远程：登录账号，看到账号下的电脑
// ============================================

export function DshRemoteConnectSettings({ onOpenServers }: { onOpenServers?: () => void }) {
  const { t } = useTranslation('settings')
  const { session, hosts, authError } = useDshController()
  const { busy: hostsBusy, failed: hostsFailed, refresh: refreshHosts } = useDshHosts()
  const [providers, setProviders] = useState<DshLoginProvider[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providersError, setProvidersError] = useState(false)
  const [login, setLogin] = useState<{ id: string; url: string; expiresAt: number; attempt: AbortController }>()
  const [loginRetrying, setLoginRetrying] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 扫码配对：先确认是哪台电脑，再显示要在电脑上输入的验证码。
  const [pair, setPair] = useState<{ pairing: DshPhonePairing; code?: string }>()
  const phone = isTauriMobile()

  const connectError = (code: string) => t(`dshRemote.connectError.${code || 'default'}`, { defaultValue: t('dshRemote.connectError.default') })
  const pairError = useCallback((code: string) =>
    t(`dshRemote.pairError.${code || 'default'}`, { defaultValue: t('dshRemote.pairError.default') }), [t])

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
    dshControllerStore.update({ signingIn: Boolean(login || pair) })
    return () => dshControllerStore.update({ signingIn: false })
  }, [login, pair])

  // 验证码已经领了却取消或离开这一页：告诉电脑这次不继续了，免得它那边输完码这边却没接住。
  const pairing = pair?.pairing
  useEffect(() => {
    if (!pairing) return
    return () => { void pairing.cancel() }
  }, [pairing])

  useEffect(() => {
    if (!pair?.code) return
    const stop = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const result = await pair.pairing.poll(AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]))
        if (stop.signal.aborted) return
        if (result.paired) {
          setPair(undefined)
          const current = result.paired
          if (dshControllerStore.get().session !== current) dshControllerStore.update({ session: current, hosts: [], authError: null })
          else {
            // 再配一台电脑时会话没变，只需要把新电脑读进列表。
            void loadControllerHosts(current, AbortSignal.timeout(15_000))
              .then(hosts => { if (dshControllerStore.get().session === current) dshControllerStore.update({ hosts }) })
              .catch(() => undefined)
          }
        } else if (result.state === 'claimed' || result.state === 'approved') timer = setTimeout(check, 2_500)
        else {
          setPair(undefined)
          setError(pairError(result.state === 'failed' ? result.failureReason ?? 'failed' : result.state))
        }
      } catch (failure) {
        if (stop.signal.aborted) return
        // 服务器明确拒绝才算结束；网络抖动就接着等。
        if (failure instanceof DshApiError && failure.status !== 429 && failure.status < 500) {
          setPair(undefined)
          setError(failure.code === 'DSH_STORAGE_FAILED' ? t('dshRemote.connectError.DSH_STORAGE_FAILED') : pairError(failure.code))
        } else timer = setTimeout(check, 2_500)
      }
    }
    timer = setTimeout(check, 2_500)
    return () => { stop.abort(); clearTimeout(timer) }
  }, [pair, pairError, t])

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
    let registering = false
    const schedule = () => { timer = setTimeout(check, Math.min(2_000, Math.max(0, login.expiresAt - Date.now()))) }
    const check = async () => {
      try {
        const result = Date.now() >= login.expiresAt ? 'expired' : await pollDshLogin(login.id, stop, {
          // 服务确认 complete 后先通知 UI，再注册设备；注册失败不能重新轮询并生成新身份。
          onComplete: () => { registering = true },
        })
        if (stop.aborted) {
          if (typeof result !== 'string') await result.revoke().catch(() => undefined)
          return
        }
        setLoginRetrying(false)
        if (result === 'pending') schedule()
        else {
          finishLoginAttempt(login.attempt)
          setLogin(undefined)
          if (result === 'expired') setError(t('dshRemote.loginExpired'))
          else dshControllerStore.update({ session: result, hosts: [], authError: null })
        }
      } catch (failure) {
        if (stop.aborted) return
        const retryable = !registering && isDshLoginRetryableError(failure)
        if (retryable && Date.now() < login.expiresAt) {
          setLoginRetrying(true)
          schedule()
          return
        }
        finishLoginAttempt(login.attempt)
        setLogin(undefined)
        setLoginRetrying(false)
        setError(t(failure instanceof DshApiError && failure.code === 'DSH_STORAGE_FAILED'
          ? 'dshRemote.connectError.DSH_STORAGE_FAILED'
          : retryable && Date.now() >= login.expiresAt ? 'dshRemote.loginExpired' : 'dshRemote.loginFailed'))
      }
    }
    schedule()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [login, t])

  const signIn = async (provider: DshLoginProvider) => {
    const stop = beginLoginAttempt()
    setBusy(true)
    setError('')
    setLoginRetrying(false)
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

  const scan = async () => {
    setBusy(true)
    setError('')
    dshControllerStore.update({ authError: null })
    try {
      const text = await scanPairingQr(t('dshRemote.pairScanPrompt'))
      if (!text) return
      const signal = AbortSignal.timeout(12_000)
      setPair({ pairing: session?.paired ? await session.pairAnother(text, signal) : await resolveDshPairing(text, signal) })
    } catch (failure) {
      setError(pairError(failure instanceof DshApiError ? failure.code : failure instanceof Error ? failure.message : ''))
    } finally { setBusy(false) }
  }

  const claim = async () => {
    if (!pair) return
    setBusy(true)
    setError('')
    try {
      setPair({ pairing: pair.pairing, code: await pair.pairing.claim(AbortSignal.timeout(12_000)) })
    } catch (failure) {
      const rejected = failure instanceof DshApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 429
      if (rejected) setPair(undefined)
      setError(pairError(failure instanceof DshApiError ? failure.code : ''))
    } finally { setBusy(false) }
  }

  const cancelPair = () => setPair(undefined)

  const revoke = async () => {
    if (!session) return
    setBusy(true)
    setError('')
    try {
      await disconnectDshServer()
      await session.revoke()
      if (dshControllerStore.get().session === session) dshControllerStore.update({ session: null, hosts: [] })
    } catch (failure) {
      if (failure instanceof DshApiError && failure.code === 'DSH_STORAGE_FAILED') {
        if (session.invalidated && dshControllerStore.get().session === session) {
          dshControllerStore.update({ session: null, hosts: [], authError: failure.code })
        } else setError(t('dshRemote.connectError.DSH_STORAGE_FAILED'))
      } else setError(t('dshRemote.logoutFailed'))
    }
    finally { setBusy(false) }
  }

  const remaining = login ? Math.max(0, Math.floor((login.expiresAt - now) / 1000)) : 0
  const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
  const alert = error || (authError ? connectError(authError) : '') || (hostsFailed ? t('dshRemote.hostListFailed') : '')

  let body: React.ReactNode
  if (pair?.code) {
    body = (
      <div data-testid="dsh-pair-code">
        <h3 className="text-[length:var(--fs-base)] font-semibold leading-snug text-text-100">{t('dshRemote.pairCodeTitle')}</h3>
        <div className="cb-code mt-3" aria-label={t('dshRemote.pairCodeTitle')}>
          <span>{pair.code.slice(0, 4)}</span><span>{pair.code.slice(4)}</span>
        </div>
        <p className="cb-hint">{t('dshRemote.pairCodeHint', { computer: pair.pairing.computer.name })}</p>
        <p className="cb-waiting"><span aria-hidden className="cb-waiting-dot" /><span>{t('dshRemote.pairWaiting')}</span></p>
        <div className="cb-actions">
          <button type="button" className="cb-btn" onClick={cancelPair}>{t('dshRemote.cancel')}</button>
        </div>
      </div>
    )
  } else if (pair) {
    const computer = pair.pairing.computer
    body = (
      <NextAction icon={<Monitor size={18} />} title={t('dshRemote.pairConfirmTitle')} testId="dsh-pair-confirm"
        actions={<>
          <button type="button" className="cb-btn" data-variant="primary" disabled={busy} onClick={() => void claim()}>
            {busy && <Loader2 size={14} className="animate-spin" />}{t('dshRemote.pairConfirm')}
          </button>
          <button type="button" className="cb-btn" disabled={busy} onClick={cancelPair}>{t('dshRemote.cancel')}</button>
        </>}>
        <p className="font-semibold text-text-100">{computer.name}</p>
        <p className="mt-2">{t('dshRemote.pairFingerprint')}</p>
        <code className="cb-addr">{computer.fingerprint}</code>
      </NextAction>
    )
  } else if (session) {
    body = <>
      <div className="cb-list">
        <div className="cb-list-head">
          <span className="cb-row-title">{t('controller.dshComputers')}</span>
          <span className="flex flex-wrap items-center gap-3">
            {phone && session.paired && (
              <button type="button" className="cb-link" disabled={busy} onClick={() => void scan()}>
                <ScanLine size={12} />{t('dshRemote.pairAnother')}
              </button>
            )}
            <button type="button" className="cb-link" disabled={hostsBusy} onClick={() => void refreshHosts()}>
              <RefreshCw size={12} className={hostsBusy ? 'animate-spin' : undefined} />{t('dshRemote.refresh')}
            </button>
          </span>
        </div>
        {hosts.length ? hosts.map(host => (
          <div key={host.id} className="cb-device" data-dim={host.online === false ? '' : undefined}>
            <Lamp tone={host.online === true ? 'on' : host.online === false ? 'off' : 'warn'} />
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
        <PanelRow title={t(session.paired ? 'controller.dshPaired' : 'controller.dshAccount')}
          hint={t(session.paired ? 'controller.dshPairedHint' : 'controller.dshAccountHint')}>
          <button type="button" className="cb-btn" disabled={busy} onClick={() => void revoke()}>
            <LogOut size={14} />{t(session.paired ? 'controller.dshUnpair' : 'dshRemote.logout')}
          </button>
        </PanelRow>
      </PanelSplit>
    </>
  } else if (login) {
    // 手机上授权页就开在这台手机的浏览器里，给自己看一个二维码没有用。
    body = (
      <div className={phone ? undefined : 'cb-login'}>
        {!phone && <div className="cb-qr"><QrCode text={login.url} size={140} /></div>}
        <div className="min-w-0">
          <h3 className="text-[length:var(--fs-base)] font-semibold leading-snug text-text-100">{t('controller.dshScanTitle')}</h3>
          <p className="mt-1 text-[length:var(--fs-sm)] leading-relaxed text-text-200">
            {t(phone ? 'dshRemote.waitingLoginPhone' : 'dshRemote.waitingLogin')} {t('dshRemote.expiresIn', { time: clock })}
          </p>
          {loginRetrying && <p role="status" className="cb-hint">{t('dshRemote.loginRetrying')}</p>}
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
      <NextAction icon={<DeepSeekIcon size={18} />} title={t(phone ? 'controller.dshPairTitle' : 'controller.dshLoginTitle')}
        actions={<>
          {phone && (
            <button type="button" className="cb-btn" data-variant="primary" disabled={busy} onClick={() => void scan()}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ScanLine size={14} />}{t('dshRemote.pairScan')}
            </button>
          )}
          {providersLoading ? (
            <span className="cb-hint flex items-center gap-2"><Loader2 size={13} className="animate-spin" />{t('dshRemote.loginLoading')}</span>
          ) : providers.length ? providers.map((provider, index) => (
            <button key={provider.id} type="button" className="cb-btn" data-variant={index === 0 && !phone ? 'primary' : undefined}
              disabled={busy} onClick={() => void signIn(provider)}>
              {t('controller.dshLoginWith', { provider: provider.label })}
            </button>
          )) : (
            <button type="button" className="cb-btn" data-variant={phone ? undefined : 'primary'} disabled={busy} onClick={() => void discover()}>
              {t('dshRemote.login')}
            </button>
          )}
        </>}>
        <p>{t(phone ? 'dshRemote.pairDesc' : 'dshRemote.loginDesc')}</p>
        {providersError && !providersLoading && <p className="mt-1">{t('dshRemote.noProviders')}</p>}
      </NextAction>
    )
  }

  return (
    <div data-testid="dsh-remote-client" className="min-w-0">
      {alert && <div className="mb-4"><AuthAlert>{alert}</AuthAlert></div>}
      {body}
      <PanelSplit>
        <PanelRow title={t('dshRemote.diagnosticsTitle')} hint={t('dshRemote.diagnosticsHint')}>
          <button type="button" className="cb-btn" onClick={() => {
            const stamp = new Date().toISOString().replaceAll(':', '-')
            saveData(new TextEncoder().encode(exportDshDiagnostics()), `ompiui-dsh-connection-${stamp}.txt`, 'text/plain')
          }}>
            <Download size={14} />{t('dshRemote.exportDiagnostics')}
          </button>
        </PanelRow>
      </PanelSplit>
    </div>
  )
}

// ============================================
// 服务器页：账号下的电脑。它们跟着登录状态走，不落盘。
// ============================================

export function DshServerRows({ onSelectServer = id => { serverStore.setActiveServer(id) } }: {
  onSelectServer?: (id: string) => void
}) {
  const { t } = useTranslation('settings')
  const { session, hosts, connection, authError } = useDshController()
  const { busy, failed, refresh } = useDshHosts()
  const [error, setError] = useState<{ hostId: string; text: string } | null>(null)
  if (!session) return authError ? (
    <div className="px-4 py-3"><AuthAlert>{t(`dshRemote.connectError.${authError}`, { defaultValue: t('dshRemote.connectError.default') })}</AuthAlert></div>
  ) : null
  const open = async (hostId: string, name: string) => {
    setError(null)
    try {
      await connectDshServer(session, hostId, name, onSelectServer)
    } catch (failure) {
      const code = failure instanceof DshApiError ? failure.code : ''
      setError({ hostId, text: t(`dshRemote.connectError.${code || 'default'}`, { defaultValue: t('dshRemote.connectError.default') }) })
    }
  }

  return <>
    <div className="cb-list-head px-4 py-3">
      <span className="cb-row-title">{t('dshRemote.tab')}</span>
      <button type="button" className="cb-link" aria-label={t('dshRemote.refreshHosts')} disabled={busy} onClick={() => void refresh()}>
        <RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />{t('dshRemote.refresh')}
      </button>
    </div>
    {failed && <div className="px-4 pb-3"><AuthAlert>{t('dshRemote.hostListFailed')}</AuthAlert></div>}
    {!hosts.length && !busy && !failed && <p className="cb-hint px-4 pb-3">{t('dshRemote.noHosts')}</p>}
    {hosts.map(host => {
      const state = connection?.hostId === host.id ? connection : null
      const current = state?.phase === 'connected'
      const connecting = state?.phase === 'connecting'
      return (
        <div key={host.id} className="cb-srv" data-current={current ? '' : undefined} data-testid="dsh-server-row">
          <Lamp tone={host.online === true ? 'on' : host.online === false ? 'off' : 'warn'} />
          <button type="button" className="cb-srv-main text-left" aria-current={current ? 'true' : undefined}
            disabled={host.online === false || connecting} onClick={() => void open(host.id, host.name)}>
            <span className="cb-srv-title">
              <span className="cb-srv-name" title={host.name}>{host.name}</span>
              <span className="cb-via"><DeepSeekIcon size={11} />{t('servers.via.dsh')}</span>
            </span>
            <span className="cb-srv-meta">
              <span role={state ? 'status' : undefined}>
                {state
                  ? t(`dshRemote.connectionState.${state.phase}`)
                  : t(host.online === true ? 'dshRemote.online' : host.online === false ? 'dshRemote.offline' : 'dshRemote.unknown')}
              </span>
            </span>
          </button>
          <div className="cb-srv-actions gap-1.5">
            {current ? <>
              <span className="cb-link">{t('servers.current')}</span>
              <button type="button" className="cb-btn" data-size="sm" onClick={() => void disconnectDshServer()}>
                {t('dshRemote.disconnect')}
              </button>
            </> : (
              <button type="button" className="cb-btn" data-size="sm" disabled={host.online === false || connecting} onClick={() => void open(host.id, host.name)}>
                {connecting ? <Loader2 size={12} className="animate-spin" /> : <Monitor size={12} />}{t('dshRemote.selectServer')}
              </button>
            )}
          </div>
          {error?.hostId === host.id && <div className="cb-srv-extra"><AuthAlert>{error.text}</AuthAlert></div>}
        </div>
      )
    })}
  </>
}
