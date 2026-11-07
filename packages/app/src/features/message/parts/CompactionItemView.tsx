import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import type { PiCompactionItem } from '../../../omp/domain'
import { compactionMethodKey } from '../../../omp/compaction'
import { MarkdownRenderer } from '../../../components/MarkdownRenderer'
import { TimelineEntryNavigation } from '../../chat/virtual/TimelineEntryNavigation'

export function CompactionItemView({ item }: { item: PiCompactionItem }) {
  const { t } = useTranslation('message')
  const navigation = useContext(TimelineEntryNavigation)
  const archive = item.method === 'snapcompact'
  const summary = item.shortSummary?.trim() || (archive ? '' : item.summary)
  const token = (value?: number) => typeof value === 'number' ? value.toLocaleString() : t('compaction.unknownTokens')
  return <section className="min-w-0 px-3 py-2 text-[length:var(--fs-xs)] text-text-400" aria-label={t('compaction.completed')}>
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-border-200/70 pt-2">
      <span>{t(compactionMethodKey(item.method), { method: item.method })}</span>
      <span className="font-mono tabular-nums">{token(item.tokensBefore)} → {token(item.tokensAfter)} tokens</span>
    </div>
    {archive && <p className="mt-2 text-center">{t('compaction.archiveHint')}</p>}
    {item.firstKeptEntryId && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
      <span>{t('compaction.firstKept')} <code>{item.firstKeptEntryId}</code></span>
      {navigation && <button type="button" className="text-accent-main-100 hover:underline disabled:opacity-50"
        disabled={navigation.pending === item.firstKeptEntryId} onClick={() => navigation.jump(item.firstKeptEntryId)}>
        {t(navigation.pending === item.firstKeptEntryId ? 'compaction.locating' : 'compaction.jump')}
      </button>}
      {navigation?.missing === item.firstKeptEntryId && <span role="status">{t('compaction.entryUnavailable')}</span>}
    </div>}
    {summary && <details className="mt-2">
      <summary className="cursor-pointer py-1">{t('compaction.summary')}</summary>
      <MarkdownRenderer content={summary} variant="reasoning" />
    </details>}
    {archive && item.summary && <details className="mt-2">
      <summary className="cursor-pointer py-1">{t('compaction.archiveInstructions')}</summary>
      <p className="mb-2">{t('compaction.internalHint')}</p>
      <MarkdownRenderer content={item.summary} variant="reasoning" />
    </details>}
  </section>
}
