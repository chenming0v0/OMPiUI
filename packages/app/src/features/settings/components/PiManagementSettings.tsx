import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, SlidersHorizontal } from 'lucide-react'
import type { JsonObject } from '@ompiui/protocol'
import type { PiSettingsSnapshot } from '../../../omp/domain'
import type { HostWorkspace } from '../../../omp/workspaces'
import { Button } from '../../../components/ui/Button'
import { JsonView } from '../../../components/JsonView'
import { useCurrentDirectory, useServerStore } from '../../../hooks'
import { useFocusedSessionId } from '../../../omp/hooks/index.js'
import { getPiSettings, patchPiSettings } from '../../../omp/transport/index.js'
import { listHostWorkspaces, resolveWorkspacePath } from '../../../omp/workspaces'
import { loadPiModelRoles } from '../../../omp/controllers/modelRoles'
import { piModelRolesStore } from '../../../omp/state/piModelRolesStore'
import { serverStore } from '../../../store/serverStore'
import {
  SettingRow,
  SettingField,
  SettingsSection,
  SettingsSubgroup,
  SettingsSelect,
  SettingsDisclosure,
  settingsFieldClass,
  settingsFieldAreaClass,
} from './SettingsUI'
import { PiPackageManagement } from './PiPackageManagement'
import { PiResourceManagement } from './PiResourceManagement'
import { PiSessionManagement } from './PiSessionManagement'

// The form edits only global overrides; effective/project values remain inspectable below.
type SettingsDraft = Record<string, string>

const formKeys = [
  'modelRoles.default', 'defaultThinkingLevel', 'steeringMode', 'followUpMode',
  'compaction.enabled', 'retry.enabled', 'skills.enableSkillCommands', 'images.blockImages',
  'shellPath', 'theme.dark', 'theme.light',
] as const

function draftFromSnapshot(snapshot: PiSettingsSnapshot): SettingsDraft {
  return Object.fromEntries(formKeys.map(key => {
    const value = key.split('.').reduce<unknown>((object, segment) =>
      object !== null && typeof object === 'object' ? (object as Record<string, unknown>)[segment] : undefined,
    snapshot.global)
    return [key, value == null ? '' : String(value)]
  }))
}

function patchFromDraft(snapshot: PiSettingsSnapshot, draft: SettingsDraft): JsonObject {
  const previous = draftFromSnapshot(snapshot)
  const patch: JsonObject = {}
  for (const key of formKeys) {
    if (draft[key] === previous[key]) continue
    const value = draft[key].trim()
    if (value === previous[key]) continue
    patch[key] = value === '' ? null : ['compaction.enabled', 'retry.enabled', 'skills.enableSkillCommands', 'images.blockImages'].includes(key) ? value === 'true' : value
  }
  return patch
}

export function PiManagementSettings() {
  const directory = useCurrentDirectory()
  const { activeServerGeneration } = useServerStore()
  return <PiManagementSettingsPanel key={`${activeServerGeneration}:${directory}`} directory={directory} />
}

