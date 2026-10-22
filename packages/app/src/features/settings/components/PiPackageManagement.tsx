import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import type { OmpResolvedPackageResources, PiConfiguredPackage, PiMarketplaceSource, PiPackageUpdate, PiPackagesSnapshot } from '../../../omp/domain'
import {
  changePiPackageSource,
  checkPiPackageUpdates,
  getPiPackageInstalledPath,
  listPiPackages,
  managePiPackage,
  resolvePiExtensionSources,
  resolvePiPackages,
} from '../../../omp/transport/index.js'
import { Toggle, SettingsSection, SettingsDisclosure, settingsFieldClass } from './SettingsUI'

export function PiPackageManagement({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const [packages, setPackages] = useState<PiConfiguredPackage[]>([])
  const [marketplaces, setMarketplaces] = useState<PiMarketplaceSource[]>([])
  const [updates, setUpdates] = useState<PiPackageUpdate[]>([])
  const [resolved, setResolved] = useState<OmpResolvedPackageResources | null>(null)
  const [source, setSource] = useState('')
  const [marketplaceSource, setMarketplaceSource] = useState('')
  const [projectLocal, setProjectLocal] = useState(false)
  const [installedPaths, setInstalledPaths] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applySnapshot = useCallback((snapshot: PiPackagesSnapshot) => {
    setPackages(snapshot.packages)
    setMarketplaces(snapshot.marketplaces)
  }, [])

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const snapshot = await listPiPackages(workspacePath, signal)
      if (signal.aborted) return
      applySnapshot(snapshot)
      setError(null)
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workspacePath, applySnapshot])

  useEffect(() => {
    setPackages([])
    setMarketplaces([])
    setUpdates([])
    setResolved(null)
    setInstalledPaths({})
    const controller = new AbortController()
    const timer = window.setTimeout(() => { void load(controller.signal) }, 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [load])

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const manage = async (action: 'install' | 'link' | 'remove' | 'update' | 'enable' | 'disable', packageSource?: string, local = projectLocal) => {
    applySnapshot(await managePiPackage(workspacePath, {
      commandId: crypto.randomUUID(), action, source: packageSource, local,
    }))
    if (action === 'install' || action === 'link') setSource('')
    // Reading/managing a plugin never silently performs a network update check.
    setUpdates([])
    setResolved(null)
    setInstalledPaths({})
  }
  const hasManagedScopePackages = packages.some(item => item.scope === (projectLocal ? 'project' : 'user') && (item.type === 'marketplace' || item.scope === 'user'))

  return (
    <SettingsSection title={t('pi.packagesTitle')} description={t('pi.packagesDescription')}>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      {busy ? <p role="status" aria-live="polite" className="text-[length:var(--fs-xs)] text-text-300">{t('pi.packageOperationPending')}</p> : null}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <input className={settingsFieldClass} disabled={busy !== null} aria-label={t('pi.pluginSource')} placeholder={t('pi.sourcePlaceholder')} value={source} onChange={event => setSource(event.target.value)} />
        <Button size="sm" disabled={busy !== null || !source.trim()} isLoading={busy === 'install'} onClick={() => void run('install', () => manage('install', source.trim()))}>{t('pi.install')}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Toggle enabled={projectLocal} disabled={busy !== null} onChange={() => setProjectLocal(value => !value)} ariaLabel={t('pi.projectScopeLabel')} />
          <span className="text-[length:var(--fs-xs)] text-text-300">{t('pi.projectScopeLabel')}</span>
        </div>
        <Button size="sm" variant="secondary" disabled={busy !== null || !source.trim() || projectLocal} onClick={() => void run('link', () => manage('link', source.trim()))}>{t('pi.linkPlugin')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null || !source.trim()} onClick={() => void run('resolve-source', async () => setResolved(await resolvePiExtensionSources(workspacePath, [source.trim()], { local: projectLocal })))}>{t('pi.resolveSource')}</Button>
      </div>
      <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.nativePluginScopeDescription')}</p>

      <SettingsDisclosure title={t('pi.marketplaceSources')} defaultOpen>
        <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.marketplaceSourcesDescription')}</p>
        <div className="flex gap-2">
          <input className={settingsFieldClass} disabled={busy !== null} aria-label={t('pi.marketplaceSources')} placeholder={t('pi.marketplaceSourcePlaceholder')} value={marketplaceSource} onChange={event => setMarketplaceSource(event.target.value)} />
          <Button size="sm" variant="secondary" disabled={busy !== null || !marketplaceSource.trim()} onClick={() => void run('add-marketplace', async () => {
            applySnapshot(await changePiPackageSource(workspacePath, marketplaceSource.trim(), 'add'))
            setUpdates([])
            setMarketplaceSource('')
          })}>{t('pi.addMarketplace')}</Button>
        </div>
        {marketplaces.map(item => (
          <div key={item.name} className="flex items-center gap-2 text-[length:var(--fs-xs)]">
            <span className="min-w-0 flex-1 break-all text-text-300">{item.name} · {item.source}</span>
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run(`marketplace:${item.name}`, async () => {
              applySnapshot(await changePiPackageSource(workspacePath, item.name, 'remove'))
              setUpdates([])
            })}>{t('pi.removeMarketplace')}</Button>
          </div>
        ))}
      </SettingsDisclosure>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('refresh', async () => {
          applySnapshot(await listPiPackages(workspacePath))
          setUpdates([])
          setResolved(null)
          setInstalledPaths({})
        })}>{t('common:refresh')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('resolve', async () => setResolved(await resolvePiPackages(workspacePath)))}>{t('pi.resolveConfigured')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('updates', async () => setUpdates(await checkPiPackageUpdates(workspacePath)))}>{t('pi.checkUpdates')}</Button>
        <Button size="sm" disabled={busy !== null || !hasManagedScopePackages} onClick={() => void run('update-all', () => manage('update'))}>{t('pi.updateScope')}</Button>
      </div>
      <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.nativePluginUpdatesDescription')}</p>

      {updates.length ? (
        <div className="space-y-1 rounded-lg border border-border-200 bg-bg-100 p-2">
          {updates.map(update => (
            <div key={`${update.scope}:${update.source}`} className="flex items-center gap-2 text-[length:var(--fs-xs)]">
              <span className="min-w-0 flex-1 truncate text-text-300">{update.displayName} · {update.scope} · {update.from} → {update.to}</span>
              <Button size="sm" disabled={busy !== null} onClick={() => void run(`update:${update.source}`, () => manage('update', update.source, update.scope === 'project'))}>{t('pi.update')}</Button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {packages.map(item => {
          const key = `${item.scope}:${item.source}`
          const nativeManaged = item.type === 'marketplace' || item.scope === 'user'
          return (
            <div key={key} className="space-y-1 rounded-lg border border-border-200 bg-bg-100 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-44 flex-1">
                  <p className="truncate text-[length:var(--fs-sm)] text-text-200">{item.source} · {item.version}</p>
                  <p className="text-[length:var(--fs-xs)] text-text-400">{item.scope} · {item.type} · {t(item.enabled ? 'pi.resourceOn' : 'pi.resourceOff')}{item.shadowedBy ? ` · ${t('pi.pluginShadowed')}` : ''}</p>
                </div>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`path:${key}`, async () => {
                  const path = await getPiPackageInstalledPath(workspacePath, item.source, item.scope)
                  setInstalledPaths(paths => ({ ...paths, [key]: path }))
                })}>{t('pi.showPath')}</Button>
                {nativeManaged ? <>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`enabled:${key}`, () => manage(item.enabled ? 'disable' : 'enable', item.source, item.scope === 'project'))}>{t(item.enabled ? 'pi.disablePlugin' : 'pi.enablePlugin')}</Button>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`update:${key}`, () => manage('update', item.source, item.scope === 'project'))}>{t('pi.update')}</Button>
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run(`remove:${key}`, () => manage('remove', item.source, item.scope === 'project'))}>{t('pi.uninstall')}</Button>
                </> : <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.projectNpmReadOnly')}</p>}
              </div>
              {installedPaths[key] ? <p className="break-all text-[length:var(--fs-xs)] text-text-400">{installedPaths[key]}</p> : null}
            </div>
          )
        })}
      </div>

      {resolved ? (
        <SettingsDisclosure title={t('pi.resolvedResources')} defaultOpen>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-[length:var(--fs-xs)]">
            {(['extensions', 'tools', 'hooks', 'commands', 'skills', 'prompts', 'rules', 'mcpServers'] as const).map(kind => (
              <div key={kind}>
                <p className="font-medium text-text-300">{kind} ({resolved[kind].length})</p>
                {resolved[kind].map(item => (
                  <p key={`${item.source}:${item.path}:${item.name ?? ''}`} className="truncate text-text-500" title={item.path}>{item.enabled ? t('pi.resourceOn') : t('pi.resourceOff')}: {item.name ?? item.path}</p>
                ))}
              </div>
            ))}
          </div>
          {resolved.warnings.map((warning, index) => <p key={`${index}:${warning}`} className="break-all text-[length:var(--fs-xs)] text-warning-100">{warning}</p>)}
        </SettingsDisclosure>
      ) : null}
    </SettingsSection>
  )
}
