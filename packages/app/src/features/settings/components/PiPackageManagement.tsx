import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
import { registerSessionConsumer } from '../../../hooks/useGlobalEvents'
import { piEventStream } from '../../../omp/eventStream'
import { getManagementEventSnapshot, restorePackageOperations, USER_RESOURCE_SCOPE, useManagementEvents } from '../../../omp/managementEventStore'
import { serverStore } from '../../../store/serverStore'
import { Toggle, SettingsSection, SettingsDisclosure, settingsFieldClass } from './SettingsUI'

function packageRevision(revisions: Record<string, string>, workspacePath: string): string {
  return JSON.stringify([revisions[USER_RESOURCE_SCOPE], revisions[workspacePath]])
}

export function PiPackageManagement({ workspacePath }: { workspacePath: string }) {
  return <PackageManagement key={workspacePath} workspacePath={workspacePath} />
}

function PackageManagement({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const [packages, setPackages] = useState<PiConfiguredPackage[]>([])
  const [marketplaces, setMarketplaces] = useState<PiMarketplaceSource[]>([])
  const [updates, setUpdates] = useState<PiPackageUpdate[]>([])
  const [resolved, setResolved] = useState<OmpResolvedPackageResources | null>(null)
  const [source, setSource] = useState('')
  const [marketplaceSource, setMarketplaceSource] = useState('')
  const [projectLocal, setProjectLocal] = useState(false)
  const [installedPaths, setInstalledPaths] = useState<Record<string, string>>({})
  const [localBusy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { packageProgress, resourceRevisions } = useManagementEvents()
  const revision = packageRevision(resourceRevisions, workspacePath)
  const operations = Object.values(packageProgress).filter(item => !item.workspacePath || item.workspacePath === workspacePath)
  const running = operations.some(item => item.phase === 'started')
  const latest = operations.at(-1)
  const busy = localBusy ?? (running ? 'remote' : null)
  const consumerId = useId()
  const read = useRef<AbortController | null>(null)
  const origin = useRef<AbortController | null>(null)

  const clearDerived = useCallback(() => {
    setUpdates([])
    setResolved(null)
    setInstalledPaths({})
  }, [])
  const applySnapshot = useCallback((snapshot: PiPackagesSnapshot) => {
    read.current?.abort()
    setPackages(snapshot.packages)
    setMarketplaces(snapshot.marketplaces)
    clearDerived()
  }, [clearDerived])

  const load = useCallback(async () => {
    const generation = serverStore.getActiveServerGeneration()
    const before = getManagementEventSnapshot()
    const version = packageRevision(before.resourceRevisions, workspacePath)
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    const current = () => !controller.signal.aborted && generation === serverStore.getActiveServerGeneration() &&
      version === packageRevision(getManagementEventSnapshot().resourceRevisions, workspacePath)
    clearDerived()
    try {
      const snapshot = await listPiPackages(workspacePath, controller.signal)
      if (!current()) return
      applySnapshot(snapshot)
      restorePackageOperations(workspacePath, snapshot.activeOperations ?? [], before.packageProgress)
      setError(null)
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workspacePath, applySnapshot, clearDerived])

  useEffect(() => {
    const controller = new AbortController()
    origin.current = controller
    const unsubscribe = registerSessionConsumer(consumerId, null, { onReconnected: () => { void load() } })
    piEventStream.connectWorkspace(workspacePath)
    return () => {
      controller.abort()
      read.current?.abort()
      unsubscribe()
      piEventStream.disconnectWorkspace(workspacePath)
    }
  }, [consumerId, load, workspacePath])

  useEffect(() => {
    void load()
    return () => read.current?.abort()
  }, [load, revision])

  const run = async (key: string, action: (current: () => boolean, sameOrigin: () => boolean) => Promise<void>) => {
    const controller = origin.current
    const generation = serverStore.getActiveServerGeneration()
    const sameOrigin = () => !!controller && !controller.signal.aborted && generation === serverStore.getActiveServerGeneration()
    const current = () => sameOrigin() && revision === packageRevision(getManagementEventSnapshot().resourceRevisions, workspacePath)
    setBusy(key)
    setError(null)
    try {
      await action(current, sameOrigin)
    } catch (cause) {
      if (sameOrigin()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sameOrigin()) setBusy(null)
    }
  }

  const manage = (action: 'install' | 'link' | 'remove' | 'update' | 'enable' | 'disable', packageSource?: string, local = projectLocal) => async (current: () => boolean, sameOrigin: () => boolean) => {
    const snapshot = await managePiPackage(workspacePath, {
      commandId: crypto.randomUUID(), action, source: packageSource, local,
    })
    if (current()) applySnapshot(snapshot)
    if (sameOrigin() && (action === 'install' || action === 'link')) setSource('')
  }
  const changeMarketplace = (value: string, operation: 'add' | 'remove') => async (current: () => boolean, sameOrigin: () => boolean) => {
    const snapshot = await changePiPackageSource(workspacePath, value, operation)
    if (current()) applySnapshot(snapshot)
    if (sameOrigin() && operation === 'add') setMarketplaceSource('')
  }
  const hasManagedScopePackages = packages.some(item => item.scope === (projectLocal ? 'project' : 'user') && (item.type === 'marketplace' || item.scope === 'user'))

  return (
    <SettingsSection title={t('pi.packagesTitle')} description={t('pi.packagesDescription')}>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      {busy ? <p role="status" aria-live="polite" className="text-[length:var(--fs-xs)] text-text-300">{t('pi.packageOperationPending')}</p>
        : !error && latest?.phase === 'failed' ? <p role="alert" className="break-words text-[length:var(--fs-xs)] text-danger-100">{t('pi.packageOperationFailed', { message: latest.message ?? '' })}</p>
        : latest?.phase === 'completed' ? <p role="status" className="text-[length:var(--fs-xs)] text-text-400">{t('pi.packageOperationCompleted')}</p> : null}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <input className={settingsFieldClass} disabled={busy !== null} aria-label={t('pi.pluginSource')} placeholder={t('pi.sourcePlaceholder')} value={source} onChange={event => setSource(event.target.value)} />
        <Button size="sm" disabled={busy !== null || !source.trim()} isLoading={busy === 'install'} onClick={() => void run('install', manage('install', source.trim()))}>{t('pi.install')}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Toggle enabled={projectLocal} disabled={busy !== null} onChange={() => setProjectLocal(value => !value)} ariaLabel={t('pi.projectScopeLabel')} />
          <span className="text-[length:var(--fs-xs)] text-text-300">{t('pi.projectScopeLabel')}</span>
        </div>
        <Button size="sm" variant="secondary" disabled={busy !== null || !source.trim() || projectLocal} onClick={() => void run('link', manage('link', source.trim()))}>{t('pi.linkPlugin')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null || !source.trim()} onClick={() => void run('resolve-source', async current => {
          const result = await resolvePiExtensionSources(workspacePath, [source.trim()], { local: projectLocal })
          if (current()) setResolved(result)
        })}>{t('pi.resolveSource')}</Button>
      </div>
      <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.nativePluginScopeDescription')}</p>

      <SettingsDisclosure title={t('pi.marketplaceSources')} defaultOpen>
        <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.marketplaceSourcesDescription')}</p>
        <div className="flex gap-2">
          <input className={settingsFieldClass} disabled={busy !== null} aria-label={t('pi.marketplaceSources')} placeholder={t('pi.marketplaceSourcePlaceholder')} value={marketplaceSource} onChange={event => setMarketplaceSource(event.target.value)} />
          <Button size="sm" variant="secondary" disabled={busy !== null || !marketplaceSource.trim()} onClick={() => void run('add-marketplace', changeMarketplace(marketplaceSource.trim(), 'add'))}>{t('pi.addMarketplace')}</Button>
        </div>
        {marketplaces.map(item => (
          <div key={item.name} className="flex items-center gap-2 text-[length:var(--fs-xs)]">
            <span className="min-w-0 flex-1 break-all text-text-300">{item.name} · {item.source}</span>
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run(`marketplace:${item.name}`, changeMarketplace(item.name, 'remove'))}>{t('pi.removeMarketplace')}</Button>
          </div>
        ))}
      </SettingsDisclosure>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={localBusy !== null} onClick={() => void run('refresh', load)}>{t('common:refresh')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('resolve', async current => {
          const result = await resolvePiPackages(workspacePath)
          if (current()) setResolved(result)
        })}>{t('pi.resolveConfigured')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('updates', async current => {
          const result = await checkPiPackageUpdates(workspacePath)
          if (current()) setUpdates(result)
        })}>{t('pi.checkUpdates')}</Button>
        <Button size="sm" disabled={busy !== null || !hasManagedScopePackages} onClick={() => void run('update-all', manage('update'))}>{t('pi.updateScope')}</Button>
      </div>
      <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.nativePluginUpdatesDescription')}</p>

      {updates.length ? (
        <div className="space-y-1 rounded-lg border border-border-200 bg-bg-100 p-2">
          {updates.map(update => (
            <div key={`${update.scope}:${update.source}`} className="flex items-center gap-2 text-[length:var(--fs-xs)]">
              <span className="min-w-0 flex-1 truncate text-text-300">{update.displayName} · {update.scope} · {update.from} → {update.to}</span>
              <Button size="sm" disabled={busy !== null} onClick={() => void run(`update:${update.source}`, manage('update', update.source, update.scope === 'project'))}>{t('pi.update')}</Button>
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
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`path:${key}`, async current => {
                  const path = await getPiPackageInstalledPath(workspacePath, item.source, item.scope)
                  if (current()) setInstalledPaths(paths => ({ ...paths, [key]: path }))
                })}>{t('pi.showPath')}</Button>
                {nativeManaged ? <>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`enabled:${key}`, manage(item.enabled ? 'disable' : 'enable', item.source, item.scope === 'project'))}>{t(item.enabled ? 'pi.disablePlugin' : 'pi.enablePlugin')}</Button>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`update:${key}`, manage('update', item.source, item.scope === 'project'))}>{t('pi.update')}</Button>
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run(`remove:${key}`, manage('remove', item.source, item.scope === 'project'))}>{t('pi.uninstall')}</Button>
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
