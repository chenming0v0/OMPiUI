import type { TFunction } from 'i18next'

export function formatElapsed(ms: number, t: TFunction): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return t('backgroundJobs.elapsedHours', { hours, minutes, seconds })
  if (minutes > 0) return t('backgroundJobs.elapsedMinutes', { minutes, seconds })
  return t('backgroundJobs.elapsedSeconds', { seconds })
}
