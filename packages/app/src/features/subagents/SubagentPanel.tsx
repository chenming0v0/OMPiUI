import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Users } from 'lucide-react'
import { piBranchStore, piSessionStateStore } from '../../omp/state/index.js'
import { ompSubagentStore, transcriptItemsFromMessages } from '../../omp/ompSubagentStore'
import { selectPiTimelineItemsCached } from '../../omp/selectors/timelineCache'
import { getOmpSubagentMessages } from '../../omp/transport/index.js'
import { serverStore } from '../../store/serverStore'
import { MarkdownRenderer } from '../../components/MarkdownRenderer'
import { SubagentSessionPreview } from '../message/tools/renderers/SubagentSessionPreview'
import { collectSubagentPanelEntries, type SubagentPanelEntry } from './subagentPanelData'
import { subagentPanelSelection } from './subagentPanelSelection'

export function SubagentPanel({ sessionId }: { sessionId?: string | null }) {
  const { t } = useTranslation('message')
  const branch = useSyncExternalStore(piBranchStore.subscribe, useCallback(() => sessionId ? piBranchStore.getData(sessionId) : null, [sessionId]))
  const parentFile = useSyncExternalStore(piSessionStateStore.subscribe, useCallback(() => sessionId ? piSessionStateStore.getState(sessionId)?.sessionFile : undefined, [sessionId]))
  const snapshot = useSyncExternalStore(ompSubagentStore.subscribe, ompSubagentStore.getSnapshot)
  const request = useSyncExternalStore(subagentPanelSelection.subscribe, subagentPanelSelection.getSnapshot)
  const entries = useMemo(() => sessionId ? collectSubagentPanelEntries(sessionId, branch ? selectPiTimelineItemsCached(sessionId, branch) : [],
    snapshot.runs.filter(run => run.sessionId === sessionId), typeof parentFile === 'string' ? parentFile : undefined) : [], [sessionId, branch, snapshot, parentFile])
  const [chosen, setChosen] = useState<{ sessionId: string; key: string; request: typeof request } | null>(null)
  const requested = request && request.sessionId === sessionId && request.generation === serverStore.getActiveServerGeneration()
    ? entries.find(entry => request.toolCallId ? entry.toolCallId === request.toolCallId && (request.index === undefined || entry.index === request.index) : entry.id === request.id) : undefined
  const selected = (chosen && chosen.sessionId === sessionId && chosen.request === request ? entries.find(entry => entry.key === chosen.key) : undefined) ?? requested ?? entries[0]
  const running = entries.filter(entry => entry.outcome.presentationStatus === 'running').length
  return <section aria-label={t('task.sidebar.title')} className="flex h-full min-h-0 flex-col bg-bg-100">
    <div className="flex items-center gap-2 border-b border-border-200/50 px-4 py-3 text-[length:var(--fs-sm)] text-text-200">
      <Users size={16} aria-hidden="true" /><span className="font-medium">{t('task.sidebar.title')}</span>
      <span className="ml-auto text-text-400">{t('task.sidebar.count', { count: entries.length, running })}</span>
    </div>
    {!sessionId || entries.length === 0 ? <p className="px-4 py-8 text-center text-[length:var(--fs-sm)] text-text-400">{t(sessionId ? 'task.sidebar.empty' : 'task.sidebar.noSession')}</p> : <>
      <div role="list" aria-label={t('task.sidebar.list')} className="max-h-[35%] shrink-0 overflow-y-auto border-b border-border-200/50 p-2 custom-scrollbar">
        {entries.map(entry => <div role="listitem" key={entry.key}><button type="button" aria-pressed={selected?.key === entry.key}
          onClick={() => setChosen({ sessionId, key: entry.key, request })}
          className={`mb-1 w-full rounded-md px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-main-100 ${selected?.key === entry.key ? 'bg-bg-300' : 'hover:bg-bg-200'}`}>
          <span className="flex items-center gap-2 text-[length:var(--fs-sm)]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.outcome.presentationStatus === 'running' ? 'animate-pulse bg-accent-main-100' : entry.outcome.presentationStatus === 'error' ? 'bg-danger-100' : entry.outcome.presentationStatus === 'completed' ? 'bg-accent-secondary-100' : 'bg-text-500'}`} />
            <span className="min-w-0 flex-1 truncate text-text-200">{entry.id}</span>
            <span className="sr-only">{t(`task.outcome.execution.${entry.outcome.executionStatus}`)}</span>
          </span>
          {(entry.run?.progress?.currentTool || entry.title) && <span className="mt-1 block truncate pl-3.5 text-[length:var(--fs-xs)] text-text-400">{entry.run?.progress?.currentTool ?? entry.title}</span>}
        </button></div>)}
      </div>
      {selected && <SubagentPanelDetail key={`${sessionId}:${selected.key}:${selected.run?.runId ?? ''}`} entry={selected} />}
    </>}
  </section>
}

