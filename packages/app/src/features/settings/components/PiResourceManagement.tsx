import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Files, LoaderCircle, MessageSquareText, Puzzle, RefreshCw, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react'
import type { PromptTemplate, Skill } from '../../../omp/vendor/pi-coding-agent'
import type { RegistrySnapshot } from '@ompiui/protocol'
import { Button } from '../../../components/ui/Button'
import { JsonView } from '../../../components/JsonView'
import { extensionUiStore } from '../../../omp/extensionUiStore'
import { useManagementEvents } from '../../../omp/managementEventStore'
import { getPiAgentsFiles, getPiPrompts, getPiSkills, getPiSessionRegistry } from '../../../omp/transport/index.js'
import { reloadPiSessionResources } from '../../../omp/controllers/index.js'
import { SettingsSection, SettingsSubgroup, SettingsDisclosure, settingsFieldClass } from './SettingsUI'
import { serverStore } from '../../../store/serverStore'

/**
 * Session resource inspector over the native runtime registry (registry.get).
 * Extensions, tools, commands and event handlers come straight from the
 * session's extension runner; reload goes through the native reload command.
 * Skills, prompt templates and AGENTS/CLAUDE context come from the native
 * skills.list / prompts.list / agentsFiles.list (SDK resource loader).
 */
export function PiResourceManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const serverGeneration = useSyncExternalStore(listener => serverStore.subscribe(listener), () => serverStore.getActiveServerGeneration(), () => serverStore.getActiveServerGeneration())
  const scope = JSON.stringify([serverGeneration, sessionId, workspacePath])
  const currentScope = useRef(scope)
  useEffect(() => {
    currentScope.current = scope
  }, [scope])
  const request = useRef<AbortController | null>(null)
  const [data, setData] = useState<{
    scope: string
    registry: RegistrySnapshot | null
    skills: Skill[] | null
    prompts: PromptTemplate[] | null
    agentsFiles: Array<{ path: string; content: string }> | null
    errors: Record<string, string>
    loading: boolean
  } | null>(null)
  const visible = data?.scope === scope ? data : null
  const registry = visible?.registry ?? null
  const skills = visible?.skills ?? null
  const prompts = visible?.prompts ?? null
  const agentsFiles = visible?.agentsFiles ?? null
  const errors = visible?.errors ?? {}
  const loading = visible?.loading ?? true
  const [eventType, setEventType] = useState('')
  const [handlerResult, setHandlerResult] = useState<{ scope: string; eventType: string; registered: boolean } | null>(null)
  const [operation, setOperation] = useState<{ scope: string; key: string } | null>(null)
  const busy = operation?.scope === scope ? operation.key : null
  const [actionError, setActionError] = useState<{ scope: string; message: string } | null>(null)
  const error = actionError?.scope === scope ? actionError.message : null
  const { resourceRevisions } = useManagementEvents()
  const resourceRevision = resourceRevisions[workspacePath]
  const extensionUi = useSyncExternalStore(extensionUiStore.subscribe, extensionUiStore.getSnapshot, extensionUiStore.getSnapshot)

  const load = useCallback(async () => {
    if (currentScope.current !== scope) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setHandlerResult(null)
    setData({ scope, registry: null, skills: null, prompts: null, agentsFiles: null, errors: {}, loading: true })
    if (!sessionId) return
    const results = await Promise.allSettled([
      getPiSessionRegistry(sessionId, controller.signal),
      getPiSkills(sessionId, controller.signal),
      getPiPrompts(sessionId, controller.signal),
      getPiAgentsFiles(sessionId, controller.signal),
    ])
    if (controller.signal.aborted || currentScope.current !== scope) return
    const nextErrors: Record<string, string> = {}
    const readList = <T,>(index: number, key: string): T[] | null => {
      const result = results[index]
      if (result.status === 'fulfilled' && Array.isArray(result.value)) return result.value as T[]
      nextErrors[key] = result.status === 'rejected' ? String(result.reason instanceof Error ? result.reason.message : result.reason) : t('pi.resourcesUnavailable')
      return null
    }
    const registryResult = results[0]
    let nextRegistry: RegistrySnapshot | null = null
    if (registryResult.status === 'fulfilled' && registryResult.value && typeof registryResult.value === 'object' && !Array.isArray(registryResult.value)) {
      nextRegistry = registryResult.value as RegistrySnapshot
    } else {
      nextErrors.registry = registryResult.status === 'rejected' ? String(registryResult.reason instanceof Error ? registryResult.reason.message : registryResult.reason) : t('pi.resourcesUnavailable')
    }
    setData({ scope, registry: nextRegistry, skills: readList<Skill>(1, 'skills'), prompts: readList<PromptTemplate>(2, 'prompts'), agentsFiles: readList<{ path: string; content: string }>(3, 'contextFiles'), errors: nextErrors, loading: false })
  }, [scope, sessionId, t])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    const onRegistryUpdated = (event: Event) => {
      const updatedSessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
      if (updatedSessionId === sessionId) void load()
    }
    window.addEventListener('ompiui:registry-updated', onRegistryUpdated)
    return () => {
      request.current?.abort()
      window.clearTimeout(timer)
      window.removeEventListener('ompiui:registry-updated', onRegistryUpdated)
    }
  }, [load, resourceRevision, sessionId])

  const run = async (key: string, action: () => Promise<void>) => {
    setOperation({ scope, key })
    setActionError(null)
    try {
      await action()
    } catch (cause) {
      if (currentScope.current === scope) setActionError({ scope, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (currentScope.current === scope) setOperation(null)
    }
  }

  if (!sessionId) {
    return (
      <SettingsSection title={t('pi.resourcesTitle')} description={t('pi.resourcesDescription')}>
        <div className="flex min-w-0 items-start gap-3 rounded-lg bg-bg-200/40 p-3 text-[length:var(--fs-xs)] leading-relaxed text-text-300">
          <Files size={18} className="mt-0.5 shrink-0 text-text-400" aria-hidden="true" />
          <p>{t('pi.resourcesOpenSession')}</p>
        </div>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title={t('pi.resourcesTitle')}
      description={t('pi.resourcesDescription')}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={loading || busy !== null} onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" />
            {t('common:refresh')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            isLoading={busy === 'reload'}
            onClick={() => void run('reload', async () => { await reloadPiSessionResources(sessionId); await load() })}
          >
            {busy !== 'reload' ? <RefreshCw size={14} aria-hidden="true" /> : null}
            {t('common:reload')}
          </Button>
        </div>
      }
    >
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100 [overflow-wrap:anywhere]">{error}</p> : null}
      {Object.entries(errors).map(([name, message]) => <p key={name} role="alert" className="text-[length:var(--fs-xs)] text-danger-100 [overflow-wrap:anywhere]">{t(`pi.${name === 'registry' ? 'registryData' : name === 'contextFiles' ? 'agentsFiles' : name}`)}: {message}</p>)}
      {Array.isArray(registry?.skillWarnings) && registry.skillWarnings.length > 0 ? <JsonDetails title={t('pi.resourcesSkillWarnings')} value={registry.skillWarnings} /> : null}
      {registry?.resourceErrors && Object.keys(registry.resourceErrors).length > 0 ? <JsonDetails title={t('pi.resourcesDiscoveryErrors')} value={registry.resourceErrors} /> : null}

      {loading && !registry && !skills && !prompts && !agentsFiles ? (
        <p role="status" className="flex items-center gap-2 py-3 text-[length:var(--fs-sm)] text-text-400">
          <LoaderCircle size={16} className="shrink-0 animate-spin" aria-hidden="true" />
          {t('pi.resourcesLoading')}
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2" aria-busy={loading}>
          <SettingsSubgroup title={t('pi.resourcesCapabilities')} className="min-w-0">
            <ResourceList
              title={t('pi.tools')}
              description={t('pi.resourceToolsDescription')}
              icon={Wrench}
              loading={loading}
              error={errors.registry}
              summary={Array.isArray(registry?.activeTools) && Array.isArray(registry?.tools) ? t('pi.resourcesToolsActive', { active: registry.activeTools.length, total: registry.tools.length }) : undefined}
              items={Array.isArray(registry?.tools) ? registry.tools.map(item => ({
                name: item.name,
                detail: item.description,
                status: Array.isArray(registry.activeTools) && !registry.activeTools.includes(item.name) ? t('pi.inactive') : undefined,
              })) : null}
            />
            <ResourceList
              title={t('pi.extensions')}
              description={t('pi.resourceExtensionsDescription')}
              icon={Puzzle}
              loading={loading}
              error={errors.registry || (registry?.resourceErrors?.extensions ? String(registry.resourceErrors.extensions) : undefined)}
              items={Array.isArray(registry?.extensions) ? registry.extensions.map(item => ({
                name: item.path,
                detail: t('pi.extensionDetail', { tools: item.tools.length, commands: item.commands.length, handlers: item.handlers.length }),
                path: item.sourceInfo && typeof item.sourceInfo === 'object' && !Array.isArray(item.sourceInfo) && typeof item.sourceInfo.path === 'string' && item.sourceInfo.path !== item.path ? item.sourceInfo.path : undefined,
                status: item.active === false ? t('pi.inactive') : item.hidden ? t('pi.hidden') : undefined,
              })) : null}
            />
            <ResourceList
              title={t('pi.commands')}
              description={t('pi.resourceCommandsDescription')}
              icon={Terminal}
              loading={loading}
              error={errors.registry}
              items={Array.isArray(registry?.commands) ? registry.commands.map(item => ({ name: item.name, detail: item.description })) : null}
            />
          </SettingsSubgroup>

          <SettingsSubgroup title={t('pi.resourcesKnowledge')} className="min-w-0">
            <ResourceList
              title={t('pi.skills')}
              description={t('pi.resourceSkillsDescription')}
              icon={BookOpen}
              loading={loading}
              error={errors.skills}
              items={skills?.map(item => ({
                name: item.name,
                detail: item.description,
                path: item.filePath,
                status: item.disableModelInvocation || item.hide ? t('pi.skillModelInvocationOff') : undefined,
              })) ?? null}
            />
            <ResourceList
              title={t('pi.prompts')}
              description={t('pi.resourcePromptsDescription')}
              icon={MessageSquareText}
              loading={loading}
              error={errors.prompts}
              items={prompts?.map(item => ({
                name: `${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ''}`,
                detail: item.description,
                path: item.filePath,
                status: !item.filePath ? t('pi.resourcesPromptPathUnavailable') : undefined,
              })) ?? null}
            />
            <ResourceList
              title={t('pi.agentsFiles')}
              description={t('pi.resourceContextDescription')}
              icon={Files}
              loading={loading}
              error={errors.contextFiles}
              items={agentsFiles?.map(item => ({
                name: item.path,
                detail: `${t('pi.agentsFileLines')}: ${item.content.split('\n').length}`,
              })) ?? null}
            />
          </SettingsSubgroup>
        </div>
      )}

      <SettingsDisclosure
        className="min-w-0 border-t border-border-200/60 pt-4"
        title={
          <span className="flex items-center gap-2 py-1 text-[length:var(--fs-sm)] font-medium">
            <Search size={16} className="shrink-0 text-text-400" aria-hidden="true" />
            {t('pi.resourcesAdvanced')}
          </span>
        }
      >
        <div className="min-w-0 space-y-5 pt-1">
          <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('pi.resourcesAdvancedDescription')}</p>
          <SettingsSubgroup>
            <ResourceList
              title={t('pi.eventHandlers')}
              description={t('pi.resourceHandlersDescription')}
              icon={Terminal}
              loading={loading}
              error={errors.registry || (registry?.resourceErrors?.eventHandlers ? String(registry.resourceErrors.eventHandlers) : undefined)}
              items={Array.isArray(registry?.eventHandlers) ? registry.eventHandlers.map(name => ({ name })) : null}
            />
            <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-end">
              <label className="block w-full min-w-0 flex-1">
                <span className="text-[length:var(--fs-xs)] font-medium text-text-200">{t('pi.resourceEventTypeLabel')}</span>
                <input
                  className={`${settingsFieldClass} mt-1.5`}
                  placeholder={t('pi.eventTypePlaceholder')}
                  value={eventType}
                  onChange={event => { setEventType(event.target.value); setHandlerResult(null) }}
                />
              </label>
              <Button
                size="sm"
                variant="secondary"
                className="shrink-0"
                disabled={busy !== null || loading || !eventType.trim() || !Array.isArray(registry?.eventHandlers)}
                onClick={() => { if (Array.isArray(registry?.eventHandlers)) setHandlerResult({ scope, eventType: eventType.trim(), registered: registry.eventHandlers.includes(eventType.trim()) }) }}
              >
                {t('pi.checkHandler')}
              </Button>
            </div>
            {!loading && !Array.isArray(registry?.eventHandlers) ? <p role="status" className="text-[length:var(--fs-xs)] text-text-400">{t('pi.resourcesHandlerUnknown')}</p> : null}
            {handlerResult?.scope === scope ? (
              <p role="status" className="text-[length:var(--fs-xs)] leading-relaxed text-text-300 [overflow-wrap:anywhere]">
                {handlerResult.registered ? t('pi.handlerRegistered', { eventType: handlerResult.eventType }) : t('pi.handlerNotRegistered', { eventType: handlerResult.eventType })}
              </p>
            ) : null}
          </SettingsSubgroup>

          <SettingsSubgroup title={t('pi.resourcesRawData')} className="min-w-0 border-t border-border-200/60 pt-4">
            {registry ? <JsonDetails title={t('pi.registryData')} value={registry} /> : null}
            {extensionUi.sessions[sessionId] ? (
              <JsonDetails title={t('pi.extensionUiState')} value={extensionUi.sessions[sessionId]} />
            ) : (
              <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('pi.resourcesNoExtensionUi')}</p>
            )}
          </SettingsSubgroup>
        </div>
      </SettingsDisclosure>
    </SettingsSection>
  )
}

