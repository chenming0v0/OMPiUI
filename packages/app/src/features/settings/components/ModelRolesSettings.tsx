import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { Model, Api } from '../../../omp/vendor/pi-ai'
import { Button } from '../../../components/ui/Button'
import { DropdownMenu } from '../../../components/ui/DropdownMenu'
import { MenuItem } from '../../../components/ui/MenuItem'
import { ModelSelector } from '../../chat/ModelSelector'
import {
  AgentIcon, ChevronDownIcon, CpuIcon, EyeIcon, FastForwardIcon,
  GitBranchIcon, GitCommitIcon, GlobeIcon, ImageIcon, LayersIcon,
  LightbulbIcon, MessageSquareIcon, MoreVerticalIcon, QuestionIcon, ShieldIcon,
  ThinkingIcon, UsersIcon, VolumeIcon,
} from '../../../components/Icons'
import type { IconProps } from '../../../components/Icons'
import { usePiModels } from '../../../omp/hooks/index.js'
import { loadPiModelRoles, savePiModelRoles } from '../../../omp/controllers/modelRoles'
import { SettingsSelect, SettingsSection } from './SettingsUI'
import { SettingsPanelFooter } from './SettingsPanel'
import { useServerStore } from '../../../hooks/useServerStore'
import { serverStore } from '../../../store/serverStore'
import { piModelRolesStore } from '../../../omp/state/piModelRolesStore'
import { ModelSyncStatus } from './ModelSyncStatus'
import { getModelRoleFallback } from './modelRoleFallbacks'
import type { ModelRoleFallback } from './modelRoleFallbacks'
import './modelRoles.css'

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVELS)

// ============================================
// OMP 模型角色（对应 ~/.omp/agent/config.yml 的 modelRoles）
// 角色清单与接受关系来自 OMP 的 model-roles.ts / docs/settings.md。
// ============================================

type ModelRoleDef = {
  id: string
  icon: React.ComponentType<IconProps>
  nameKey: string
  descKey: string
  /** 接受的模型 kind（省略 = chat） */
  kinds: string[]
}

const CHAT_ROLE_DEFS: ModelRoleDef[] = [
  { id: 'default', icon: AgentIcon, nameKey: 'roleDefault', descKey: 'roleDefaultDesc', kinds: ['chat'] },
  { id: 'smol', icon: FastForwardIcon, nameKey: 'roleSmol', descKey: 'roleSmolDesc', kinds: ['chat'] },
  { id: 'slow', icon: ThinkingIcon, nameKey: 'roleSlow', descKey: 'roleSlowDesc', kinds: ['chat'] },
  { id: 'vision', icon: EyeIcon, nameKey: 'roleVision', descKey: 'roleVisionDesc', kinds: ['chat'] },
  { id: 'plan', icon: GitBranchIcon, nameKey: 'rolePlan', descKey: 'rolePlanDesc', kinds: ['chat'] },
  { id: 'commit', icon: GitCommitIcon, nameKey: 'roleCommit', descKey: 'roleCommitDesc', kinds: ['chat'] },
  { id: 'tiny', icon: CpuIcon, nameKey: 'roleTiny', descKey: 'roleTinyDesc', kinds: ['chat', 'tiny'] },
  { id: 'memory', icon: LayersIcon, nameKey: 'roleMemory', descKey: 'roleMemoryDesc', kinds: ['chat', 'tiny'] },
  { id: 'task', icon: UsersIcon, nameKey: 'roleTask', descKey: 'roleTaskDesc', kinds: ['chat'] },
  { id: 'advisor', icon: LightbulbIcon, nameKey: 'roleAdvisor', descKey: 'roleAdvisorDesc', kinds: ['chat'] },
]

const KIND_ROLE_DEFS: ModelRoleDef[] = [
  { id: 'image', icon: ImageIcon, nameKey: 'roleImage', descKey: 'roleImageDesc', kinds: ['image'] },
  { id: 'web', icon: GlobeIcon, nameKey: 'roleWeb', descKey: 'roleWebDesc', kinds: ['search', 'chat'] },
  { id: 'speech', icon: VolumeIcon, nameKey: 'roleSpeech', descKey: 'roleSpeechDesc', kinds: ['tts'] },
  { id: 'dictation', icon: MessageSquareIcon, nameKey: 'roleDictation', descKey: 'roleDictationDesc', kinds: ['stt'] },
  { id: 'judge', icon: ShieldIcon, nameKey: 'roleJudge', descKey: 'roleJudgeDesc', kinds: ['judge', 'tiny', 'chat'] },
]

