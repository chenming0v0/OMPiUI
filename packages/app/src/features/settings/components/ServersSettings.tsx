import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check, Copy, ExternalLink, KeyRound, Loader2, MoreHorizontal, Pencil, RefreshCw, ScanLine, Share2, Trash2, Wifi, WifiOff,
} from 'lucide-react'
import { useServerStore } from '../../../hooks'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { parseConnectionLink, resolveConnectionLink } from '../../../utils/connectionLink'
import { scanPairingQr } from '../../../utils/qrScanner'
import { dshControllerStore } from '../../../store/dshControllerStore'
import { AuthAlert } from './AuthPanelUI'
import { Card, PageHead, type LampTone } from './ChannelBoard'
import { AddServerForm } from './AddServerForm'
import { SERVER_NAME_MAX_LENGTH, isHttpsIpUrl } from './serverForm'
import { useServerConnect, useServerSelect } from './useServerConnect'
import type { ServerConfig, ServerHealth } from '../../../store/serverStore'
import { fetchHostShare } from '../../../omp/transport'
import type { ShareInfo } from '@ompiui/protocol'
import { parseDshPairingScan } from '@ompiui/protocol/dsh-remote'

const DshServerRows = lazy(() => import('./DshRemoteSettings').then(module => ({ default: module.DshServerRows })))

function healthTone(health: ServerHealth | null): LampTone {
  if (!health || health.status === 'checking') return 'busy'
  if (health.status === 'online') return 'on'
  return health.status === 'unauthorized' ? 'warn' : 'off'
}

const healthIcons: Record<LampTone, React.ReactNode> = {
  busy: <Loader2 size={15} className="animate-spin" />,
  on: <Wifi size={15} />,
  warn: <KeyRound size={15} />,
  off: <WifiOff size={15} />,
}

type RowView = 'share' | 'edit' | 'confirm' | null

// ============================================
// Server Item：点一行就切换
// ============================================