function PiManagementSettingsPanel({ directory }: { directory: string | undefined }) {
  const { t } = useTranslation(['settings', 'common'])
  const sessionId = useFocusedSessionId()
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [settings, setSettings] = useState<PiSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [registeredWorkspaces, setRegisteredWorkspaces] = useState<HostWorkspace[]>([])
  const [advancedPatch, setAdvancedPatch] = useState('{}')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (signal: AbortSignal) => {
    if (!directory) return
    setError(null)
    try {
      const canonical = await resolveWorkspacePath(directory)
      if (signal.aborted) return
      if (!canonical) throw new Error('Workspace is not available on the active server')
      setWorkspacePath(canonical)
      const [nextSettings, nextWorkspaces] = await Promise.all([
        getPiSettings(canonical, signal),
        listHostWorkspaces(signal),
      ])
      if (signal.aborted) return
      setSettings(nextSettings)
      setDraft(draftFromSnapshot(nextSettings))
      setRegisteredWorkspaces(nextWorkspaces)
    } catch (loadError) {
      if (!signal.aborted) setError(loadError instanceof Error ? loadError.message : t('pi.loadFailed'))
    }
  }, [directory, t])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => { void load(controller.signal) }, 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [load])

  const savePatch = async (patch: JsonObject) => {
    const generation = serverStore.getActiveServerGeneration()
    const saved = await patchPiSettings(workspacePath!, patch)
    if (serverStore.getActiveServerGeneration() === generation && Object.keys(patch).some(key => key === 'modelRoles' || key.startsWith('modelRoles.'))) {
      // Invalidate reads begun before this persisted change, then refresh the dedicated role page from its official CLI path.
      piModelRolesStore.markDisconnected()
      void loadPiModelRoles(true).catch(() => undefined)
    }
    setSettings(saved)
    setDraft(draftFromSnapshot(saved))
  }

  const run = useCallback(async (name: string, action: () => Promise<void>, message: string) => {
    setBusy(name)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(message)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('pi.operationFailed'))
    } finally {
      setBusy(null)
    }
  }, [t])

  if (!directory) return <p className="text-[length:var(--fs-sm)] text-text-300">{t('pi.openWorkspace')}</p>

  const activePath = workspacePath ?? directory
  const workspaceName = registeredWorkspaces.find(workspace => workspace.path === activePath)?.displayName
    || activePath.split(/[\\/]/).filter(Boolean).pop()
    || activePath
  const runtimeDefault = t('pi.runtimeDefault')
  const booleanOptions = [
    { value: '', label: runtimeDefault },
    { value: 'true', label: t('pi.enabled') },
    { value: 'false', label: t('pi.disabled') },
  ]

  return (
    <div className="pb-6">
      <header className="mb-6 space-y-4">
        <div>
          <h2 className="text-[length:var(--fs-xl)] font-semibold tracking-tight text-text-100">{t('pi.title')}</h2>
          <p className="mt-1.5 text-[length:var(--fs-sm)] leading-relaxed text-text-300">{t('pi.description')}</p>
        </div>
        <div className="flex items-start gap-3 rounded-lg bg-bg-200/50 px-3.5 py-3">
          <Folder size={18} className="mt-0.5 shrink-0 text-text-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[length:var(--fs-sm)] font-medium text-text-100">{workspaceName}</p>
            <p className="mt-1 break-all font-mono text-[length:var(--fs-xs)] leading-relaxed text-text-300">{activePath}</p>
            {registeredWorkspaces.length > 1 ? (
              <SettingsDisclosure title={t('pi.registeredWorkspaces', { count: registeredWorkspaces.length })} className="mt-2">
                <div className="max-h-32 space-y-2 overflow-auto">
                  {registeredWorkspaces.map(workspace => (
                    <p key={workspace.path} className="break-all text-[length:var(--fs-xs)] text-text-300">{workspace.displayName} · {workspace.path}</p>
                  ))}
                </div>
              </SettingsDisclosure>
            ) : null}
          </div>
        </div>
      </header>

      {error ? <p role="alert" className="mb-4 rounded-lg bg-danger-100/10 p-3 text-[length:var(--fs-sm)] text-danger-100">{error}</p> : null}
      {notice ? <p role="status" className="mb-4 text-[length:var(--fs-sm)] text-success-100">{notice}</p> : null}


      {settings && draft ? (
        <SettingsSection title={t('pi.runtimeTitle')} description={t('pi.runtimeDescription')}>
          {settings.errors.length > 0 ? (
            <SettingsDisclosure title={t('pi.loadError', { count: settings.errors.length })}>
              {settings.errors.map((error, index) => <p key={index} className="text-[length:var(--fs-xs)] text-danger-100">{error.scope}: {error.message}</p>)}
            </SettingsDisclosure>
          ) : null}
          <fieldset disabled={busy !== null} className="min-w-0 space-y-6 disabled:opacity-60">
            <SettingsSubgroup title={t('pi.modelDefaults')} description={t('pi.modelDefaultsDescription')}>
              <SettingField label={t('pi.defaultModel')}>
                <input className={settingsFieldClass} aria-label={t('pi.defaultModel')} placeholder={t('pi.modelSelectorPlaceholder')} value={draft['modelRoles.default']} onChange={event => setDraft({ ...draft, 'modelRoles.default': event.target.value })} />
              </SettingField>
              <SettingRow label={t('pi.thinking')} description={t('pi.thinkingDescription')} className="pt-2">
                <SettingsSelect className="!w-36" ariaLabel={t('pi.thinking')} placeholder={runtimeDefault} value={draft.defaultThinkingLevel} onChange={value => setDraft({ ...draft, defaultThinkingLevel: value })} options={[{ value: '', label: runtimeDefault }, ...(settings.definitions?.find(setting => setting.id === 'defaultThinkingLevel')?.values ?? []).map(level => ({ value: level, label: t(`pi.thinkingLevels.${level}`, { defaultValue: level }) }))]} />
              </SettingRow>
            </SettingsSubgroup>

            <SettingsSubgroup title={t('pi.conversationBehavior')} className="border-t border-border-200/60 pt-5">
              <div className="space-y-4">
                {([
                  ['compaction.enabled', 'compaction'],
                  ['retry.enabled', 'retry'],
                  ['skills.enableSkillCommands', 'skillCommands'],
                  ['images.blockImages', 'blockImages'],
                ] as const).map(([key, label]) => (
                  <SettingRow key={key} label={t(`pi.${label}`)} description={t(`pi.${label}Description`)}>
                    <SettingsSelect className="!w-36" ariaLabel={t(`pi.${label}`)} placeholder={runtimeDefault} value={draft[key]} onChange={value => setDraft({ ...draft, [key]: value })} options={booleanOptions} />
                  </SettingRow>
                ))}
              </div>
            </SettingsSubgroup>

            <SettingsDisclosure
              className="border-t border-border-200/60 pt-4"
              title={<span className="inline-flex items-center gap-2 font-medium text-text-200"><SlidersHorizontal size={14} aria-hidden="true" />{t('pi.advancedOptions')}</span>}
            >
              <p className="mb-5 text-[length:var(--fs-xs)] leading-relaxed text-text-300">{t('pi.advancedDescription')}</p>
              <div className="space-y-6">
                <SettingsSubgroup title={t('pi.messageQueue')}>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <SettingField label={t('pi.steeringMode')} description={t('pi.steeringDescription')}>
                      <SettingsSelect ariaLabel={t('pi.steeringMode')} placeholder={runtimeDefault} value={draft.steeringMode} onChange={value => setDraft({ ...draft, steeringMode: value })} options={[{ value: '', label: runtimeDefault }, ...(['all', 'one-at-a-time'] as const).map(mode => ({ value: mode, label: t(`pi.queueModes.${mode}`) }))]} />
                    </SettingField>
                    <SettingField label={t('pi.followUpMode')} description={t('pi.followUpDescription')}>
                      <SettingsSelect ariaLabel={t('pi.followUpMode')} placeholder={runtimeDefault} value={draft.followUpMode} onChange={value => setDraft({ ...draft, followUpMode: value })} options={[{ value: '', label: runtimeDefault }, ...(['all', 'one-at-a-time'] as const).map(mode => ({ value: mode, label: t(`pi.queueModes.${mode}`) }))]} />
                    </SettingField>
                  </div>
                </SettingsSubgroup>
                <SettingsSubgroup title={t('pi.environment')}>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <SettingField label={t('pi.shellPath')}>
                      <input className={settingsFieldClass} aria-label={t('pi.shellPath')} placeholder={runtimeDefault} value={draft.shellPath ?? ''} onChange={event => setDraft({ ...draft, shellPath: event.target.value })} />
                    </SettingField>
                    <SettingField label={t('pi.darkTheme')} description={t('pi.runtimeThemeDescription')}>
                      <input className={settingsFieldClass} aria-label={t('pi.darkTheme')} value={draft['theme.dark']} placeholder={runtimeDefault} onChange={event => setDraft({ ...draft, 'theme.dark': event.target.value })} />
                    </SettingField>
                    <SettingField label={t('pi.lightTheme')} description={t('pi.runtimeThemeDescription')}>
                      <input className={settingsFieldClass} aria-label={t('pi.lightTheme')} value={draft['theme.light']} placeholder={runtimeDefault} onChange={event => setDraft({ ...draft, 'theme.light': event.target.value })} />
                    </SettingField>
                  </div>
                </SettingsSubgroup>
                <SettingsDisclosure title={t('pi.advancedSummary')}>
                  <SettingsDisclosure title={t('pi.globalScope')} className="mt-1"><JsonValue value={settings.global} /></SettingsDisclosure>
                  <SettingsDisclosure title={t('pi.projectScope')} className="mt-1"><JsonValue value={settings.project} /></SettingsDisclosure>
                  <SettingsDisclosure title={t('pi.effectiveSettings')} className="mt-1"><JsonValue value={settings.effective} /></SettingsDisclosure>
                  <label className="mt-3 block space-y-1">
                    <span className="text-[length:var(--fs-xs)] text-text-300">{t('pi.patchLabel')}</span>
                    <textarea rows={7} className={`${settingsFieldAreaClass} font-mono`} value={advancedPatch} onChange={event => setAdvancedPatch(event.target.value)} />
                  </label>
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" disabled={busy !== null} onClick={() => workspacePath && void run('advanced-settings', async () => {
                      let patch: JsonObject
                      try {
                        const parsed: unknown = JSON.parse(advancedPatch)
                        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
                        patch = parsed as JsonObject
                      } catch { throw new Error(t('pi.patchInvalidJson')) }
                      await savePatch(patch)
                      setAdvancedPatch('{}')
                    }, t('pi.patchSaved'))}>{t('pi.applyPatch')}</Button>
                  </div>
                </SettingsDisclosure>
              </div>
            </SettingsDisclosure>
          </fieldset>
          <div className="mt-2 flex items-center justify-between gap-4 border-t border-border-200/60 pt-4">
            <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-300">{t('pi.saveHint')}</p>
            <Button className="shrink-0" isLoading={busy === 'settings'} disabled={busy !== null} onClick={() => workspacePath && void run('settings', async () => {
              await savePatch(patchFromDraft(settings, draft))
            }, t('pi.settingsSaved'))}>{t('common:save')}</Button>
          </div>
        </SettingsSection>
      ) : null}

      {workspacePath ? <PiPackageManagement workspacePath={workspacePath} /> : null}
      {workspacePath ? <PiResourceManagement sessionId={sessionId} workspacePath={workspacePath} /> : null}
      {workspacePath ? <PiSessionManagement sessionId={sessionId} workspacePath={workspacePath} /> : null}
    </div>
  )
}

function JsonValue({ value }: { value: unknown }) {
  return <JsonView value={value} className="max-h-64" />
}
