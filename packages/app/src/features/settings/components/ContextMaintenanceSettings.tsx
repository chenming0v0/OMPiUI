import { useTranslation } from 'react-i18next'
import type { PiSettingsSnapshot } from '../../../omp/domain'
import { SettingField, SettingRow, SettingsSelect, SettingsSubgroup, settingsFieldClass } from './SettingsUI'
import { contextBooleanKeys, contextNumberKeys } from './contextMaintenanceSettingsModel'

export function ContextMaintenanceSettings({ snapshot, draft, onChange }: {
  snapshot: PiSettingsSnapshot
  draft: Record<string, string>
  onChange: (key: string, value: string) => void
}) {
  const { t } = useTranslation('settings')
  const supported = (key: string) => snapshot.definitions?.some(definition => definition.id === key)
  const effective = snapshot.effective.compaction
  const values = effective && typeof effective === 'object' && !Array.isArray(effective) ? effective : {}
  const options = [{ value: '', label: t('pi.runtimeDefault') }, { value: 'true', label: t('pi.enabled') }, { value: 'false', label: t('pi.disabled') }]
  return (
    <SettingsSubgroup title={t('pi.contextMaintenanceTitle')} description={t('pi.contextMaintenanceDescription')} className="border-t border-border-200/60 pt-5">
      {contextBooleanKeys.filter(supported).map(key => {
        const name = key.split('.')[1]
        const value = values[name]
        return <SettingRow key={key} label={t(`pi.contextMaintenance.${name}`)} description={`${t(`pi.contextMaintenance.${name}Description`)} ${t('pi.contextEffective', { value: typeof value === 'boolean' ? t(value ? 'pi.enabled' : 'pi.disabled') : t('pi.sessionValueUnknown') })}`}>
          <SettingsSelect className="!w-36" ariaLabel={t(`pi.contextMaintenance.${name}`)} value={draft[key] ?? ''} onChange={value => onChange(key, value)} options={options} />
        </SettingRow>
      })}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {contextNumberKeys.filter(supported).map(key => {
          const name = key.split('.')[1]
          return <SettingField key={key} label={t(`pi.contextMaintenance.${name}`)} description={t(`pi.contextMaintenance.${name}Description`)}>
            <input type="number" step="1" min={key === 'compaction.keepRecentTokens' ? 1 : -1} max={key === 'compaction.thresholdPercent' ? 99 : undefined} className={settingsFieldClass} aria-label={t(`pi.contextMaintenance.${name}`)} placeholder={t('pi.runtimeDefault')} value={draft[key] ?? ''} onChange={event => onChange(key, event.target.value)} />
          </SettingField>
        })}
      </div>
      <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('pi.contextThresholdHint')}</p>
    </SettingsSubgroup>
  )
}
