// ============================================
// SkillPanel - Skill 管理面板
// 显示所有可用 Skill，支持查看详情
// ============================================

import { memo, useState, useEffect, useCallback, useRef, useSyncExternalStore, useId, useLayoutEffect } from 'react'
import type { JsonObject, JsonValue } from '@ompiui/protocol'
import { useTranslation } from 'react-i18next'
import {
  TeachIcon,
  RetryIcon,
  SpinnerIcon,
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
} from './Icons'
import type { Skill } from '../omp/vendor/pi-coding-agent'
import { getPiSkills, getPiSkillDetails } from '../omp/transport/index.js'
import { apiErrorHandler } from '../utils'
import { serverStore } from '../store/serverStore'

// ============================================
// SkillPanel Component
// ============================================

interface SkillPanelProps {
  isResizing?: boolean
  sessionId?: string | null
}

export const SkillPanel = memo(function SkillPanel({ isResizing: _isResizing, sessionId }: SkillPanelProps) {
  const { t } = useTranslation(['components', 'common'])
  const generation = useSyncExternalStore(listener => serverStore.subscribe(listener), () => serverStore.getActiveServerGeneration(), () => serverStore.getActiveServerGeneration())
  const scope = JSON.stringify([generation, sessionId])
  const currentScope = useRef(scope)
  useLayoutEffect(() => { currentScope.current = scope }, [scope])
  const request = useRef<AbortController | null>(null)
  const revision = useRef(0)
  const [snapshot, setSnapshot] = useState<{ scope: string; revision: number; skills: Skill[]; loading: boolean; error: string | null } | null>(null)
  const visible = snapshot?.scope === scope ? snapshot : null
  const skills = visible?.skills ?? []
  const loading = visible?.loading ?? true
  const error = visible?.error ?? null
  const [filter, setFilter] = useState('')

  const loadSkills = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const nextRevision = ++revision.current
    setSnapshot({ scope, revision: nextRevision, skills: [], loading: true, error: null })
    try {
      if (!sessionId) throw new Error(t('rightPanel.noActiveSession'))
      const data = await getPiSkills(sessionId, controller.signal)
      if (!Array.isArray(data)) throw new Error(t('skillPanel.failedToLoad'))
      if (!controller.signal.aborted && currentScope.current === scope) setSnapshot({ scope, revision: nextRevision, skills: data, loading: false, error: null })
    } catch (err) {
      if (controller.signal.aborted || currentScope.current !== scope) return
      apiErrorHandler('load skills', err)
      setSnapshot({ scope, revision: nextRevision, skills: [], loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }, [scope, sessionId, t])

  useEffect(() => {
    void loadSkills()
    const updated = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) void loadSkills()
    }
    window.addEventListener('ompiui:registry-updated', updated)
    return () => { request.current?.abort(); window.removeEventListener('ompiui:registry-updated', updated) }
  }, [loadSkills, sessionId])

  // Filter skills
  const normalizedFilter = filter.toLowerCase()
  const filteredSkills = skills.filter(
    skill =>
      skill.name.toLowerCase().includes(normalizedFilter) ||
      (skill.description ?? '').toLowerCase().includes(normalizedFilter),
  )

  return (
    <div className="flex flex-col h-full bg-bg-100">
      {/* Header */}
      <div className="relative flex h-10 items-center justify-between px-3">
          <div className="flex h-6 min-w-0 items-center gap-1.5 text-text-100 text-[length:var(--fs-xs)] font-medium">
          <span>{t('skillPanel.title')}</span>
          {!loading && !error && <span className="inline-flex h-4 items-center text-[length:var(--fs-xs)] leading-none text-text-400">({skills.length})</span>}
        </div>
        <button
          type="button"
          onClick={loadSkills}
          disabled={loading}
          aria-label={t('common:refresh')}
          className="inline-flex h-6 w-6 items-center justify-center hover:bg-bg-200/50 rounded-md text-text-300 hover:text-text-100 transition-colors disabled:opacity-50"
          title={t('common:refresh')}
        >
          <RetryIcon size={12} className={loading ? 'animate-spin' : ''} />
        </button>
        <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
      </div>

      {/* Search Bar */}
      <div className="relative px-3 py-2">
        <div className="relative group">
          <input
            type="text"
            name="skill-filter"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={t('skillPanel.filterPlaceholder')}
            aria-label={t('skillPanel.filterPlaceholder')}
            autoComplete="off"
            className="w-full bg-bg-200/40 hover:bg-bg-200/60 focus:bg-bg-000 border border-transparent focus:border-border-200 rounded-md py-1.5 pl-[30px] pr-2 text-[length:var(--fs-sm)] text-text-100 placeholder:text-text-400/70 focus-visible:ring-1 focus-visible:ring-border-200 focus-visible:ring-inset transition-all"
          />
          <SearchIcon size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-400 group-focus-within:text-accent-main-100 transition-colors" />
        </div>
        <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-base)] gap-2">
            <SpinnerIcon size={20} className="animate-spin opacity-50" />
            <span>{t('skillPanel.loadingSkills')}</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-base)] gap-2">
            <AlertCircleIcon size={20} className="text-danger-100" />
            <span>{error}</span>
            <button
              type="button"
              onClick={loadSkills}
              className="px-3 py-1.5 text-[length:var(--fs-sm)] bg-bg-200/50 hover:bg-bg-200 text-text-200 rounded-md transition-colors"
            >
              {t('common:retry')}
            </button>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-base)] gap-2 px-4 text-center">
            <TeachIcon size={24} className="opacity-30" />
            <span>{t('skillPanel.noSkills')}</span>
          </div>
        ) : (
          <div className="p-1">
            {filteredSkills.map(skill => (
              <SkillItem key={`${scope}:${visible?.revision}:${skill.filePath}:${skill.name}`} skill={skill} sessionId={sessionId!} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

// ============================================
// SkillItem Component
// ============================================

const SkillItem = memo(function SkillItem({ skill, sessionId }: { skill: Skill; sessionId: string }) {
  const { t } = useTranslation(['components', 'common'])
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [parametersExpanded, setParametersExpanded] = useState(false)
  const [frontmatter, setFrontmatter] = useState<JsonObject | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => { request.current?.abort() }, [])

  const loadDetails = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(false)
    try {
      const details = await getPiSkillDetails(sessionId, skill, controller.signal)
      if (!details?.frontmatter || typeof details.frontmatter !== 'object' || Array.isArray(details.frontmatter)) throw new Error('Invalid skill metadata')
      if (!controller.signal.aborted && request.current === controller) setFrontmatter(details.frontmatter)
    } catch {
      if (!controller.signal.aborted && request.current === controller) setError(true)
    } finally {
      if (!controller.signal.aborted && request.current === controller) setLoading(false)
    }
  }

  const toggleParameters = () => {
    setParametersExpanded(!parametersExpanded)
    if (!parametersExpanded && frontmatter === null && !loading) void loadDetails()
  }
  const name = frontmatter && Object.hasOwn(frontmatter, 'name') ? frontmatter.name : skill.name
  const description = frontmatter && Object.hasOwn(frontmatter, 'description') ? frontmatter.description : skill.description
  const parameters = Object.entries(frontmatter ?? {}).filter(([key]) => key !== 'name' && key !== 'description')
  const invocationDisabled = skill.disableModelInvocation ?? skill.hide
  const discovery: [string, JsonValue | undefined][] = [
    [t('skillPanel.file'), skill.filePath],
    [t('skillPanel.directory'), skill.baseDir],
    [t('skillPanel.source'), skill.source],
    [t('skillPanel.modelInvocation'), invocationDisabled === undefined ? undefined : t(invocationDisabled ? 'skillPanel.modelInvocationDisabled' : 'skillPanel.modelInvocationEnabled')],
    ...Object.entries(skill.sourceInfo ?? {}).map(([key, value]): [string, JsonValue | undefined] => [`sourceInfo.${key}`, value]),
  ]

  return (
    <div className="group min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`${id}-details`}
        className="flex w-full items-start gap-2 rounded-md px-2 py-2.5 hover:bg-bg-200/50 transition-colors bg-transparent border-none text-left focus-visible:ring-1 focus-visible:ring-border-200 focus-visible:ring-inset"
        onClick={() => { setExpanded(!expanded); if (expanded) setParametersExpanded(false) }}
      >
        <span className="text-text-400 shrink-0 mt-1">
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[length:var(--fs-base)] text-text-100 font-medium [overflow-wrap:anywhere]">{skill.name}</div>
          {!expanded && <div className="mt-0.5 text-[length:var(--fs-sm)] text-text-400 truncate">{skill.description ?? ''}</div>}
        </div>
      </button>

      {expanded && (
        <div id={`${id}-details`} className="min-w-0 mx-2 mb-3 ml-7">
          <table aria-label={skill.name} className="w-full table-fixed border-collapse text-[length:var(--fs-sm)] leading-relaxed text-text-200">
            <tbody>
              {[[t('skillPanel.name'), name], [t('skillPanel.description'), description]].map(([label, value]) => (
                <tr key={String(label)}>
                  <th scope="row" className="w-16 py-1.5 pr-3 text-left align-top font-normal text-text-400 [overflow-wrap:anywhere]">{String(label)}</th>
                  <td className="min-w-0 py-1.5 align-top"><SkillMetadataValue value={value as JsonValue | undefined} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            aria-expanded={parametersExpanded}
            aria-controls={`${id}-parameters`}
            onClick={toggleParameters}
            className="mt-3 flex w-full min-h-10 items-center gap-2 rounded-md border-t border-border-200/40 py-2 text-left text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 focus-visible:ring-1 focus-visible:ring-border-200 focus-visible:ring-inset"
          >
            {parametersExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            {t('skillPanel.otherParameters')}
          </button>
          {parametersExpanded && (
            <div id={`${id}-parameters`} className="min-w-0 pt-1">
              {loading && <div role="status" className="flex items-center gap-2 py-2 text-[length:var(--fs-sm)] text-text-400"><SpinnerIcon size={14} />{t('skillPanel.loadingDetails')}</div>}
              {error && <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-[length:var(--fs-sm)] text-text-300">
                <span>{t('skillPanel.detailsFailed')}</span>
                <button type="button" onClick={() => void loadDetails()} className="rounded px-2 py-1 text-accent-main-100 hover:bg-bg-200/50 focus-visible:ring-1 focus-visible:ring-border-200">{t('common:retry')}</button>
              </div>}
              {frontmatter !== null && (parameters.length ? <dl className="min-w-0 space-y-3 pb-3">
                {parameters.map(([key, value]) => <div key={key} className="min-w-0">
                  <dt className="text-[length:var(--fs-xs)] text-text-400 [overflow-wrap:anywhere]">{key}</dt>
                  <dd className="mt-1 min-w-0 text-[length:var(--fs-sm)] leading-relaxed text-text-200"><SkillMetadataValue value={value} /></dd>
                </div>)}
              </dl> : <p className="py-2 text-[length:var(--fs-sm)] text-text-400">{t('skillPanel.noOtherParameters')}</p>)}
              <div className="min-w-0 mt-2 border-t border-border-200/30 pt-3">
                <div className="mb-3 text-[length:var(--fs-xs)] font-medium text-text-300">{t('skillPanel.discoveryInfo')}</div>
                <dl className="min-w-0 space-y-3">
                  {discovery.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label} className="min-w-0">
                    <dt className="text-[length:var(--fs-xs)] text-text-400 [overflow-wrap:anywhere]">{label}</dt>
                    <dd className="mt-0.5 min-w-0 text-[length:var(--fs-xs)] leading-relaxed text-text-300"><SkillMetadataValue value={value} /></dd>
                  </div>)}
                </dl>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

function SkillMetadataValue({ value }: { value: JsonValue | undefined }) {
  const { t } = useTranslation(['components'])
  if (Array.isArray(value)) {
    return value.length ? <ul className="min-w-0 space-y-1 border-l border-border-200/40 pl-3">{value.map((item, index) => <li key={index}><SkillMetadataValue value={item} /></li>)}</ul> : <span className="text-text-400">{t('skillPanel.emptyArray')}</span>
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    return entries.length ? <dl className="min-w-0 space-y-2 border-l border-border-200/40 pl-3">{entries.map(([key, item]) => <div key={key} className="min-w-0">
      <dt className="text-[length:var(--fs-xs)] text-text-400 [overflow-wrap:anywhere]">{key}</dt>
      <dd className="mt-0.5"><SkillMetadataValue value={item} /></dd>
    </div>)}</dl> : <span className="text-text-400">{t('skillPanel.emptyObject')}</span>
  }
  return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value === '' ? t('skillPanel.emptyString') : value === null ? 'null' : value === undefined ? '' : String(value)}</span>
}
