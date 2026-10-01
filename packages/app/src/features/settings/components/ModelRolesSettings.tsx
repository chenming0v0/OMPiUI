import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Model, Api } from '../../../omp/vendor/pi-ai'
import { DropdownMenu } from '../../../components/ui/DropdownMenu'
import { MenuItem } from '../../../components/ui/MenuItem'
import { ModelSelector } from '../../chat/ModelSelector'
import { MoreVerticalIcon, QuestionIcon } from '../../../components/Icons'
import { usePiModels } from '../../../omp/hooks/index.js'
import { getPiModelRoles, setPiModelRoles } from '../../../omp/transport/index.js'
import { SettingsSelect, SettingsSection, settingsFieldClass } from './SettingsUI'

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

/** 角色卡片内的字段外观：与快捷配置区的模型选择器同款底色，保证整页一致 */
const roleFieldBoxClass =
  'rounded-lg border border-border-200 bg-bg-200/70 hover:bg-bg-200 transition-colors overflow-hidden'

// ============================================
// OMP 功能角色配置 — 独立 section，卡片式角色行
// ============================================

/**
 * 功能角色模型 — 设置页里独立的一块。
 * 写入 OMP 的 modelRoles 配置（经 worker 调 omp config CLI），
 * 改动由 OMP 文件监听自动重载，对之后的会话生效。
 * 非 OMP 驱动（没有该命令）时整块隐藏。
 */
export function ModelRolesSettings() {
  const { t } = useTranslation('settings')
  const { models, isLoading } = usePiModels()
  const [roles, setRoles] = useState<Record<string, string> | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [busyRole, setBusyRole] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getPiModelRoles()
      .then(record => {
        if (!cancelled) setRoles(record)
      })
      .catch(() => {
        // 非 OMP 驱动（没有该命令）时静默隐藏角色区
        if (!cancelled) setUnavailable(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const saveRoles = useCallback(async (roleId: string, next: Record<string, string>) => {
    setBusyRole(roleId)
    setError(null)
    try {
      const saved = await setPiModelRoles(next)
      setRoles(saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyRole(null)
    }
  }, [])

  const handleRoleModel = useCallback(
    (def: ModelRoleDef, model: Model<Api> | null) => {
      if (!roles) return
      const next = { ...roles }
      const current = parseRoleValue(roles[def.id])
      const level = current?.level ?? ''
      if (model) next[def.id] = formatRoleValue(model.provider, model.id, level)
      else delete next[def.id]
      setRoles(next)
      void saveRoles(def.id, next)
    },
    [roles, saveRoles],
  )

  const handleRoleLevel = useCallback(
    (def: ModelRoleDef, level: string) => {
      if (!roles) return
      const current = parseRoleValue(roles[def.id])
      if (!current) return
      const next = { ...roles, [def.id]: formatRoleValue(current.provider, current.modelId, level) }
      setRoles(next)
      void saveRoles(def.id, next)
    },
    [roles, saveRoles],
  )

  if (unavailable) return null
  if (!roles) return null

  const renderRoleRow = (def: ModelRoleDef) => (
    <RoleRow
      key={def.id}
      def={def}
      value={roles[def.id] ?? ''}
      models={models}
      isLoading={isLoading}
      busy={busyRole === def.id}
      onModel={handleRoleModel}
      onLevel={handleRoleLevel}
      onClear={roleDef => handleRoleModel(roleDef, null)}
    />
  )

  return (
    <SettingsSection title={t('models.rolesTitle')} description={t('models.rolesDesc')}>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <RoleGroup label={t('models.rolesChatGroup')}>{CHAT_ROLE_DEFS.map(renderRoleRow)}</RoleGroup>
      <RoleGroup label={t('models.rolesKindGroup')}>{KIND_ROLE_DEFS.map(renderRoleRow)}</RoleGroup>
    </SettingsSection>
  )
}

function RoleGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="pb-1.5 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-400/75">{label}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

/**
 * 角色卡片行 — 左侧角色名（+ 说明提示与配置键），右侧模型选择器、
 * 思考强度与 kebab 菜单（清除 / 复制原始值）。
 */
function RoleRow({
  def,
  value,
  models,
  isLoading,
  busy,
  onModel,
  onLevel,
  onClear,
}: {
  def: ModelRoleDef
  value: string
  models: readonly Model<Api>[]
  isLoading: boolean
  busy: boolean
  onModel: (def: ModelRoleDef, model: Model<Api> | null) => void
  onLevel: (def: ModelRoleDef, level: string) => void
  onClear: (def: ModelRoleDef) => void
}) {
  const { t } = useTranslation('settings')
  const [menuOpen, setMenuOpen] = useState(false)
  const kebabRef = useRef<HTMLButtonElement>(null)

  // 点击外部 / Esc 关闭 kebab 菜单
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (kebabRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

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

  return (
    <div className="rounded-lg border border-border-200 bg-bg-100 px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        {/* 角色名 + 说明提示 + 配置键 */}
        <div className="min-w-0 sm:w-28 sm:shrink-0">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[length:var(--fs-sm)] font-medium text-text-100">{t(`models.${def.nameKey}`)}</span>
            <span className="shrink-0 cursor-help text-text-400/70" title={t(`models.${def.descKey}`)}>
              <QuestionIcon size={12} />
            </span>
          </div>
          <div className="truncate font-mono text-[length:var(--fs-xxs)] tracking-wide text-text-500" title={def.id}>
            {def.id}
          </div>
        </div>

        {/* 模型选择器 + 思考强度 + kebab */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {value && !parsed ? (
            // @role 等选择器值不在 UI 直接编辑：只读展示，可通过菜单清除
            <div className={`min-w-0 flex-1 ${roleFieldBoxClass}`}>
              <div className="flex h-8 items-center px-2.5">
                <span className="truncate font-mono text-[length:var(--fs-sm)] text-text-200" title={value}>
                  {value}
                </span>
              </div>
            </div>
          ) : (
            <div className={`min-w-0 flex-1 ${roleFieldBoxClass}`}>
              <ModelSelector
                models={roleCandidates(def, models)}
                selectedModelKey={currentKey}
                onSelect={(_key, model) => onModel(def, model)}
                isLoading={isLoading || busy}
                trigger="toolbar"
                placeholder={t('models.roleAuto')}
                zIndex={400}
              />
            </div>
          )}
          <div className="w-[118px] shrink-0">
            <SettingsSelect
              ariaLabel={`${t(`models.${def.nameKey}`)} ${t('models.defaultThinking')}`}
              value={parsed?.level ?? ''}
              onChange={level => onLevel(def, level)}
              options={levelOptions}
              disabled={busy || !parsed || !selectedModel}
              className={`${settingsFieldClass} ${roleFieldBoxClass}`}
            />
          </div>
          <div className="shrink-0">
            <button
              ref={kebabRef}
              type="button"
              aria-label={t('models.roleOptions')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
              onClick={() => setMenuOpen(open => !open)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200/60 hover:text-text-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-40"
            >
              <MoreVerticalIcon size={14} />
            </button>
            <DropdownMenu triggerRef={kebabRef} isOpen={menuOpen} position="bottom" align="right" zIndex={400} minWidth="180px">
              <div role="menu" aria-label={t('models.roleOptions')} className="p-1">
                <MenuItem
                  label={t('models.roleClear')}
                  description={t('models.roleClearDesc')}
                  disabled={!value || busy}
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
    </div>
  )
}
