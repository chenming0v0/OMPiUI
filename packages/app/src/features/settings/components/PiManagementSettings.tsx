import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, ShieldCheck, ShieldOff, SlidersHorizontal } from 'lucide-react'
import type { JsonObject } from '@ompiui/protocol'
import type { PiProjectTrust, PiSettingsSnapshot } from '../../../omp/domain'
import type { HostWorkspace } from '../../../omp/workspaces'
import { Button } from '../../../components/ui/Button'
import { JsonView } from '../../../components/JsonView'
import { useCurrentDirectory } from '../../../hooks'
import { useFocusedSessionId } from '../../../omp/hooks/index.js'
import {
  getPiSettings,
  getProjectTrust,
  patchPiSettings,
  setProjectTrust,
} from '../../../omp/transport/index.js'
import { listHostWorkspaces, resolveWorkspacePath } from '../../../omp/workspaces'
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

// Draft keys are the worker's flat settings.patch keys.
type SettingsDraft = {
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  transport?: 'auto' | 'sse' | 'websocket' | 'websocket-cached'
  steeringMode?: 'all' | 'one-at-a-time'
  followUpMode?: 'all' | 'one-at-a-time'
  compactionEnabled?: boolean
  retryEnabled?: boolean
  enableSkillCommands?: boolean
  showImages?: boolean
  shellPath?: string | null
  defaultProjectTrust?: 'ask' | 'always' | 'never'
  theme?: string
  httpProxy?: string | null
}

function draftFromSnapshot(snapshot: PiSettingsSnapshot): SettingsDraft {
  const settings = snapshot.effective
  return {
    defaultProvider: settings.defaultProvider ?? '',
    defaultModel: settings.defaultModel ?? '',
    defaultThinkingLevel: settings.defaultThinkingLevel,
    transport: settings.transport,
    steeringMode: settings.steeringMode,
    followUpMode: settings.followUpMode,
    compactionEnabled: settings.compaction?.enabled,
    retryEnabled: settings.retry?.enabled,
    enableSkillCommands: settings.enableSkillCommands,
    showImages: settings.showImages,
    shellPath: settings.shellPath ?? '',
    theme: settings.theme ?? '',
    httpProxy: settings.httpProxy ?? '',
    defaultProjectTrust: settings.defaultProjectTrust,
  }
}

