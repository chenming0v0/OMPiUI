import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { parseConnectionLink, parseDisplayCode, parsePairingServerAddress, resolveConnectionLink } from '../../../utils/connectionLink'
import { redeemDisplayCode } from '../../../omp/transport'
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
 * 添加一台服务器，全应用只有这一张表单。
 * 地址栏接受后端地址、完整配对链接和 ompiui://connect 分享链接；后两种自带凭证，第二栏不用填。
 * 第二栏填 8 位数字按一次性配对码兑换，其余按后端密钥保存。
 */
export function AddServerForm({ onAdd, onCancel }: {
  /** paired 为真表示这条是用一次性配对链接或配对码兑换来的。 */
  onAdd: (server: NewServer, paired: boolean) => void
  onCancel?: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState(false)
  const link = parseConnectionLink(url)
  const code = link ? null : parseDisplayCode(secret)
  const recognized = link
    ? t(link.pair ? 'servers.detectedPairLink' : 'servers.detectedShareLink')
    : code ? t('servers.detectedCode') : secret.trim() ? t('servers.detectedKey') : ''

  const redeem = async (action: () => Promise<{ url: string; token?: string }>, serverName: string, source: ServerSource, paired: boolean) => {
    setPairing(true)
    setError('')
    try {
      const result = await action()
      onAdd({ name: serverName || hostNameOf(result.url), url: result.url, token: result.token, source }, paired)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPairing(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pairing) return
    const trimmedName = name.trim().slice(0, SERVER_NAME_MAX_LENGTH)
    if (link) {
      const paired = Boolean(link.pair)
      await redeem(() => resolveConnectionLink(link), trimmedName || hostNameOf(link.url), paired ? 'pair' : 'manual', paired)
      return
    }
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      setError(t(url.trim() ? 'servers.invalidUrl' : 'servers.urlRequired'))
      return
    }
    if (parsed.searchParams.get('pair')) {
      setError(t('service.remotePairInvalid'))
      return
    }
    if (code) {
      const base = parsePairingServerAddress(url)
      if (!base) {
        setError(t('authentication.invalidAddress'))
        return
      }
      await redeem(() => redeemDisplayCode(code, base, AbortSignal.timeout(15_000)), trimmedName, 'pair', true)
      return
    }
    onAdd({ name: trimmedName || hostNameOf(parsed.href), url: url.trim(), token: secret.trim() || undefined, source: 'manual' }, false)
  }

  return (
    <form onSubmit={event => void handleSubmit(event)} aria-busy={pairing} className="cb-form">
      <div className="cb-grid2">
        <div className="cb-field">
          <label htmlFor="add-server-url">{t('servers.urlOrLink')}</label>
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
          <label htmlFor="add-server-secret">{t('servers.secretOptional')}</label>
          <input
            id="add-server-secret"
            type="text"
            value={secret}
            disabled={pairing || Boolean(link)}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={recognized ? 'add-server-recognized' : undefined}
            onChange={e => {
              setSecret(e.target.value)
              setError('')
            }}
            placeholder={t('servers.secretPlaceholder')}
            className="cb-input font-mono"
          />
        </div>
      </div>
      {recognized && <p id="add-server-recognized" className="cb-hint -mt-1.5">{recognized}</p>}
      <div className="cb-field">
        <label htmlFor="add-server-name">{t('servers.nameOptional')}</label>
        <input
          id="add-server-name"
          type="text"
          value={name}
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
        {onCancel && (
          <button type="button" className="cb-btn" onClick={onCancel} disabled={pairing}>
            {t('common:cancel')}
          </button>
        )}
        <button type="submit" className="cb-btn" data-variant="primary" disabled={pairing}>
          {pairing && <Loader2 size={14} className="animate-spin" />}
          {t('common:add')}
        </button>
      </div>
    </form>
  )
}