/** modelRoles 的值：provider/modelId[:thinking]，也允许 @role 等选择器（不在 UI 直接编辑） */
function parseRoleValue(value: string | undefined): { provider: string; modelId: string; level: string } | null {
  if (!value || value.startsWith('@') || value === '*' || value.startsWith('omp/')) return null
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  const provider = value.slice(0, slash)
  const rest = value.slice(slash + 1)
  const colon = rest.lastIndexOf(':')
  if (colon > 0) {
    const maybeLevel = rest.slice(colon + 1)
    if (THINKING_LEVEL_SET.has(maybeLevel)) {
      return { provider, modelId: rest.slice(0, colon), level: maybeLevel }
    }
  }
  return { provider, modelId: rest, level: '' }
}

function formatRoleValue(provider: string, modelId: string, level: string): string {
  return level ? `${provider}/${modelId}:${level}` : `${provider}/${modelId}`
}

function roleCandidates(def: ModelRoleDef, models: readonly Model<Api>[]): Model<Api>[] {
  const accepted = models.filter(model => {
    const kind = (model as { kind?: string }).kind ?? 'chat'
    return def.kinds.includes(kind)
  })
  // 某类能力（image/tts/stt 等）服务器可能没有模型：回退展示全部，仍可指派
  return accepted.length > 0 ? accepted : [...models]
}

function cloneRoles(roles: Record<string, string>): Record<string, string> {
  return { ...roles }
}

function sameRoles(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if ((left[key] ?? '') !== (right[key] ?? '')) return false
  }
  return true
}

function mergeRoleDraft(
  previous: Record<string, string> | null,
  current: Record<string, string> | null,
  record: Record<string, string> | null,
): Record<string, string> | null {
  if (!record) return null
  if (!current || !previous || sameRoles(current, previous)) return cloneRoles(record)
  // 刷新只更新未编辑的字段，保留本地草稿及清除操作。
  const next = cloneRoles(record)
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if ((previous[key] ?? '') === (current[key] ?? '')) continue
    if (current[key]) next[key] = current[key]
    else delete next[key]
  }
  return next
}

// ============================================
// OMP 功能角色配置
// ============================================

/**
 * Agent 模型配置 — 设置页里独立的一块。
 * 写入 OMP 的 modelRoles 配置（经 worker 调 omp config CLI），
 * 改动由 OMP 文件监听自动重载，对之后的会话生效。
 * 非 OMP 驱动（没有该命令）时整块隐藏。
 */
export function ModelRolesSettings() {
  const { activeServerGeneration } = useServerStore()
  return <ModelRolesPanel key={activeServerGeneration} serverGeneration={activeServerGeneration} />
}

function ModelRolesPanel({ serverGeneration }: { serverGeneration: number }) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const { models, isLoading } = usePiModels()
  const { roles: saved, syncStatus, error: syncError } = useSyncExternalStore(
    piModelRolesStore.subscribe, piModelRolesStore.getSnapshot, piModelRolesStore.getSnapshot,
  )
  const [baseline, setBaseline] = useState(saved)
  const [draft, setDraft] = useState<Record<string, string> | null>(() => saved && cloneRoles(saved))
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [error, setError] = useState<string | null>(null)

  if (saved !== baseline) {
    setBaseline(saved)
    setDraft(mergeRoleDraft(baseline, draft, saved))
  }

  useEffect(() => {
    void loadPiModelRoles(true).catch(() => undefined)
  }, [serverGeneration])

  const handleRoleModel = useCallback((def: ModelRoleDef, model: Model<Api> | null) => {
    setDraft(current => {
      if (!current) return current
      const next = cloneRoles(current)
      const parsed = parseRoleValue(current[def.id])
      const level = parsed?.level ?? ''
      if (model) next[def.id] = formatRoleValue(model.provider, model.id, level)
      else delete next[def.id]
      return next
    })
  }, [])

  const handleRoleLevel = useCallback((def: ModelRoleDef, level: string) => {
    setDraft(current => {
      if (!current) return current
      const parsed = parseRoleValue(current[def.id])
      if (!parsed) return current
      return { ...current, [def.id]: formatRoleValue(parsed.provider, parsed.modelId, level) }
    })
  }, [])

  const handleCancel = useCallback(() => {
    if (!saved) return
    setDraft(cloneRoles(saved))
    setError(null)
  }, [saved])

  const handleSave = useCallback(async () => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      const next = await savePiModelRoles(draft)
      if (serverStore.getActiveServerGeneration() !== serverGeneration) return
      setDraft(cloneRoles(next))
    } catch (cause) {
      if (serverStore.getActiveServerGeneration() !== serverGeneration) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [draft, serverGeneration])

  if (!saved || !draft) return null

  const dirty = !sameRoles(saved, draft)
  const renderRoleRow = (def: ModelRoleDef) => (
    <RoleRow
      key={def.id}
      def={def}
      value={draft[def.id] ?? ''}
      fallback={getModelRoleFallback(def.id, draft)}
      models={models}
      isLoading={isLoading}
      disabled={saving}
      onModel={handleRoleModel}
      onLevel={handleRoleLevel}
      onClear={roleDef => handleRoleModel(roleDef, null)}
    />
  )

  return (
    <SettingsSection title={t('models.rolesTitle')} description={t('models.rolesDesc')} status={<ModelSyncStatus status={syncStatus} />} collapsible onOpenChange={setExpanded} className="model-roles-section">
      {error || syncError ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error ?? syncError?.message}</p> : null}
      <RoleGroup label={t('models.rolesChatGroup')} count={CHAT_ROLE_DEFS.length}>{CHAT_ROLE_DEFS.map(renderRoleRow)}</RoleGroup>
      <RoleGroup label={t('models.rolesKindGroup')} count={KIND_ROLE_DEFS.length}>{KIND_ROLE_DEFS.map(renderRoleRow)}</RoleGroup>
      <SettingsPanelFooter dock={dirty} visible={expanded && dirty}>
        <div className="model-roles-footer">
          <p className="model-roles-save-state" aria-live="polite">
            <span className="model-roles-state-dot" aria-hidden="true" />
            {t('models.rolesUnsaved')}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={saving || !dirty} onClick={handleCancel}>
              {tc('cancel')}
            </Button>
            <Button type="button" variant="primary" size="sm" isLoading={saving} disabled={!dirty} onClick={() => void handleSave()}>
              {tc('save')}
            </Button>
          </div>
        </div>
      </SettingsPanelFooter>
    </SettingsSection>
  )
}

function RoleGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const { t } = useTranslation('settings')
  const headingId = useId()
  return (
    <section className="model-role-group" aria-labelledby={headingId}>
      <div className="model-role-group-heading">
        <h3 id={headingId} className="model-role-group-title">
          {label}<span className="model-role-group-count">{count}</span>
        </h3>
        <div className="model-role-column-labels" aria-hidden="true">
          <span>{t('models.rolesModelColumn')}</span>
          <span>{t('models.defaultThinking')}</span>
        </div>
      </div>
      <div className="model-role-list">{children}</div>
    </section>
  )
}

/**
 * 角色说明由按钮打开浮层，单行配置模型和思考强度；菜单保留清除和复制。
 * OMP 没有备用模型字段，不伪造第二套模型选择器。
 */
function RoleRow({
  def,
  value,
  fallback,
  models,
  isLoading,
  disabled,
  onModel,
  onLevel,
  onClear,
}: {
  def: ModelRoleDef
  value: string
  fallback: ModelRoleFallback
  models: readonly Model<Api>[]
  isLoading: boolean
  disabled: boolean
  onModel: (def: ModelRoleDef, model: Model<Api> | null) => void
  onLevel: (def: ModelRoleDef, level: string) => void
  onClear: (def: ModelRoleDef) => void
}) {
  const { t } = useTranslation('settings')
  const [menuOpen, setMenuOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const descriptionId = useId()
  const kebabRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const helpRef = useRef<HTMLButtonElement>(null)
  const helpContentRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (!menuOpen && !helpOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (kebabRef.current?.contains(target) || helpRef.current?.contains(target)) return
      if (menuRef.current?.contains(target) || helpContentRef.current?.contains(target)) return
      setMenuOpen(false)
      setHelpOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setHelpOpen(false)
        if (helpOpen) helpRef.current?.focus()
        else if (menuOpen) kebabRef.current?.focus()
      }
    }
    const onWindowBlur = () => {
      setMenuOpen(false)
      setHelpOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [menuOpen, helpOpen])

  const parsed = parseRoleValue(value)
  const currentKey = parsed ? `${parsed.provider}:${parsed.modelId}` : null
  const selectedModel = parsed
    ? models.find(model => model.provider === parsed.provider && model.id === parsed.modelId) ?? null
    : null
  const levels = selectedModel?.supportedThinkingLevels ?? []
  const levelOptions = [
    { value: '', label: t('models.roleLevelNone') },
    ...levels.map(level => ({ value: level, label: level })),
  ]

  const copyRawValue = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // 剪贴板不可用时静默关闭即可
    }
    setMenuOpen(false)
  }

  const roleName = t(`models.${def.nameKey}`)
  const roleDesc = t(`models.${def.descKey}`)
  const fallbackLabel = t(`models.roleFallbacks.${fallback}.label`)
  const fallbackHint = t(`models.roleFallbacks.${fallback}.hint`)
  const fallbackDescriptionId = `${descriptionId}-fallback`
  const helpId = `${descriptionId}-help`
  const RoleIcon = def.icon

  return (
    <div
      role="group"
      aria-label={roleName}
      aria-describedby={value ? descriptionId : `${descriptionId} ${fallbackDescriptionId}`}
      data-setting-label={roleName}
      data-primary={def.id === 'default'}
      data-assigned={Boolean(value)}
      className="model-role-row"
    >
      <div className="model-role-label">
        <span className="model-role-icon" aria-hidden="true"><RoleIcon size={16} /></span>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="model-role-name truncate">{roleName}</span>
          <button
            ref={helpRef}
            type="button"
            aria-label={t('models.roleHelp', { role: roleName })}
            aria-expanded={helpOpen}
            aria-controls={helpOpen ? helpId : undefined}
            aria-describedby={helpOpen ? helpId : undefined}
            onClick={event => {
              event.currentTarget.focus()
              setMenuOpen(false)
              setHelpOpen(true)
            }}
            onBlur={() => setHelpOpen(false)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100 focus-visible:outline-offset-1"
          >
            <QuestionIcon size={14} />
          </button>
          <span id={descriptionId} className="sr-only">{roleDesc}</span>
          <DropdownMenu
            triggerRef={helpRef}
            isOpen={helpOpen}
            position="top"
            align="left"
            width="280px"
            minWidth="220px"
            maxWidth="min(280px, calc(100vw - 24px))"
            mobileFullWidth
            zIndex={400}
            className="model-role-popover"
          >
            <p ref={helpContentRef} id={helpId} role="tooltip" className="px-2.5 py-2 text-[length:var(--fs-xs)] leading-relaxed text-text-200">
              {roleDesc}
            </p>
          </DropdownMenu>
        </div>
      </div>

      <div className="model-role-controls">
        {value && !parsed ? (
          <div className="role-model-field">
            <div className="flex min-h-9 items-center px-3">
              <span className="truncate font-mono text-[length:var(--fs-sm)] text-text-200" title={value}>{value}</span>
            </div>
          </div>
        ) : (
          <div className="role-model-field">
            <ModelSelector
              models={roleCandidates(def, models)}
              selectedModelKey={currentKey}
              onSelect={(_key, model) => onModel(def, model)}
              isLoading={isLoading}
              disabled={disabled}
              trigger="toolbar"
              placeholder={parsed ? `${parsed.modelId} · ${parsed.provider}` : fallbackLabel}
              triggerTitle={!value ? fallbackHint : undefined}
              zIndex={400}
            />
            <ChevronDownIcon size={14} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-300" />
            {!value && <span id={fallbackDescriptionId} className="sr-only">{fallbackHint}</span>}
          </div>
        )}
        <SettingsSelect
          ariaLabel={`${roleName} ${t('models.roleVariant')}`}
          value={parsed?.level ?? ''}
          onChange={level => onLevel(def, level)}
          options={levelOptions}
          disabled={disabled || !parsed || !selectedModel}
          placeholder={t('models.roleVariant')}
          matchTriggerWidth={false}
          menuMinWidth="7.5rem"
          zIndex={400}
          className="role-variant-select"
        />
        <div
          className="model-role-kebab shrink-0"
          onBlur={event => {
            if (event.currentTarget.contains(event.relatedTarget) || menuRef.current?.contains(event.relatedTarget)) return
            setMenuOpen(false)
          }}
        >
          <button
            ref={kebabRef}
            type="button"
            aria-label={t('models.roleOptions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={disabled}
            onClick={event => {
              event.currentTarget.focus()
              setHelpOpen(false)
              setMenuOpen(open => !open)
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-40"
          >
            <MoreVerticalIcon size={14} />
          </button>
          <DropdownMenu triggerRef={kebabRef} isOpen={menuOpen} position="bottom" align="right" zIndex={400} minWidth="180px" className="model-role-popover">
            <div ref={menuRef} role="menu" aria-label={t('models.roleOptions')} className="p-1">
              <MenuItem
                label={t('models.roleClear')}
                description={t('models.roleClearDesc', { fallback: fallbackHint })}
                disabled={!value || disabled}
                onClick={() => {
                  setMenuOpen(false)
                  onClear(def)
                }}
              />
              <MenuItem label={t('models.rolesCopyValue')} disabled={!value} onClick={() => void copyRawValue()} />
            </div>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