export function PiManagementSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const directory = useCurrentDirectory()
  const sessionId = useFocusedSessionId()
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [settings, setSettings] = useState<PiSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [trust, setTrust] = useState<PiProjectTrust | null>(null)
  const [registeredWorkspaces, setRegisteredWorkspaces] = useState<HostWorkspace[]>([])
  const [advancedPatch, setAdvancedPatch] = useState('{}')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!directory) return
    setError(null)
    try {
      const canonical = await resolveWorkspacePath(directory)
      if (!canonical) throw new Error('Workspace is not available on the active server')
      setWorkspacePath(canonical)
      const [nextSettings, nextTrust, nextWorkspaces] = await Promise.all([
        getPiSettings(canonical),
        getProjectTrust(canonical),
        listHostWorkspaces(),
      ])
      setSettings(nextSettings)
      setDraft(draftFromSnapshot(nextSettings))
      setTrust(nextTrust)
      setRegisteredWorkspaces(nextWorkspaces)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('pi.loadFailed'))
    }
  }, [directory, t])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

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

  const trustStatus = !trust
    ? t('common:loading')
    : trust.trusted
      ? t('pi.trusted')
      : trust.required
        ? t('pi.decisionRequired')
        : t('pi.notTrusted')
  const trustSource = trust?.inheritedFrom
    ? t('pi.trustInherited', { source: trust.inheritedFrom })
    : trust?.decision != null
      ? t('pi.trustSavedDecision')
      : t('pi.trustDefaultDecision', { policy: t(`pi.trustPolicies.${trust?.defaultDecision ?? 'ask'}`) })
  const activePath = workspacePath ?? directory
  const workspaceName = registeredWorkspaces.find(workspace => workspace.path === activePath)?.displayName
    || activePath.split(/[\\/]/).filter(Boolean).pop()
    || activePath
  const runtimeDefault = t('pi.runtimeDefault')
  const booleanOptions = [
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

      <SettingsSection
        title={t('pi.trustTitle')}
        description={t('pi.trustDescription')}
        className="[&>.settings-section-header]:border-b-0 [&>.settings-section-header]:pb-0"
        status={
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[length:var(--fs-xs)] font-medium ${trust?.trusted ? 'bg-success-100/10 text-success-100' : 'bg-bg-200 text-text-200'}`}>
            {trust?.trusted ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldOff size={14} aria-hidden="true" />}
            {trustStatus}
          </span>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 basis-56 break-words text-[length:var(--fs-xs)] leading-relaxed text-text-300">{trust ? trustSource : t('common:loading')}</p>
          <div className="flex flex-wrap gap-2">
            {trust?.decision != null ? (
              <Button variant="ghost" disabled={busy !== null} isLoading={busy === 'trust-reset'} onClick={() => workspacePath && void run('trust-reset', async () => setTrust(await setProjectTrust(workspacePath, null)), t('pi.trustReset'))}>{t('pi.resetTrust')}</Button>
            ) : null}
            <Button variant={trust?.trusted ? 'secondary' : 'primary'} disabled={busy !== null || !trust} isLoading={busy === 'trust-allow' || busy === 'trust-deny'} onClick={() => workspacePath && trust && void run(trust.trusted ? 'trust-deny' : 'trust-allow', async () => setTrust(await setProjectTrust(workspacePath, !trust.trusted)), t(trust.trusted ? 'pi.trustDenied' : 'pi.trustGranted'))}>
              {trust?.trusted ? t('pi.revokeTrust') : t('pi.trustAction')}
            </Button>
            {trust?.required && !trust.trusted ? (
              <Button variant="secondary" disabled={busy !== null} onClick={() => workspacePath && void run('trust-deny', async () => setTrust(await setProjectTrust(workspacePath, false)), t('pi.trustDenied'))}>{t('pi.denyAction')}</Button>
            ) : null}
          </div>
        </div>
      </SettingsSection>

      {settings && draft ? (
        <SettingsSection title={t('pi.runtimeTitle')} description={t('pi.runtimeDescription')}>
          {settings.errors.length > 0 ? (
            <SettingsDisclosure title={t('pi.loadError', { count: settings.errors.length })}>
              {settings.errors.map((error, index) => <p key={index} className="text-[length:var(--fs-xs)] text-danger-100">{error.scope}: {error.message}</p>)}
            </SettingsDisclosure>
          ) : null}
          <fieldset disabled={busy !== null} className="min-w-0 space-y-6 disabled:opacity-60">
            <SettingsSubgroup title={t('pi.modelDefaults')} description={t('pi.modelDefaultsDescription')}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SettingField label={t('pi.defaultProvider')}>
                  <input className={settingsFieldClass} aria-label={t('pi.defaultProvider')} placeholder={runtimeDefault} value={draft.defaultProvider} onChange={event => setDraft({ ...draft, defaultProvider: event.target.value })} />
                </SettingField>
                <SettingField label={t('pi.defaultModel')}>
                  <input className={settingsFieldClass} aria-label={t('pi.defaultModel')} placeholder={runtimeDefault} value={draft.defaultModel} onChange={event => setDraft({ ...draft, defaultModel: event.target.value })} />
                </SettingField>
              </div>
              <SettingRow label={t('pi.thinking')} description={t('pi.thinkingDescription')} className="pt-2">
                <SettingsSelect className="!w-36" ariaLabel={t('pi.thinking')} placeholder={runtimeDefault} value={draft.defaultThinkingLevel} onChange={value => setDraft({ ...draft, defaultThinkingLevel: value })} options={(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(level => ({ value: level, label: t(`pi.thinkingLevels.${level}`) }))} />
              </SettingRow>
            </SettingsSubgroup>

            <SettingsSubgroup title={t('pi.conversationBehavior')} className="border-t border-border-200/60 pt-5">
              <div className="space-y-4">
                {([
                  ['compactionEnabled', 'compaction'],
                  ['retryEnabled', 'retry'],
                  ['enableSkillCommands', 'skillCommands'],
                  ['showImages', 'images'],
                ] as const).map(([key, label]) => (
                  <SettingRow key={key} label={t(`pi.${label}`)} description={t(`pi.${label}Description`)}>
                    <SettingsSelect className="!w-36" ariaLabel={t(`pi.${label}`)} placeholder={runtimeDefault} value={draft[key] === undefined ? undefined : String(draft[key])} onChange={value => setDraft({ ...draft, [key]: value === 'true' })} options={booleanOptions} />
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
                      <SettingsSelect ariaLabel={t('pi.steeringMode')} placeholder={runtimeDefault} value={draft.steeringMode} onChange={value => setDraft({ ...draft, steeringMode: value })} options={(['all', 'one-at-a-time'] as const).map(mode => ({ value: mode, label: t(`pi.queueModes.${mode}`) }))} />
                    </SettingField>
                    <SettingField label={t('pi.followUpMode')} description={t('pi.followUpDescription')}>
                      <SettingsSelect ariaLabel={t('pi.followUpMode')} placeholder={runtimeDefault} value={draft.followUpMode} onChange={value => setDraft({ ...draft, followUpMode: value })} options={(['all', 'one-at-a-time'] as const).map(mode => ({ value: mode, label: t(`pi.queueModes.${mode}`) }))} />
                    </SettingField>
                  </div>
                </SettingsSubgroup>
                <SettingsSubgroup title={t('pi.environment')}>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <SettingField label={t('pi.transport')}>
                      <SettingsSelect ariaLabel={t('pi.transport')} placeholder={runtimeDefault} value={draft.transport} onChange={value => setDraft({ ...draft, transport: value })} options={(['auto', 'sse', 'websocket', 'websocket-cached'] as const).map(transport => ({ value: transport, label: t(`pi.transports.${transport}`) }))} />
                    </SettingField>
                    <SettingField label={t('pi.httpProxy')}>
                      <input className={settingsFieldClass} aria-label={t('pi.httpProxy')} value={draft.httpProxy ?? ''} placeholder="http://127.0.0.1:7890" onChange={event => setDraft({ ...draft, httpProxy: event.target.value })} />
                    </SettingField>
                    <SettingField label={t('pi.shellPath')}>
                      <input className={settingsFieldClass} aria-label={t('pi.shellPath')} placeholder={runtimeDefault} value={draft.shellPath ?? ''} onChange={event => setDraft({ ...draft, shellPath: event.target.value })} />
                    </SettingField>
                    <SettingField label={t('pi.runtimeTheme')} description={t('pi.runtimeThemeDescription')}>
                      <input className={settingsFieldClass} aria-label={t('pi.runtimeTheme')} value={draft.theme ?? ''} placeholder={runtimeDefault} onChange={event => setDraft({ ...draft, theme: event.target.value })} />
                    </SettingField>
                    <SettingField label={t('pi.defaultTrust')}>
                      <SettingsSelect ariaLabel={t('pi.defaultTrust')} placeholder={runtimeDefault} value={draft.defaultProjectTrust} onChange={value => setDraft({ ...draft, defaultProjectTrust: value })} options={(['ask', 'always', 'never'] as const).map(trust => ({ value: trust, label: t(`pi.trustPolicies.${trust}`) }))} />
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
                      try { patch = JSON.parse(advancedPatch) as JsonObject } catch { throw new Error(t('pi.patchInvalidJson')) }
                      const saved = await patchPiSettings(workspacePath, patch)
                      setSettings(saved)
                      setDraft(draftFromSnapshot(saved))
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
              const saved = await patchPiSettings(workspacePath, {
                ...draft,
                defaultProvider: draft.defaultProvider?.trim() || undefined,
                defaultModel: draft.defaultModel?.trim() || undefined,
                shellPath: draft.shellPath?.trim() || null,
                theme: draft.theme?.trim() || undefined,
                httpProxy: draft.httpProxy?.trim() || null,
              })
              setSettings(saved)
              setDraft(draftFromSnapshot(saved))
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
