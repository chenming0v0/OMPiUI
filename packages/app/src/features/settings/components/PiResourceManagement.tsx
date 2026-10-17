import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Files, LoaderCircle, MessageSquareText, Puzzle, RefreshCw, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react'
import type { PromptTemplate, Skill } from '../../../omp/vendor/pi-coding-agent'
import type { RegistrySnapshot } from '@ompiui/protocol'
import { Button } from '../../../components/ui/Button'
import { JsonView } from '../../../components/JsonView'
import { extensionUiStore } from '../../../omp/extensionUiStore'
import { useManagementEvents } from '../../../omp/managementEventStore'
import { getPiAgentsFiles, getPiPrompts, getPiSkills } from '../../../omp/transport/index.js'
import { loadPiSessionRegistry, reloadPiSessionResources } from '../../../omp/controllers/index.js'
import { SettingsSection, SettingsSubgroup, SettingsDisclosure, settingsFieldClass } from './SettingsUI'

/**
 * Session resource inspector over the native runtime registry (registry.get).
 * Extensions, tools, commands and event handlers come straight from the
 * session's extension runner; reload goes through the native reload command.
 * Skills, prompt templates and AGENTS/CLAUDE context come from the native
 * skills.list / prompts.list / agentsFiles.list (SDK resource loader).
 */
export function PiResourceManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const [registry, setRegistry] = useState<RegistrySnapshot | null>(null)
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [prompts, setPrompts] = useState<PromptTemplate[] | null>(null)
  const [agentsFiles, setAgentsFiles] = useState<Array<{ path: string; content: string }> | null>(null)
  const [eventType, setEventType] = useState('')
  const [handlerResult, setHandlerResult] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { resourceRevisions } = useManagementEvents()
  const resourceRevision = resourceRevisions[workspacePath]
  const extensionUi = useSyncExternalStore(extensionUiStore.subscribe, extensionUiStore.getSnapshot, extensionUiStore.getSnapshot)

  const load = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      setRegistry((await loadPiSessionRegistry(sessionId)) ?? null)
      setSkills((await getPiSkills(sessionId)) ?? null)
      setPrompts((await getPiPrompts(sessionId)) ?? null)
      setAgentsFiles((await getPiAgentsFiles(sessionId)) ?? null)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    const onRegistryUpdated = (event: Event) => {
      const updatedSessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
      if (updatedSessionId === sessionId) void load()
    }
    window.addEventListener('ompiui:registry-updated', onRegistryUpdated)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('ompiui:registry-updated', onRegistryUpdated)
    }
  }, [load, resourceRevision, sessionId])

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
      }
    >
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100 [overflow-wrap:anywhere]">{error}</p> : null}

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
              summary={registry ? t('pi.resourcesToolsActive', { active: registry.activeTools.length, total: registry.tools.length }) : undefined}
              items={registry?.tools.map(item => ({
                name: item.name,
                detail: item.description,
                status: registry.activeTools.includes(item.name) ? undefined : t('pi.inactive'),
              })) ?? null}
            />
            <ResourceList
              title={t('pi.extensions')}
              description={t('pi.resourceExtensionsDescription')}
              icon={Puzzle}
              loading={loading}
              items={registry?.extensions.map(item => ({
                name: item.path,
                detail: t('pi.extensionDetail', { tools: item.tools.length, commands: item.commands.length, handlers: item.handlers.length }),
                status: item.hidden ? t('pi.hidden') : undefined,
              })) ?? null}
            />
            <ResourceList
              title={t('pi.commands')}
              description={t('pi.resourceCommandsDescription')}
              icon={Terminal}
              loading={loading}
              items={registry?.commands.map(item => ({ name: item.name, detail: item.description })) ?? null}
            />
          </SettingsSubgroup>

          <SettingsSubgroup title={t('pi.resourcesKnowledge')} className="min-w-0">
            <ResourceList
              title={t('pi.skills')}
              description={t('pi.resourceSkillsDescription')}
              icon={BookOpen}
              loading={loading}
              items={skills?.map(item => ({
                name: item.name,
                detail: item.description,
                path: item.filePath,
                status: item.disableModelInvocation ? t('pi.skillModelInvocationOff') : undefined,
              })) ?? null}
            />
            <ResourceList
              title={t('pi.prompts')}
              description={t('pi.resourcePromptsDescription')}
              icon={MessageSquareText}
              loading={loading}
              items={prompts?.map(item => ({
                name: `${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ''}`,
                detail: item.description,
                path: item.filePath,
              })) ?? null}
            />
            <ResourceList
              title={t('pi.agentsFiles')}
              description={t('pi.resourceContextDescription')}
              icon={Files}
              loading={loading}
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
              items={registry?.eventHandlers.map(name => ({ name })) ?? null}
            />
            <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-end">
              <label className="block w-full min-w-0 flex-1">
                <span className="text-[length:var(--fs-xs)] font-medium text-text-200">{t('pi.resourceEventTypeLabel')}</span>
                <input
                  className={`${settingsFieldClass} mt-1.5`}
                  placeholder={t('pi.eventTypePlaceholder')}
                  value={eventType}
                  onChange={event => setEventType(event.target.value)}
                />
              </label>
              <Button
                size="sm"
                variant="secondary"
                className="shrink-0"
                disabled={busy !== null || !eventType.trim()}
                onClick={() => setHandlerResult(registry?.eventHandlers.includes(eventType.trim()) ?? null)}
              >
                {t('pi.checkHandler')}
              </Button>
            </div>
            {handlerResult !== null ? (
              <p role="status" className="text-[length:var(--fs-xs)] leading-relaxed text-text-300 [overflow-wrap:anywhere]">
                {handlerResult ? t('pi.handlerRegistered', { eventType }) : t('pi.handlerNotRegistered', { eventType })}
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

function ResourceList({ title, description, icon: Icon, items, loading, summary }: {
  title: string
  description: string
  icon: LucideIcon
  items: Array<{ name: string; detail?: string; path?: string; status?: string }> | null
  loading: boolean
  summary?: string
}) {
  const { t } = useTranslation(['settings'])
  const populated = items !== null && items.length > 0
  const status = items === null
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
