import { lazy, Suspense, useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Globe, KeyRound, Monitor, QrCode } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import {
  TrashIcon,
  SpinnerIcon,
  KeyIcon,
  PencilIcon,
  PlusIcon,
  RetryIcon,
  ShareIcon,
  CopyIcon,
  CheckIcon,
  ExternalLinkIcon,
} from '../../../components/Icons'
import { useServerStore, useRouter } from '../../../hooks'
import { clearSessionRuntimeState } from '../../../utils/sessionLifecycle'
import { isTailnetUrl } from '../../../utils/androidTailscale'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { settingsFieldClass } from './SettingsUI'
import { Lamp, PageHead, type LampTone } from './ChannelBoard'
import { AddServerForm } from './AddServerForm'
import { SERVER_NAME_MAX_LENGTH, isHttpsIpUrl } from './serverForm'
import type { ServerConfig, ServerHealth } from '../../../store/serverStore'
import { fetchHostShare } from '../../../omp/transport'
import type { ShareInfo } from '@ompiui/protocol'

const DshServerRows = lazy(() => import('./DshRemoteSettings').then(module => ({ default: module.DshServerRows })))

type ServerVia = 'local' | 'pair' | 'tailscale' | 'manual'

/** 来源标记：和「控制端」的通道用同一套名字和图标。 */
function serverVia(server: ServerConfig): ServerVia {
  if (server.isDefault && (!/^https?:\/\//i.test(server.url) || /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(server.url))) return 'local'
  if (isTailnetUrl(server.url)) return 'tailscale'
  return server.source === 'pair' ? 'pair' : 'manual'
}

const viaIcons: Record<ServerVia, React.ReactNode> = {
  local: <Monitor size={11} />,
  pair: <QrCode size={11} />,
  tailscale: <Globe size={11} />,
  manual: <KeyRound size={11} />,
}

function healthTone(health: ServerHealth | null): LampTone {
  if (!health || health.status === 'checking') return 'busy'
  if (health.status === 'online') return 'on'
  return health.status === 'unauthorized' ? 'warn' : 'off'
}

// ============================================
// Server Item
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
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const via = serverVia(server)

  const statusText = () => {
    if (!health || health.status === 'checking') return t('servers.checking')
    switch (health.status) {
      case 'online':
        return t('servers.onlineLatency', { latency: health.latency })
      case 'unauthorized':
        return t('servers.invalidCredentials')
      case 'offline':
        return t('common:offline')
      default:
        return t('common:error')
    }
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

  if (editing) {
    return (
      <EditServerForm
        server={server}
        onSave={updates => {
          onEdit(updates)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <>
      <div onClick={onSelect} className="cb-srv group cursor-pointer" data-current={isActive ? '' : undefined}>
        <Lamp tone={healthTone(health)} />
        <button
          type="button"
          onClick={e => {
            e.stopPropagation()
            onSelect()
          }}
          aria-current={isActive ? 'true' : undefined}
          title={isActive ? undefined : t('servers.switchTo')}
          className="cb-srv-main touch-target-sm"
        >
          <span className="cb-srv-title">
            <span className="cb-srv-name" title={server.name}>{server.name}</span>
            <span className="cb-via">{viaIcons[via]}{t(`servers.via.${via}`)}</span>
          </span>
          <span className="cb-srv-meta">
            <code title={server.url}>{server.url}</code>
            {server.token && <KeyIcon size={10} className="shrink-0 text-text-400" />}
            <span>{statusText()}</span>
          </span>
        </button>
        <div className="cb-srv-actions">
          {isActive && <span className="cb-tag">{t('servers.current')}</span>}
          {(server.isDefault || server.token) && (
            <button
              type="button"
              className="cb-icon-btn"
              onClick={e => {
                e.stopPropagation()
                setShowShare(v => !v)
              }}
              title={t('servers.share')}
              aria-label={t('servers.share')}
            >
              <ShareIcon size={14} />
            </button>
          )}
          <button
            type="button"
            className="cb-icon-btn"
            onClick={e => {
              e.stopPropagation()
              onCheckHealth()
            }}
            title={statusTitle()}
            aria-label={statusTitle()}
          >
            {health?.status === 'checking' ? <SpinnerIcon size={14} className="animate-spin" /> : <Activity size={14} />}
          </button>
          <button
            type="button"
            className="cb-icon-btn"
            onClick={e => {
              e.stopPropagation()
              setEditing(true)
            }}
            title={t('servers.editServer')}
            aria-label={t('servers.editServer')}
          >
            <PencilIcon size={14} />
          </button>
          {!server.isDefault && (
            <button
              type="button"
              className="cb-icon-btn"
              data-danger=""
              onClick={e => {
                e.stopPropagation()
                setConfirmDelete(true)
              }}
              title={t('common:remove')}
              aria-label={t('common:remove')}
            >
              <TrashIcon size={14} />
            </button>
          )}
        </div>
      </div>

      {showShare && <SharePanel server={server} />}

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          onDelete()
        }}
        title={t('servers.deleteServer')}
        description={t('servers.deleteServerConfirm', { name: server.name })}
        confirmText={t('common:delete')}
        cancelText={t('common:cancel')}
        variant="danger"
      />
    </>
  )
}

// ============================================
// Share Panel (local server)
// ============================================

function SharePanel({ server }: { server: ServerConfig }) {
  const { t } = useTranslation(['settings', 'common'])
  const [share, setShare] = useState<ShareInfo | null>(null)
  const [error, setError] = useState('')
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)

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

  const copy = async (value: string, mark: (value: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(value)
      mark(true)
      setTimeout(() => mark(false), 2000)
    } catch {
      // 剪贴板不可用时用户还可以手动选中复制
    }
  }

  // 提示按暴露模式分流：公网入口（反代/隧道）→ HTTPS 与权限警示；
  // 局域网 → 谨慎分享；仅本机 → 指路服务设置
  const hint = share?.public
    ? t('servers.sharePublicHint')
    : share?.lan
      ? t('servers.shareLanHint')
      : t('servers.shareLoopbackHint')

  return (
    <div className="space-y-2 border-b border-border-200/60 bg-bg-100/60 px-4 py-3 last:border-b-0">
      <div className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('servers.shareTitle')}</div>
      {error && <p className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      {!share && !error && <p className="text-[length:var(--fs-xs)] text-text-400">{t('servers.checking')}</p>}
      {share && (
        <>
          <div>
            <div className="text-[length:var(--fs-xs)] text-text-400 mb-1">{t('servers.shareBrowserUrl')}</div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                readOnly
                value={share.url}
                onFocus={e => e.target.select()}
                className={`${settingsFieldClass} font-mono flex-1`}
              />
              <a
                href={share.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 p-2 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200/70 transition-colors"
                title={t('servers.shareOpenUrl')}
                aria-label={t('servers.shareOpenUrl')}
              >
                <ExternalLinkIcon size={13} />
              </a>
              <button
                type="button"
                onClick={() => void copy(share.url, setCopiedUrl)}
                className="shrink-0 p-2 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200/70 transition-colors"
                title={copiedUrl ? t('servers.shareCopied') : t('servers.shareCopy')}
                aria-label={copiedUrl ? t('servers.shareCopied') : t('servers.shareCopy')}
              >
                {copiedUrl ? <CheckIcon size={13} className="text-success-100" /> : <CopyIcon size={13} />}
              </button>
            </div>
          </div>
          <div>
            <div className="text-[length:var(--fs-xs)] text-text-400 mb-1">{t('servers.shareConnectLink')}</div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                readOnly
                value={share.link}
                onFocus={e => e.target.select()}
                className={`${settingsFieldClass} font-mono flex-1`}
              />
              <button
                type="button"
                onClick={() => void copy(share.link, setCopiedLink)}
                className="shrink-0 p-2 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200/70 transition-colors"
                title={copiedLink ? t('servers.shareCopied') : t('servers.shareCopy')}
                aria-label={copiedLink ? t('servers.shareCopied') : t('servers.shareCopy')}
              >
                {copiedLink ? <CheckIcon size={13} className="text-success-100" /> : <CopyIcon size={13} />}
              </button>
            </div>
          </div>
          <p className="text-[length:var(--fs-xs)] text-text-400 leading-relaxed">{hint}</p>
          {share.tunnel && (
            <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-500">
              {share.tunnel.connected ? t('servers.shareTunnelHint') : t('servers.shareTunnelOffline')}
            </p>
          )}
        </>
      )}
    </div>
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
  const [showAuth, setShowAuth] = useState(!!server.token)
  const [error, setError] = useState('')
  const showHttpsIpWarning = isHttpsIpUrl(url)

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

  const inputCls = settingsFieldClass

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-2.5 border-b border-border-200/60 bg-accent-main-100/[0.03] px-4 py-3 last:border-b-0"
    >
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.name')}</label>
        <input
          type="text"
          value={name}
          maxLength={SERVER_NAME_MAX_LENGTH}
          onChange={e => {
            setName(e.target.value.slice(0, SERVER_NAME_MAX_LENGTH))
            setError('')
          }}
          placeholder={t('servers.namePlaceholder')}
          className={inputCls}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.url')}</label>
        <input
          type="text"
          value={url}
          onChange={e => {
            setUrl(e.target.value)
            setError('')
          }}
          placeholder={t('servers.urlPlaceholder')}
          className={`${inputCls} font-mono`}
        />
      </div>

      <button
        type="button"
        onClick={() => setShowAuth(!showAuth)}
        className="flex items-center gap-1.5 text-[length:var(--fs-xs)] text-accent-main-100 hover:text-accent-main-200 transition-colors"
      >
        <KeyIcon size={10} />
        {showAuth ? t('servers.hideAuth') : t('servers.addAuth')}
      </button>

      {showAuth && (
        <div>
          <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.token')}</label>
          <input
            type="password"
            value={token}
            onChange={e => {
              setToken(e.target.value)
              setError('')
            }}
            placeholder={t('servers.tokenPlaceholder')}
            className={`${inputCls} font-mono`}
          />
        </div>
      )}

      {showHttpsIpWarning && (
        <div className="text-[length:var(--fs-xs)] text-warning-100 bg-warning-bg border border-warning-100/20 rounded-md px-2.5 py-2 leading-relaxed">
          {t('servers.httpsIpWarning')}
        </div>
      )}

      {error && <p className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common:cancel')}
        </Button>
        <Button type="submit" size="sm">
          {t('common:save')}
        </Button>
      </div>
    </form>
  )
}

// ============================================
// Tab: Servers
// ============================================

export function ServersSettings({ initialAddingServer = false }: { initialAddingServer?: boolean }) {
  const { t } = useTranslation(['settings', 'common'])
  const [addingServer, setAddingServer] = useState(initialAddingServer)
  const desktop = isTauri() && !isTauriMobile()
  const {
    servers,
    activeServer,
    addServer,
    removeServer,
    updateServer,
    setActiveServer,
    checkHealth,
    checkAllHealth,
    getHealth,
  } = useServerStore()
  const { navigateHome, sessionId: routeSessionId } = useRouter()
  const orderedServers = useMemo(() => {
    if (!activeServer) return servers
    const active = servers.find(s => s.id === activeServer.id)
    if (!active) return servers
    return [active, ...servers.filter(s => s.id !== active.id)]
  }, [servers, activeServer])

  useEffect(() => {
    checkAllHealth()
  }, [checkAllHealth])

  // 切换服务器：设置 active + 清理当前 session + 导航回首页
  const handleSelectServer = useCallback(
    (id: string) => {
      if (activeServer?.id === id) return // 没变，不做事

      // 清理当前 session 的 store 状态
      if (routeSessionId) {
        clearSessionRuntimeState(routeSessionId)
      }

      setActiveServer(id) // 内部触发 serverChangeListeners → reconnectSSE()
      navigateHome()
      void checkHealth(id)
    },
    [activeServer?.id, checkHealth, routeSessionId, setActiveServer, navigateHome],
  )

  return (
    <div className="cb-page">
      <PageHead
        title={t('servers.connections')}
        description={t('servers.connectionsDesc')}
        aside={
          <>
            <button
              type="button"
              onClick={checkAllHealth}
              className="cb-btn"
              data-size="icon"
              title={t('common:refresh')}
              aria-label={t('common:refresh')}
            >
              <RetryIcon size={14} />
            </button>
            <button type="button" onClick={() => setAddingServer(true)} disabled={addingServer} className="cb-btn">
              <PlusIcon size={14} />
              {t('common:add')}
            </button>
          </>
        }
      />

      {addingServer && (
        <section className="cb-srv-form">
          <AddServerForm
            hint={t('servers.keyStoredHere')}
            onAdd={(server, paired) => {
              const s = addServer(server)
              setAddingServer(false)
              if (paired) handleSelectServer(s.id)
              else void checkHealth(s.id)
            }}
            onCancel={() => setAddingServer(false)}
          />
        </section>
      )}

      {servers.length > 0 ? (
        <div className="cb-srv-list">
          {orderedServers.map(s => (
            <ServerItem
              key={s.id}
              server={s}
              health={getHealth(s.id)}
              isActive={activeServer?.id === s.id}
              onSelect={() => handleSelectServer(s.id)}
              onDelete={() => removeServer(s.id)}
              onEdit={updates => {
                updateServer(s.id, { name: updates.name, url: updates.url, token: updates.token })
                void checkHealth(s.id)
              }}
              onCheckHealth={() => void checkHealth(s.id)}
            />
          ))}
          {desktop && <Suspense fallback={null}><DshServerRows /></Suspense>}
        </div>
      ) : (
        !addingServer && <p className="cb-empty">{t('servers.noServersConfigured')}</p>
      )}
      {desktop && <p className="cb-footnote">{t('servers.dshFootnote')}</p>}
    </div>
  )
}
