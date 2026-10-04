import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Model, Api } from '../../../omp/vendor/pi-ai'
import { Button } from '../../../components/ui/Button'
import { DropdownMenu } from '../../../components/ui/DropdownMenu'
import { MenuItem } from '../../../components/ui/MenuItem'
import { ModelSelector } from '../../chat/ModelSelector'
import { ChevronDownIcon, MoreVerticalIcon, QuestionIcon } from '../../../components/Icons'
import { usePiModels } from '../../../omp/hooks/index.js'
import { getPiModelRoles, setPiModelRoles } from '../../../omp/transport/index.js'
import { SettingsSelect, SettingsSection } from './SettingsUI'

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVELS)

// ============================================
// OMP 模型角色（对应 ~/.omp/agent/config.yml 的 modelRoles）
// 角色清单与接受关系来自 OMP 的 model-roles.ts / docs/settings.md。
// ============================================

type ModelRoleDef = {
  id: string
  tag: string
  nameKey: string
  descKey: string
  /** 接受的模型 kind（省略 = chat） */
  kinds: string[]
}

const CHAT_ROLE_DEFS: ModelRoleDef[] = [
  { id: 'default', tag: 'DEFAULT', nameKey: 'roleDefault', descKey: 'roleDefaultDesc', kinds: ['chat'] },
  { id: 'smol', tag: 'SMOL', nameKey: 'roleSmol', descKey: 'roleSmolDesc', kinds: ['chat'] },
  { id: 'slow', tag: 'SLOW', nameKey: 'roleSlow', descKey: 'roleSlowDesc', kinds: ['chat'] },
  { id: 'vision', tag: 'VISION', nameKey: 'roleVision', descKey: 'roleVisionDesc', kinds: ['chat'] },
  { id: 'plan', tag: 'PLAN', nameKey: 'rolePlan', descKey: 'rolePlanDesc', kinds: ['chat'] },
  { id: 'commit', tag: 'COMMIT', nameKey: 'roleCommit', descKey: 'roleCommitDesc', kinds: ['chat'] },
  { id: 'tiny', tag: 'TINY', nameKey: 'roleTiny', descKey: 'roleTinyDesc', kinds: ['chat', 'tiny'] },
  { id: 'memory', tag: 'MEMORY', nameKey: 'roleMemory', descKey: 'roleMemoryDesc', kinds: ['chat', 'tiny'] },
  { id: 'task', tag: 'TASK', nameKey: 'roleTask', descKey: 'roleTaskDesc', kinds: ['chat'] },
  { id: 'advisor', tag: 'ADVISOR', nameKey: 'roleAdvisor', descKey: 'roleAdvisorDesc', kinds: ['chat'] },
]

