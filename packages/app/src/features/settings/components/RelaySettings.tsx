import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { restartDesktopService } from '../../../services/desktopService'
import { serviceStore, useServiceStore } from '../../../store/serviceStore'
import { AuthAlert } from './AuthPanelUI'
import './channelBoard.css'

const TUNNEL_URL_KEY = 'OMPIUI_TUNNEL_URL'
const TUNNEL_KEY_KEY = 'OMPIUI_TUNNEL_KEY'
const TUNNEL_ID_KEY = 'OMPIUI_TUNNEL_ID'

/**
 * 被控端 → 自建中转：这台电脑的中转配置就在这条通道里填。
 * 配置存在本机服务的启动环境里，保存后重启本机服务才生效。
 */
export function RelaySettings({ onCancel }: { onCancel?: () => void }) {
  const { t } = useTranslation(['settings', 'common'])
  const { envVars, running, startedByUs } = useServiceStore()
  const valueOf = (key: string) =>
    envVars.find(item => item.key.trim().toUpperCase() === key)?.value || ''
  const [url, setUrl] = useState(() => valueOf(TUNNEL_URL_KEY))
  const [key, setKey] = useState(() => valueOf(TUNNEL_KEY_KEY))
  const [id, setId] = useState(() => valueOf(TUNNEL_ID_KEY))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [manual, setManual] = useState(false)
  if (!isTauri() || isTauriMobile()) return null

  // 别的进程启动的服务，桌面应用重启不了它。
  const external = running && !startedByUs
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    const relay = new Map([[TUNNEL_URL_KEY, url.trim()], [TUNNEL_KEY_KEY, key.trim()], [TUNNEL_ID_KEY, id.trim()]])
    const next = serviceStore.envVars.filter(item => !relay.has(item.key.trim().toUpperCase()))
    for (const [name, value] of relay) if (value) next.push({ key: name, value })
    serviceStore.setEnvVars(next)
    setError('')
    if (external) { setManual(true); return }
    setBusy(true)
    try {
      await restartDesktopService()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="cb-ticket" data-form="" aria-busy={busy} onSubmit={event => void save(event)}
      data-setting-label={t('service.tunnelTitle')}>
      <div className="cb-field">
        <label htmlFor="relay-url">{t('service.tunnelUrl')}</label>
        <input id="relay-url" type="text" value={url} disabled={busy} placeholder="wss://relay.example.com"
          autoCapitalize="none" autoComplete="off" spellCheck={false} className="cb-input font-mono"
          onChange={event => { setUrl(event.target.value); setManual(false) }} />
      </div>
      <div className="cb-field">
        <label htmlFor="relay-key">{t('service.tunnelKey')}</label>
        <input id="relay-key" type="password" value={key} disabled={busy} autoComplete="off" spellCheck={false}
          className="cb-input font-mono"
          onChange={event => { setKey(event.target.value); setManual(false) }} />
      </div>
      <div className="cb-field">
        <label htmlFor="relay-id">{t('service.tunnelId')}</label>
        <input id="relay-id" type="text" value={id} disabled={busy} placeholder="ompiui"
          autoCapitalize="none" autoComplete="off" spellCheck={false} className="cb-input font-mono"
          onChange={event => { setId(event.target.value); setManual(false) }} />
      </div>
      {error && <AuthAlert>{error}</AuthAlert>}
      <button type="submit" className="cb-btn" data-variant="primary" disabled={busy}>
        {busy && <Loader2 size={14} className="animate-spin" />}{t('host.relaySave')}
      </button>
      {onCancel && <button type="button" className="cb-btn" disabled={busy} onClick={onCancel}>{t('common:cancel')}</button>}
      <p className="cb-tk-text" role={manual ? 'status' : undefined}>
        {t(manual ? 'host.relayRestartManual' : external ? 'host.relayRestartExternal' : 'host.relayRestartHint')}
      </p>
    </form>
  )
}
