import { useTranslation } from 'react-i18next'
import { isJsonObject } from '@ompiui/protocol'
import { usePiSessionRuntimeState } from '../../../omp/hooks/index.js'
import { formatTokens } from '../../../hooks'

export function ContextMaintenanceStatus({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('settings')
  const state = usePiSessionRuntimeState(sessionId)
  const policy = isJsonObject(state?.contextMaintenance) ? state.contextMaintenance : null
  const enabled = (value: unknown) => typeof value === 'boolean' ? t(value ? 'pi.enabled' : 'pi.disabled') : t('pi.sessionValueUnknown')
  const threshold = typeof policy?.thresholdTokens === 'number' ? policy.thresholdTokens : null
  const window = typeof policy?.contextWindow === 'number' ? policy.contextWindow : null
  const rows = [
    [t('pi.compaction'), enabled(state?.autoCompactionEnabled)],
    [t('pi.contextTrigger'), threshold === null ? '—' : `${formatTokens(threshold)}${window && window > 0 ? ` (${(threshold / window * 100).toFixed(1)}%)` : ''}`],
    [t('pi.contextMaintenance.supersedeReads'), enabled(policy?.supersedeReads)],
    [t('pi.contextMaintenance.dropUseless'), enabled(policy?.dropUseless)],
    [t('pi.contextMaintenance.midTurnEnabled'), enabled(policy?.midTurnEnabled)],
    [t('pi.contextMaintenance.asyncEnabled'), enabled(policy?.asyncEnabled)],
    [t('pi.contextPruned'), typeof policy?.prunedResults === 'number' ? String(policy.prunedResults) : '—'],
    [t('pi.contextBackground'), policy?.speculation === 'running' ? t('pi.contextPreparing') : policy?.speculation === 'armed' ? t('pi.contextReady') : policy?.speculation === 'idle' ? t('pi.contextWaiting') : t('pi.sessionValueUnknown')],
  ]
  return <section className="space-y-3 rounded-lg border border-border-200/50 p-3" aria-label={t('pi.contextMaintenanceTitle')}>
    <h3 className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('pi.contextMaintenanceTitle')}</h3>
    <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t(policy ? 'pi.contextLiveHint' : 'pi.contextUnavailable')}</p>
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {rows.map(([label, value]) => <div key={label} className="flex min-w-0 justify-between gap-3 text-[length:var(--fs-xs)]">
        <dt className="text-text-400">{label}</dt><dd className="text-right font-mono text-text-200">{value}</dd>
      </div>)}
    </dl>
    {policy?.thresholdSource ? <p className="break-all text-[length:var(--fs-xs)] text-text-400">{t('pi.contextThresholdSource', { source: policy.thresholdSource })}</p> : null}
    {policy?.idleEnabled === true && policy.idleSupported === false ? <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.contextIdleUnavailable')}</p> : null}
  </section>
}