const KIND_ROLE_DEFS: ModelRoleDef[] = [
  { id: 'image', tag: 'IMAGE', nameKey: 'roleImage', descKey: 'roleImageDesc', kinds: ['image'] },
  { id: 'web', tag: 'WEB', nameKey: 'roleWeb', descKey: 'roleWebDesc', kinds: ['search', 'chat'] },
  { id: 'speech', tag: 'SPEECH', nameKey: 'roleSpeech', descKey: 'roleSpeechDesc', kinds: ['tts'] },
  { id: 'dictation', tag: 'DICTATION', nameKey: 'roleDictation', descKey: 'roleDictationDesc', kinds: ['stt'] },
  { id: 'judge', tag: 'JUDGE', nameKey: 'roleJudge', descKey: 'roleJudgeDesc', kinds: ['judge', 'tiny', 'chat'] },
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

const roleFieldBoxClass =
  'rounded-md border border-border-200 bg-bg-200 transition-colors hover:border-border-300 focus-within:border-accent-main-100 focus-within:ring-1 focus-within:ring-accent-main-100/30'

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
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const { models, isLoading } = usePiModels()
  const [saved, setSaved] = useState<Record<string, string> | null>(null)
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getPiModelRoles()
      .then(record => {
        if (cancelled) return
        setSaved(record)
        setDraft(cloneRoles(record))
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
      const next = await setPiModelRoles(draft)
      setSaved(next)
      setDraft(cloneRoles(next))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [draft])

  if (unavailable || !saved || !draft) return null

  const dirty = !sameRoles(saved, draft)
  const renderRoleRow = (def: ModelRoleDef) => (
    <RoleRow
      key={def.id}
      def={def}
      value={draft[def.id] ?? ''}
      models={models}
      isLoading={isLoading}
      disabled={saving}
      onModel={handleRoleModel}
      onLevel={handleRoleLevel}
      onClear={roleDef => handleRoleModel(roleDef, null)}
    />
  )

  return (
    <SettingsSection title={t('models.rolesTitle')} description={t('models.rolesDesc')} collapsible className="model-roles-section">
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <RoleGroup label={t('models.rolesChatGroup')}>{CHAT_ROLE_DEFS.map(renderRoleRow)}</RoleGroup>
      <RoleGroup label={t('models.rolesKindGroup')}>{KIND_ROLE_DEFS.map(renderRoleRow)}</RoleGroup>
      <div className="model-roles-footer">
        <Button type="button" variant="secondary" size="sm" disabled={saving || !dirty} onClick={handleCancel}>
          {tc('cancel')}
        </Button>
        <Button type="button" variant="primary" size="sm" isLoading={saving} disabled={!dirty} onClick={() => void handleSave()}>
          {tc('save')}
        </Button>
      </div>
    </SettingsSection>
  )
}

function RoleGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="model-role-group">
      <p className="mb-3 text-[length:var(--fs-xxs)] font-medium tracking-wide text-text-300">{label}</p>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

/**
 * 角色名右对齐；主行 = 模型 + 思考强度 + kebab。菜单保留清除/复制。
 * OMP 没有备用模型字段，不伪造第二套模型选择器。
 */
function RoleRow({
  def,
  value,
  models,
  isLoading,
  disabled,
  onModel,
  onLevel,
  onClear,
}: {
  def: ModelRoleDef
  value: string
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
  const kebabRef = useRef<HTMLButtonElement>(null)
  const helpRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen && !helpOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (kebabRef.current?.contains(target) || helpRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.model-role-popover')) return
      setMenuOpen(false)
      setHelpOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setHelpOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen, helpOpen])

  const parsed = parseRoleValue(value)
  const currentKey = parsed ? `${parsed.provider}:${parsed.modelId}` : null
  const selectedModel = parsed
    ? models.find(model => model.provider === parsed.provider && model.id === parsed.modelId) ?? null
    : null
  const levels =
    selectedModel && selectedModel.reasoning
      ? PI_THINKING_LEVELS.filter(level => {
          const map = selectedModel.thinkingLevelMap as Record<string, string | null> | undefined
          return !map || map[level] !== null
        })
      : selectedModel
        ? ['off']
        : []
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

  return (
    <div data-setting-label={roleName} className="model-role-row">
      <div className="model-role-label flex min-w-0 items-center gap-1">
        <span className="text-[length:var(--fs-sm)] font-medium text-text-100">{roleName}</span>
        <button
          ref={helpRef}
          type="button"
          aria-label={roleDesc}
          aria-expanded={helpOpen}
          aria-haspopup="dialog"
          onClick={() => {
            setMenuOpen(false)
            setHelpOpen(open => !open)
          }}
          className="inline-flex shrink-0 items-center justify-center rounded text-text-300 transition-colors hover:text-text-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100"
        >
          <QuestionIcon size={13} />
        </button>
        <DropdownMenu triggerRef={helpRef} isOpen={helpOpen} position="top" align="right" zIndex={400} minWidth="220px" maxWidth="280px" className="model-role-popover">
          <p className="px-2.5 py-2 text-[length:var(--fs-xs)] leading-relaxed text-text-200">{roleDesc}</p>
        </DropdownMenu>
      </div>

      <div className="model-role-controls">
        {value && !parsed ? (
          <div className={`min-w-0 flex-1 ${roleFieldBoxClass}`}>
            <div className="flex h-[30px] items-center px-2.5">
              <span className="truncate font-mono text-[length:var(--fs-sm)] text-text-200" title={value}>{value}</span>
            </div>
          </div>
        ) : (
          <div className={`role-model-field relative min-w-0 flex-1 ${roleFieldBoxClass}`}>
            <ModelSelector
              models={roleCandidates(def, models)}
              selectedModelKey={currentKey}
              onSelect={(_key, model) => onModel(def, model)}
              isLoading={isLoading}
              disabled={disabled}
              trigger="toolbar"
              placeholder={t('models.roleAuto')}
              zIndex={400}
            />
            <ChevronDownIcon size={14} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-300" />
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
        <div className="model-role-kebab shrink-0">
          <button
            ref={kebabRef}
            type="button"
            aria-label={t('models.roleOptions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={disabled}
            onClick={() => {
              setHelpOpen(false)
              setMenuOpen(open => !open)
            }}
            className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-md text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-40"
          >
            <MoreVerticalIcon size={14} />
          </button>
          <DropdownMenu triggerRef={kebabRef} isOpen={menuOpen} position="bottom" align="right" zIndex={400} minWidth="180px" className="model-role-popover">
            <div role="menu" aria-label={t('models.roleOptions')} className="p-1">
              <MenuItem
                label={t('models.roleClear')}
                description={t('models.roleClearDesc')}
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