function SubagentPanelDetail({ entry }: { entry: SubagentPanelEntry }) {
  const { t } = useTranslation('message')
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState<{ messages: unknown[]; error?: string; hasMore?: boolean; truncated?: boolean } | null>(null)
  const { sessionId, sessionFile } = entry.run ?? {}
  useEffect(() => {
    if (entry.live || !sessionId || !sessionFile) return
    const controller = new AbortController()
    void getOmpSubagentMessages(sessionId, { sessionFile }, controller.signal).then(result => {
      if (controller.signal.aborted) return
      const data = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
      setLoaded({ messages: Array.isArray(data.messages) ? data.messages : [], hasMore: Boolean(data.hasMore), truncated: Boolean(data.truncated) })
    }).catch(error => { if (!controller.signal.aborted) setLoaded({ messages: [], error: String(error) }) })
    return () => controller.abort()
  }, [entry.live, sessionId, sessionFile, revision])
  const transcript = useMemo(() => transcriptItemsFromMessages(loaded?.messages ?? []), [loaded])
  const run = entry.live ? entry.run : entry.run ? { ...entry.run, transcript, historyLoaded: Boolean(loaded), historyHasMore: loaded?.hasMore, historyTruncated: loaded?.truncated } : undefined
  const reload = () => { setLoaded(null); setRevision(value => value + 1) }
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar space-y-3">
    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words text-[length:var(--fs-md)] font-medium text-text-100">{entry.id}</h3>
      {entry.title && <p className="mt-1 text-[length:var(--fs-sm)] text-text-400">{entry.title}</p>}</div>
      {!entry.live && sessionFile && <button type="button" onClick={reload} aria-label={t('task.sidebar.refresh')} className="rounded p-1 text-text-400 hover:bg-bg-200"><RefreshCw size={14} /></button>}
    </div>
    {run?.task && <details className="text-[length:var(--fs-xs)] text-text-400"><summary className="cursor-pointer">{t('task.sidebar.assignment')}</summary><p className="mt-2 whitespace-pre-wrap break-words">{run.task}</p></details>}
    {entry.outcome.mergeStatus === 'failed' && <p role="alert" className="text-[length:var(--fs-sm)] text-danger-100">{run?.mergeError || t('task.outcome.merge.failed')}</p>}
    {loaded?.error && <p role="alert" className="break-words text-[length:var(--fs-xs)] text-danger-100">{loaded.error}</p>}
    {run && <SubagentSessionPreview run={run} loading={!entry.live && Boolean(sessionFile) && !loaded} onLoadMore={entry.live ? undefined : reload} spacious />}
    {entry.reports?.map(report => <div key={report.id} className="border-t border-border-200/50 pt-3"><MarkdownRenderer content={report.body} /></div>)}
    {entry.output && <div className="border-t border-border-200/50 pt-3"><p className="mb-2 text-[length:var(--fs-xs)] text-text-400">{t('task.result')}</p><MarkdownRenderer content={entry.output} /></div>}
  </div>
}
