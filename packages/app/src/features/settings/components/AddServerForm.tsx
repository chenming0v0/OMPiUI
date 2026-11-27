import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { SpinnerIcon } from '../../../components/Icons'
import { parseConnectionLink, resolveConnectionLink } from '../../../utils/connectionLink'
import type { ServerSource } from '../../../store/serverStore'
import { SERVER_NAME_MAX_LENGTH, hostNameOf, isHttpsIpUrl } from './serverForm'
import './channelBoard.css'

export interface NewServer {
  name: string
  url: string
  token?: string
  source: ServerSource
}

/**
 * 用后端地址和密钥添加一台服务器。地址栏也接受 ompiui://connect 分享链接和完整配对链接。
 * 「服务器」页和「控制端 → 地址和密钥」共用这一张表单。
 */
export function AddServerForm({ onAdd, onCancel, submitLabel, hint }: {
  /** paired 为真表示这条是用一次性配对链接兑换来的。 */
  onAdd: (server: NewServer, paired: boolean) => void
  onCancel?: () => void
  submitLabel?: string
  hint?: string
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pairing) return
    const connectLink = parseConnectionLink(url)
    let parsed: URL
    try {
      parsed = new URL(connectLink?.url ?? url.trim())
    } catch {
      setError(t(url.trim() ? 'servers.invalidUrl' : 'servers.urlRequired'))
      return
    }
    const pairCode = parsed.searchParams.get('pair')
    const trimmedName = name.trim().slice(0, SERVER_NAME_MAX_LENGTH) || hostNameOf(parsed.href)
    if (pairCode && !connectLink) {
      setError(t('service.remotePairInvalid'))
      return
    }
    if (connectLink) {
      setPairing(true)
      setError('')
      try {
        const result = await resolveConnectionLink(connectLink)
        const paired = Boolean(connectLink.pair)
        onAdd({ name: trimmedName, url: result.url, token: result.token, source: paired ? 'pair' : 'manual' }, paired)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setPairing(false)
      }
      return
    }

    onAdd({ name: trimmedName, url: url.trim(), token: token.trim() || undefined, source: 'manual' }, false)
  }

  return (
    <form onSubmit={event => void handleSubmit(event)} aria-busy={pairing} className="cb-form">
      <div className="cb-grid2">
        <div className="cb-field">
          <label htmlFor="add-server-url" className="cb-row-title">{t('servers.url')}</label>
          <input
            id="add-server-url"
            type="text"
            inputMode="url"
            value={url}
            disabled={pairing}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={e => {
              setUrl(e.target.value)
              setError('')
            }}
            placeholder={t('servers.urlPlaceholder')}
            className="cb-input font-mono"
          />
        </div>
        <div className="cb-field">
          <label htmlFor="add-server-token" className="cb-row-title">{t('servers.token')}</label>
          <input
            id="add-server-token"
            type="password"
            value={token}
            disabled={pairing}
            autoComplete="off"
            onChange={e => {
              setToken(e.target.value)
              setError('')
            }}
            placeholder={t('servers.tokenPlaceholder')}
            className="cb-input font-mono"
          />
        </div>
      </div>
      <p className="cb-hint -mt-2">{t('servers.urlShareHint')}</p>
      <div className="cb-field">
        <label htmlFor="add-server-name" className="cb-row-title">{t('servers.nameOptional')}</label>
        <input
          id="add-server-name"
          type="text"
          value={name}
          aria-label={t('servers.name')}
          disabled={pairing}
          maxLength={SERVER_NAME_MAX_LENGTH}
          onChange={e => {
            setName(e.target.value.slice(0, SERVER_NAME_MAX_LENGTH))
            setError('')
          }}
          placeholder={t('servers.nameOptionalPlaceholder')}
          className="cb-input"
        />
      </div>

      {isHttpsIpUrl(url) && (
        <div className="text-[length:var(--fs-xs)] text-warning-100 bg-warning-bg border border-warning-100/20 rounded-md px-2.5 py-2 leading-relaxed">
          {t('servers.httpsIpWarning')}
        </div>
      )}

      {error && <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      <div className="cb-form-foot">
        <span className="cb-hint">{hint ?? t('servers.credentialsStorage')}</span>
        <span className="cb-row-control">
          {onCancel && (
            <button type="button" className="cb-btn" onClick={onCancel} disabled={pairing}>
              {t('common:cancel')}
            </button>
          )}
          <button type="submit" className="cb-btn" data-variant="primary" disabled={pairing}>
            {pairing ? <SpinnerIcon size={14} className="animate-spin" /> : <Plus size={15} />}
            {submitLabel ?? t('common:add')}
          </button>
        </span>
      </div>
    </form>
  )
}
