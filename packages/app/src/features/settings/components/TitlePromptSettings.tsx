import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { useServerStore } from '../../../hooks/useServerStore'
import { postPiGlobalCommand } from '../../../omp/transport'
import { serverStore } from '../../../store/serverStore'
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
  const [snapshot, setSnapshot] = useState<TitleSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<TitlePrompts | null>(null)
  const [busy, setBusy] = useState<'load' | 'save' | 'reset' | null>('load')
  const [error, setError] = useState<{ operation: 'load' | 'save'; message: string } | null>(null)
  const [notice, setNotice] = useState<'saved' | 'restored' | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const dirtyRef = useRef(false)

  const load = useCallback(async () => {
    // Focus refreshes must never replace an unsaved draft or race a save.
    if (requestRef.current || dirtyRef.current || serverStore.getActiveServerGeneration() !== generation) return
    const controller = new AbortController()
    requestRef.current = controller
    setBusy('load')
    setError(null)
    const isCurrent = () => !controller.signal.aborted
      && requestRef.current === controller
      && serverStore.getActiveServerGeneration() === generation
    try {
      const settings = await postPiGlobalCommand<TitleSettingsSnapshot>('title.settings.get', undefined, controller.signal)
      if (!isCurrent()) return
      setSnapshot(settings)
      setDraft(promptsFromSnapshot(settings))
      dirtyRef.current = false
    } catch (cause) {
      if (isCurrent()) setError({ operation: 'load', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (isCurrent()) {
        requestRef.current = null
        setBusy(null)
      }
    }
  }, [generation])

  useEffect(() => {
    void load()
    const refresh = () => { void load() }
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      requestRef.current?.abort()
      requestRef.current = null
    }
  }, [load])

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
      dirtyRef.current = false
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
              const next = { ...draft, [key]: event.target.value }
              dirtyRef.current = !samePrompts(next, snapshot)
              setDraft(next)
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
            <Button type="button" variant="secondary" size="sm" disabled={busy !== null || hasChanges} onClick={() => void load()}>
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
