import { useTranslation } from 'react-i18next'
import { isJsonObject } from '@ompiui/protocol'
import { usePiSessionRuntimeState } from '../../omp/hooks'
import { compactionMethodKey } from '../../omp/compaction'
import { SpinnerIcon } from '../../components/Icons'

export function CompactionStatusInline({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('message')
  const state = usePiSessionRuntimeState(sessionId)
  const compaction = isJsonObject(state?.compaction) ? state.compaction : null
  const operation = isJsonObject(compaction?.operation) ? compaction.operation : null
  const method = typeof operation?.method === 'string' ? operation.method : null
  return <div className="px-3 py-2 text-center text-[length:var(--fs-xs)] text-text-400" role="status">
    <div className="inline-flex items-center gap-2"><SpinnerIcon className="animate-spin" size={12} />
      {t('compaction.running')} · {t(compactionMethodKey(method), { method })}
    </div>
    <p className="mt-1">{t(method === 'snapcompact' ? 'compaction.archiveHint' : 'compaction.streamingUnavailable')}</p>
    {compaction?.canAbort === false && <p className="mt-1">{t('compaction.cancelUnavailable')}</p>}
  </div>
}
