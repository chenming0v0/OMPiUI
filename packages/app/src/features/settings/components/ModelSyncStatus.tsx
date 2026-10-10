import { useTranslation } from 'react-i18next'
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react'
import type { PiModelsSyncStatus } from '../../../omp/state/piModelsStore'

export function ModelSyncStatus({ status }: { status: PiModelsSyncStatus }) {
  const { t } = useTranslation('settings')
  const label = t(`models.${status}`)
  const synced = status === 'synced'
  const disconnected = status === 'disconnected'
  const Icon = synced ? CircleCheck : disconnected ? CircleX : CircleDashed
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      data-sync-status={status}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center transition-colors ${
        synced ? 'text-success-100' : disconnected ? 'text-danger-100' : 'text-text-400'
      }`}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
    </span>
  )
}
