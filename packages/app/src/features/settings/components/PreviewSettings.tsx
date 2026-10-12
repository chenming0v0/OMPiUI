import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postPiGlobalCommand } from '../../../omp/transport'
import { clearSubagentTranscripts } from '../../../omp/subagentTranscript'
import { useServerStore } from '../../../hooks/useServerStore'
import { serverStore } from '../../../store/serverStore'
import { SettingRow, SettingsSection, Toggle } from './SettingsUI'

export function PreviewSettings() {
  const { activeServerGeneration } = useServerStore()
  return <PreviewSettingsPanel key={activeServerGeneration} generation={activeServerGeneration} />
}

function PreviewSettingsPanel({ generation }: { generation: number }) {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => {
      void postPiGlobalCommand<{ subagentThinking: boolean }>('preview.settings.get', undefined, controller.signal)
        .then(settings => {
          if (controller.signal.aborted || serverStore.getActiveServerGeneration() !== generation) return
          setEnabled(settings.subagentThinking)
          setReady(true)
          setError('')
        })
        .catch(cause => {
          if (!controller.signal.aborted) setError(String(cause))
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
    }
  }, [generation])
  const save = async () => {
    if (!ready || saving) return
    setSaving(true)
    try {
      const settings = await postPiGlobalCommand<{ subagentThinking: boolean }>('preview.settings.set', {
        subagentThinking: !enabled,
      })
      if (serverStore.getActiveServerGeneration() !== generation) return
      setEnabled(settings.subagentThinking)
      clearSubagentTranscripts()
      setError('')
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <SettingsSection title={t('backendPreview.title')}>
      <SettingRow label={t('backendPreview.thinking')}>
        <Toggle enabled={enabled} disabled={!ready || saving} onChange={() => void save()} />
      </SettingRow>
      {error && (
        <p role="alert" className="mt-2 break-words text-[length:var(--fs-xs)] text-error">
          {error}
        </p>
      )}
    </SettingsSection>
  )
}