function ServerItem({
  server,
  health,
  isActive,
  onSelect,
  onDelete,
  onEdit,
  onCheckHealth,
}: {
  server: ServerConfig
  health: ServerHealth | null
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onEdit: (updates: { name: string; url: string; token?: string }) => void
  onCheckHealth: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [view, setView] = useState<RowView>(null)
  // 窄屏把分享、编辑、移除收进「更多」，展开成一排文字按钮。
  const [strip, setStrip] = useState(false)
  const canShare = Boolean(server.isDefault || server.token)
  const canRemove = !server.isDefault
  const toggle = (next: Exclude<RowView, null>) => {
    setStrip(false)
    setView(current => (current === next ? null : next))
  }

  const statusTitle = () => {
    if (!health) return t('servers.checkHealth')
    switch (health.status) {
      case 'checking':
        return t('servers.checking')
      case 'online':
        return `${t('servers.onlineLatency', { latency: health.latency })}${health.version ? ` · Pi v${health.version}` : ''}`
      case 'unauthorized':
        return t('servers.invalidCredentials')
      case 'offline':
        return health.error || t('common:offline')
      case 'error':
        return health.error || t('common:error')
      default:
        return t('common:unknown')
    }
  }

  const tone = healthTone(health)
  const showStrip = strip && view !== 'edit' && view !== 'confirm'
  return (
    <div className="cb-srv" data-current={isActive ? '' : undefined} data-testid="server-row">
      <div className="cb-srv-line">
        <button
          type="button"
          onClick={onSelect}
          aria-current={isActive ? 'true' : undefined}
          title={isActive ? undefined : t('servers.switchTo')}
          className="cb-srv-main touch-target-sm"
        >
          <span className="cb-srv-name" title={server.name}>{server.name}</span>
          <span className="cb-srv-meta">
            <code title={server.url}>{server.url}</code>
            {server.token && <KeyRound size={11} />}
          </span>
        </button>
        <div className="cb-srv-actions">
          {canShare && (
            <button type="button" className="cb-icon-btn" data-wide="" data-active={view === 'share' && !strip ? '' : undefined}
              onClick={() => toggle('share')} title={t('servers.share')} aria-label={t('servers.share')}>
              <Share2 size={15} />
            </button>
          )}
          <button type="button" className="cb-icon-btn" data-tone={tone} onClick={onCheckHealth}
            title={statusTitle()} aria-label={statusTitle()}>
            {healthIcons[tone]}
          </button>
          {canRemove && (
            <button type="button" className="cb-icon-btn" data-wide="" data-danger=""
              onClick={() => toggle('confirm')} title={t('common:remove')} aria-label={t('common:remove')}>
              <Trash2 size={15} />
            </button>
          )}
          <button type="button" className="cb-icon-btn" data-wide=""
            onClick={() => toggle('edit')} title={t('servers.editServer')} aria-label={t('servers.editServer')}>
            <Pencil size={15} />
          </button>
          <button type="button" className="cb-icon-btn" data-narrow="" data-active={strip || view ? '' : undefined}
            aria-expanded={strip || view !== null}
            onClick={() => { setView(null); setStrip(!(strip || view !== null)) }}
            title={t('servers.more')} aria-label={t('servers.more')}>
            <MoreHorizontal size={15} />
          </button>
        </div>
      </div>

      {(showStrip || view) && (
        <div className="cb-srv-ext">
          {showStrip && (
            <div className="cb-strip">
              {canShare && (
                <button type="button" className="cb-btn" data-active={view === 'share' ? '' : undefined}
                  onClick={() => setView(view === 'share' ? null : 'share')}>
                  <Share2 size={15} />{t('servers.share')}
                </button>
              )}
              <button type="button" className="cb-btn" onClick={() => setView('edit')}><Pencil size={15} />{t('common:edit')}</button>
              {canRemove && (
                <button type="button" className="cb-btn" onClick={() => setView('confirm')}><Trash2 size={15} />{t('common:remove')}</button>
              )}
            </div>
          )}
          {view === 'share' && <SharePanel server={server} />}
          {view === 'edit' && (
            <EditServerForm
              server={server}
              onSave={updates => {
                onEdit(updates)
                setView(null)
                setStrip(false)
              }}
              onCancel={() => { setView(null); setStrip(false) }}
            />
          )}
          {view === 'confirm' && (
            <div className="cb-confirm">
              <span>{t('servers.removeConfirm')}</span>
              <button type="button" className="cb-btn" onClick={() => { setView(null); setStrip(false) }}>{t('common:cancel')}</button>
              <button type="button" className="cb-btn" data-variant="danger" onClick={onDelete}>{t('common:remove')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// Share Panel
// ============================================

function CopyField({ label, value, href }: { label: string; value: string; href?: string }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时用户还可以手动选中复制
    }
  }
  return (
    <div className="cb-field">
      <span className="cb-label">{label}</span>
      <div className="cb-copy">
        <code title={value}>{value}</code>
        {href && (
          <a href={href} target="_blank" rel="noreferrer" className="cb-icon-btn"
            title={t('servers.shareOpenUrl')} aria-label={t('servers.shareOpenUrl')}>
            <ExternalLink size={14} />
          </a>
        )}
        <button type="button" onClick={() => void copy()} className="cb-icon-btn"
          title={copied ? t('servers.shareCopied') : t('servers.shareCopy')}
          aria-label={`${copied ? t('servers.shareCopied') : t('servers.shareCopy')} · ${label}`}>
          {copied ? <Check size={14} className="text-success-100" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  )
}

function SharePanel({ server }: { server: ServerConfig }) {
  const { t } = useTranslation(['settings', 'common'])
  const [share, setShare] = useState<ShareInfo | null>(null)
  const [error, setError] = useState('')

  // 拉取分享信息：请求-响应模式，同步状态需与请求一起设置
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false
    if (server.isDefault) {
      // 本地服务器向服务端要分享信息，它能分辨 loopback 与 LAN 绑定
      fetchHostShare()
        .then(info => {
          if (!cancelled) setShare(info)
        })
        .catch(err => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
    } else if (server.token) {
      // 远程服务器的链接在客户端本地拼出来即可
      const url = server.url.replace(/\/+$/, '')
      setShare({
        url,
        token: server.token,
        link: `ompiui://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(server.token)}`,
        lan: true,
      })
    }
    return () => {
      cancelled = true
    }
  }, [server])

  // 提示按暴露模式分流：公网入口（反代/隧道）→ HTTPS 与权限警示；
  // 局域网 → 谨慎分享；仅本机 → 指路服务设置
  const hint = share?.public
    ? t('servers.sharePublicHint')
    : share?.lan
      ? t('servers.shareLanHint')
      : t('servers.shareLoopbackHint')

  if (error) return <AuthAlert>{error}</AuthAlert>
  if (!share) return <p className="cb-hint">{t('servers.checking')}</p>
  return (
    <>
      <CopyField label={t('servers.shareBrowserUrl')} value={share.url} href={share.url} />
      <CopyField label={t('servers.shareConnectLink')} value={share.link} />
      <p className="cb-hint">{hint}</p>
      {share.tunnel && !share.tunnel.connected && <p className="cb-hint">{t('servers.shareTunnelOffline')}</p>}
    </>
  )
}

// ============================================
// Edit Server Form (inline)
// ============================================

function EditServerForm({
  server,
  onSave,
  onCancel,
}: {
  server: ServerConfig
  onSave: (updates: { name: string; url: string; token?: string }) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState(server.name)
  const [url, setUrl] = useState(server.url)
  const [token, setToken] = useState(server.token || '')
  const [error, setError] = useState('')
  const fieldId = `edit-server-${server.id}`

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim().slice(0, SERVER_NAME_MAX_LENGTH)
    if (!trimmedName) {
      setError(t('servers.nameRequired'))
      return
    }
    if (!url.trim()) {
      setError(t('servers.urlRequired'))
      return
    }
    try {
      new URL(url)
    } catch {
      setError(t('servers.invalidUrl'))
      return
    }
    onSave({
      name: trimmedName,
      url: url.trim(),
      token: token.trim() || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="cb-form">
      <div className="cb-grid2">
        <div className="cb-field">
          <label htmlFor={`${fieldId}-url`}>{t('servers.url')}</label>
          <input
            id={`${fieldId}-url`}
            type="text"
            value={url}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={e => {
              setUrl(e.target.value)
              setError('')
            }}
            placeholder={t('servers.urlPlaceholder')}
            className="cb-input font-mono"
          />
        </div>
        <div className="cb-field">
          <label htmlFor={`${fieldId}-token`}>{t('servers.token')}</label>
          <input
            id={`${fieldId}-token`}
            type="password"
            value={token}
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
      <div className="cb-field">
        <label htmlFor={`${fieldId}-name`}>{t('servers.name')}</label>
        <input
          id={`${fieldId}-name`}
          type="text"
          value={name}
          maxLength={SERVER_NAME_MAX_LENGTH}
          onChange={e => {
            setName(e.target.value.slice(0, SERVER_NAME_MAX_LENGTH))
            setError('')
          }}
          className="cb-input"
          autoFocus
        />
      </div>

      {isHttpsIpUrl(url) && (
        <div className="text-[length:var(--fs-xs)] text-warning-100 bg-warning-bg border border-warning-100/20 rounded-md px-2.5 py-2 leading-relaxed">
          {t('servers.httpsIpWarning')}
        </div>
      )}

      {error && <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      <div className="cb-form-foot">
        <button type="button" className="cb-btn" onClick={onCancel}>{t('common:cancel')}</button>
        <button type="submit" className="cb-btn" data-variant="primary">{t('common:save')}</button>
      </div>
    </form>
  )
}

// ============================================
// Tab: Servers
// ============================================

const scanErrors = ['scanUnavailable', 'scanPermissionDenied', 'scanFailed', 'invalidLink']

export function ServersSettings({ initialAddingServer = false, onOpenController }: {
  initialAddingServer?: boolean
  /** DS 远程的配对二维码要到「控制端」里走完确认，扫到之后跳过去。 */
  onOpenController?: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [addingServer, setAddingServer] = useState(initialAddingServer)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  // 页头的刷新同时重读 DS 远程的电脑列表。
  const [dshRefresh, setDshRefresh] = useState(0)
  // DS 远程的电脑在桌面版和手机 App 里都列出来，网页端不展示。
  const native = isTauri()
  // 扫码依赖手机 App 的相机桥接，全应用只有这一个入口，什么码都认。
  const canScan = isTauriMobile()
  const { servers, activeServer, addServer, removeServer, updateServer, checkHealth, checkAllHealth, getHealth } = useServerStore()
  const selectServer = useServerSelect()
  const connectServer = useServerConnect()
  const saved = servers.filter(server => server.source !== 'dsh')

  useEffect(() => {
    checkAllHealth()
  }, [checkAllHealth])

  const scan = async () => {
    if (scanning) return
    setScanning(true)
    setScanError('')
    try {
      const contents = await scanPairingQr(t('servers.scanPrompt'))
      if (contents === null) return
      const link = parseConnectionLink(contents)
      if (link) {
        connectServer(await resolveConnectionLink(link), link.pair ? 'pair' : 'manual')
        setAddingServer(false)
      } else {
        // 不是连接链接，就只能是 DS 远程的配对二维码：交给控制端确认是哪台电脑。
        try { parseDshPairingScan(contents) } catch { throw new Error('invalidLink') }
        dshControllerStore.update({ pairRequest: contents })
        onOpenController?.()
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setScanError(scanErrors.includes(message) ? t(`authentication.${message}`) : message)
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="cb-page">
      <Card>
        <PageHead
          title={t('servers.connections')}
          aside={
            <>
              <button type="button" onClick={() => { checkAllHealth(); setDshRefresh(value => value + 1) }} className="cb-icon-btn"
                title={t('common:refresh')} aria-label={t('common:refresh')}>
                <RefreshCw size={15} />
              </button>
              {canScan && (
                <button type="button" onClick={() => void scan()} disabled={scanning} className="cb-link">
                  {scanning ? <Loader2 size={15} className="animate-spin" /> : <ScanLine size={15} />}
                  {t('servers.scan')}
                </button>
              )}
              <button type="button" onClick={() => setAddingServer(true)} disabled={addingServer} className="cb-link">
                {t('common:add')}
              </button>
            </>
          }
        />
        <div className="cb-body">
          {scanError && <AuthAlert>{scanError}</AuthAlert>}
          {addingServer && (
            <div className="cb-srv" data-form="">
              <div className="cb-srv-ext">
                <AddServerForm
                  onAdd={(server, paired) => {
                    const s = addServer(server)
                    setAddingServer(false)
                    if (paired) selectServer(s.id)
                    else void checkHealth(s.id)
                  }}
                  onCancel={() => setAddingServer(false)}
                />
              </div>
            </div>
          )}
          {saved.map(s => (
            <ServerItem
              key={s.id}
              server={s}
              health={getHealth(s.id)}
              isActive={activeServer?.id === s.id}
              onSelect={() => selectServer(s.id)}
              onDelete={() => removeServer(s.id)}
              onEdit={updates => {
                updateServer(s.id, { name: updates.name, url: updates.url, token: updates.token })
                void checkHealth(s.id)
              }}
              onCheckHealth={() => void checkHealth(s.id)}
            />
          ))}
          {native && <Suspense fallback={null}><DshServerRows onSelectServer={selectServer} refreshKey={dshRefresh} /></Suspense>}
          {saved.length === 0 && !addingServer && !native && <p className="cb-hint">{t('servers.noServersConfigured')}</p>}
        </div>
      </Card>
    </div>
  )
}
