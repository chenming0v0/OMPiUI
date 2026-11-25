import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { useServerStore } from '../../../hooks/useServerStore'
import { postPiGlobalCommand } from '../../../omp/transport'
import { serverStore } from '../../../store/serverStore'
import { registerSessionConsumer } from '../../../hooks/useGlobalEvents'
import { useManagementEvents } from '../../../omp/managementEventStore'
import { SettingField, SettingsSection, settingsFieldAreaClass } from './SettingsUI'

interface TitlePrompts {
  forkPrompt: string
  tinyPrompt: string
  cardPrompt: string
}

interface TitleSettingsSnapshot extends TitlePrompts {
  defaults: TitlePrompts
}

const promptFields = [
  { key: 'forkPrompt', rows: 8 },
  { key: 'tinyPrompt', rows: 4 },
  { key: 'cardPrompt', rows: 4 },
] as const

function promptsFromSnapshot(settings: TitlePrompts): TitlePrompts {
  return {
    forkPrompt: settings.forkPrompt,
    tinyPrompt: settings.tinyPrompt,
    cardPrompt: settings.cardPrompt,
  }
}

function samePrompts(left: TitlePrompts, right: TitlePrompts): boolean {
  return promptFields.every(({ key }) => left[key] === right[key])
}

export function TitlePromptSettings() {
  const { activeServerGeneration } = useServerStore()
  return <TitlePromptSettingsPanel key={activeServerGeneration} generation={activeServerGeneration} />
}

function TitlePromptSettingsPanel({ generation }: { generation: number }) {
  const { t } = useTranslation('settings')
  const consumerId = useId()
  const { settingsRevision } = useManagementEvents()
  const [snapshot, setSnapshot] = useState<TitleSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<TitlePrompts | null>(null)
  const [busy, setBusy] = useState<'load' | 'save' | 'reset' | null>('load')
  const [error, setError] = useState<{ operation: 'load' | 'save'; message: string } | null>(null)
  const [notice, setNotice] = useState<'saved' | 'restored' | null>(null)
  const requestRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (serverStore.getActiveServerGeneration() !== generation) return
    // Remote reloads supersede both unsaved edits and earlier request responses.
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setBusy('load')
    setError(null)
    setNotice(null)
    const isCurrent = () => !controller.signal.aborted
      && requestRef.current === controller
      && serverStore.getActiveServerGeneration() === generation
    try {
      const settings = await postPiGlobalCommand<TitleSettingsSnapshot>('title.settings.get', undefined, controller.signal)
      if (!isCurrent()) return
      setSnapshot(settings)
      setDraft(promptsFromSnapshot(settings))
    } catch (cause) {
      if (isCurrent()) setError({ operation: 'load', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (isCurrent()) {
        requestRef.current = null
        setBusy(null)
      }
    }
  }, [generation])

  useEffect(() => { void load() }, [load, settingsRevision])

  useEffect(() => {
    const refresh = () => { void load() }
    const unsubscribe = registerSessionConsumer(consumerId, null, { onReconnected: refresh })
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      requestRef.current?.abort()
      requestRef.current = null
    }
  }, [consumerId, load])

  const persist = async (restoreDefaults: boolean) => {
    if (!snapshot || !draft || requestRef.current || serverStore.getActiveServerGeneration() !== generation) return
    const prompts = promptsFromSnapshot(restoreDefaults ? snapshot.defaults : draft)
    if (promptFields.some(({ key }) => !prompts[key].trim())) return
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(restoreDefaults ? 'reset' : 'save')
    setError(null)
    setNotice(null)
    const isCurrent = () => !controller.signal.aborted
      && requestRef.current === controller
      && serverStore.getActiveServerGeneration() === generation
    try {
      const settings = await postPiGlobalCommand<TitleSettingsSnapshot>('title.settings.set', prompts, controller.signal)
      if (!isCurrent()) return
      setSnapshot(settings)
      setDraft(promptsFromSnapshot(settings))
      setNotice(restoreDefaults ? 'restored' : 'saved')
    } catch (cause) {
      if (isCurrent()) setError({ operation: 'save', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (isCurrent()) {
        requestRef.current = null
        setBusy(null)
      }
    }
  }

  const hasEmptyPrompt = draft !== null && promptFields.some(({ key }) => !draft[key].trim())
  const hasChanges = snapshot !== null && draft !== null && !samePrompts(draft, snapshot)

  return (
    <SettingsSection title={t('titlePrompts.title')} description={t('titlePrompts.description')}>
      {busy === 'load' && (
        <p role="status" className="text-[length:var(--fs-xs)] text-text-300">{t('titlePrompts.loading')}</p>
      )}
      {promptFields.map(({ key, rows }) => (
        <SettingField key={key} label={t(`titlePrompts.${key}`)} description={t(`titlePrompts.${key}Desc`)}>
          <textarea
            aria-label={t(`titlePrompts.${key}`)}
            rows={rows}
            className={`${settingsFieldAreaClass} font-mono disabled:opacity-40`}
            value={draft?.[key] ?? ''}
            disabled={!draft || busy !== null}
            spellCheck={false}
            onChange={event => {
              if (!draft || !snapshot) return
              setDraft({ ...draft, [key]: event.target.value })
              setNotice(null)
            }}
          />
        </SettingField>
      ))}
      {hasEmptyPrompt && (
        <p role="alert" className="text-[length:var(--fs-xs)] text-error">{t('titlePrompts.emptyPrompt')}</p>
      )}
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="min-w-0 break-words text-[length:var(--fs-xs)] text-error">
            {t(error.operation === 'load' ? 'titlePrompts.loadFailed' : 'titlePrompts.saveFailed', { error: error.message })}
          </p>
          {error.operation === 'load' && (
            <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => void load()}>
              {t('titlePrompts.retry')}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-[length:var(--fs-xs)] text-success-100">{t(`titlePrompts.${notice}`)}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" isLoading={busy === 'save'} disabled={!hasChanges || hasEmptyPrompt || busy !== null} onClick={() => void persist(false)}>
          {t('titlePrompts.save')}
        </Button>
        <Button type="button" variant="secondary" size="sm" isLoading={busy === 'reset'} disabled={!snapshot || busy !== null} onClick={() => void persist(true)}>
          {t('titlePrompts.restoreDefaults')}
        </Button>
      </div>
    </SettingsSection>
  )
}