function ResourceList({ title, description, icon: Icon, items, loading, summary, error }: {
  title: string
  description: string
  icon: LucideIcon
  items: Array<{ name: string; detail?: string; path?: string; status?: string }> | null
  loading: boolean
  summary?: string
  error?: string
}) {
  const { t } = useTranslation(['settings'])
  const populated = items !== null && items.length > 0
  const status = error ? t('pi.resourcesReadFailed') : items === null
    ? t(loading ? 'pi.resourcesLoading' : 'pi.resourcesUnavailable')
    : populated
      ? summary ?? t('pi.resourcesLoadedCount', { count: items.length })
      : t('pi.resourcesEmpty')
  const heading = (
    <span className="flex min-w-0 items-start gap-2.5">
      <Icon size={17} className="mt-0.5 shrink-0 text-text-400" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-left">
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-[length:var(--fs-sm)] font-medium text-text-100 [overflow-wrap:anywhere]">{title}</span>
          <span className={`text-[length:var(--fs-xs)] font-normal ${populated ? 'rounded-md bg-bg-200/60 px-2 py-0.5 text-text-300' : 'text-text-500'}`}>
            {status}
          </span>
        </span>
        <span className="mt-1 block text-[length:var(--fs-xs)] font-normal leading-relaxed text-text-400 [overflow-wrap:anywhere]">{description}</span>
      </span>
    </span>
  )

  if (!populated) {
    return <div className="min-w-0 py-2 pl-5">{heading}</div>
  }

  return (
    <SettingsDisclosure
      title={heading}
      className="min-w-0 [&>button]:w-full [&>button]:py-2 [&>button>span]:min-w-0 [&>button>span]:flex-1"
    >
      <ul className="custom-scrollbar ml-5 max-h-64 min-w-0 divide-y divide-border-200/60 overflow-y-auto pr-1">
        {items.map((item, index) => (
          <li key={`${item.name}:${index}`} className="min-w-0 py-2.5 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="min-w-0 text-[length:var(--fs-sm)] font-medium text-text-200 [overflow-wrap:anywhere]">{item.name}</p>
              {item.status ? <span className="rounded bg-bg-200/60 px-1.5 py-0.5 text-[length:var(--fs-xs)] text-text-400">{item.status}</span> : null}
            </div>
            {item.detail ? <p className="mt-1 whitespace-pre-wrap text-[length:var(--fs-xs)] leading-relaxed text-text-300 [overflow-wrap:anywhere]">{item.detail}</p> : null}
            {item.path ? <p className="mt-1 font-mono text-[length:var(--fs-xs)] leading-relaxed text-text-400 [overflow-wrap:anywhere]">{item.path}</p> : null}
          </li>
        ))}
      </ul>
    </SettingsDisclosure>
  )
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return (
    <SettingsDisclosure title={title} className="min-w-0">
      <JsonView value={value} className="max-h-64 max-w-full [overflow-wrap:anywhere]" />
    </SettingsDisclosure>
  )
}
