import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Model, Api } from '../../../pi/vendor/pi-ai'
import { Button } from '../../../components/ui/Button'
import { ModelSelector } from '../../chat/ModelSelector'
import { useFocusedSessionId, usePiModels } from '../../../pi/hooks/index.js'
import { refreshPiSessionState, setPiModel, setPiThinkingLevel } from '../../../pi/controllers/index.js'
import { getPiModelRoles, setPiModelRoles } from '../../../pi/transport/index.js'
import {
  getModelKey,
  getModelVariantPref,
  getPreferredModelKey,
  recordModelUsage,
  saveModelVariantPref,
  setPreferredModelKey,
} from '../../../utils/modelUtils'
import { SettingRow, SettingsSelect, SettingsSection, SettingsSubgroup, settingsFieldClass } from './SettingsUI'

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVELS)

/** 首选模型变化事件：聊天页监听后立即同步无会话时的 composer 展示。 */
export const PREFERRED_MODEL_CHANGED_EVENT = 'piui:preferred-model-changed'

function emitPreferredModelChanged(modelKey: string | null) {
  window.dispatchEvent(new CustomEvent(PREFERRED_MODEL_CHANGED_EVENT, { detail: { modelKey } }))
}

// ============================================
// OMP 模型角色（对应 ~/.omp/agent/config.yml 的 modelRoles）
// 角色清单与接受关系来自 OMP 的 model-roles.ts / docs/settings.md。
// ============================================

type ModelRoleDef = {
  id: string
  tag: string
  nameKey: string
  /** 接受的模型 kind（省略 = chat） */
  kinds: string[]
}

const CHAT_ROLE_DEFS: ModelRoleDef[] = [
  { id: 'default', tag: 'DEFAULT', nameKey: 'roleDefault', kinds: ['chat'] },
  { id: 'smol', tag: 'SMOL', nameKey: 'roleSmol', kinds: ['chat'] },
  { id: 'slow', tag: 'SLOW', nameKey: 'roleSlow', kinds: ['chat'] },
  { id: 'vision', tag: 'VISION', nameKey: 'roleVision', kinds: ['chat'] },
  { id: 'plan', tag: 'PLAN', nameKey: 'rolePlan', kinds: ['chat'] },
  { id: 'commit', tag: 'COMMIT', nameKey: 'roleCommit', kinds: ['chat'] },
  { id: 'tiny', tag: 'TINY', nameKey: 'roleTiny', kinds: ['chat', 'tiny'] },
  { id: 'memory', tag: 'MEMORY', nameKey: 'roleMemory', kinds: ['chat', 'tiny'] },
  { id: 'task', tag: 'TASK', nameKey: 'roleTask', kinds: ['chat'] },
  { id: 'advisor', tag: 'ADVISOR', nameKey: 'roleAdvisor', kinds: ['chat'] },
]

const KIND_ROLE_DEFS: ModelRoleDef[] = [
  { id: 'image', tag: 'IMAGE', nameKey: 'roleImage', kinds: ['image'] },
  { id: 'web', tag: 'WEB', nameKey: 'roleWeb', kinds: ['search', 'chat'] },
  { id: 'speech', tag: 'SPEECH', nameKey: 'roleSpeech', kinds: ['tts'] },
  { id: 'dictation', tag: 'DICTATION', nameKey: 'roleDictation', kinds: ['stt'] },
  { id: 'judge', tag: 'JUDGE', nameKey: 'roleJudge', kinds: ['judge', 'tiny', 'chat'] },
]

/** modelRoles 的值：provider/modelId[:thinking]，也允许 @role 等选择器（不在 UI 直接编辑） */
function parseRoleValue(value: string | undefined): { provider: string; modelId: string; level: string } | null {
  if (!value || value.startsWith('@') || value === '*' || value.startsWith('pi/')) return null
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

// ============================================
// 组件
// ============================================

/**
 * 模型快捷配置 — 设置页里的默认模型 / 思考强度 / 功能角色 / 应用到当前会话。
 *
 * 默认模型落在 client 偏好存储（piui-preferred-model-key、piui-model-variant-prefs），
 * 新会话首条消息发送前由 PiChatPane 应用；功能角色写入 OMP 的 modelRoles
 * 配置（经 worker 调 omp config CLI），改动由 OMP 文件监听自动重载。
 */
export function ModelQuickConfig() {
  const { t } = useTranslation(['settings', 'chat'])
  const { models, isLoading } = usePiModels()
  const sessionId = useFocusedSessionId()
  const [preferredKey, setPreferredKey] = useState<string | null>(() => getPreferredModelKey())
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)

  const preferredModel = useMemo(
    () => (preferredKey ? models.find(model => getModelKey(model) === preferredKey) ?? null : null),
    [models, preferredKey],
  )

  const thinkingLevels = useMemo(() => {
    if (!preferredModel) return [] as string[]
    if (!preferredModel.reasoning) return ['off']
    const map = preferredModel.thinkingLevelMap as Record<string, string | null> | undefined
    return PI_THINKING_LEVELS.filter(level => !map || map[level] !== null)
  }, [preferredModel])

  const variant = preferredKey ? getModelVariantPref(preferredKey) : undefined

  const handlePreferredChange = useCallback((_key: string, model: Model<Api>) => {
    const key = getModelKey(model)
    recordModelUsage(model)
    setPreferredModelKey(key)
    setPreferredKey(key)
    setApplied(false)
    emitPreferredModelChanged(key)
  }, [])

  const handleVariantChange = useCallback(
    (level: string) => {
      if (!preferredKey) return
      saveModelVariantPref(preferredKey, level || undefined)
      setApplied(false)
      emitPreferredModelChanged(preferredKey)
    },
    [preferredKey],
  )

  const handleApplyToSession = useCallback(async () => {
    if (!sessionId || !preferredModel) return
    setApplying(true)
    try {
      await setPiModel(sessionId, preferredModel.provider, preferredModel.id)
      if (variant) await setPiThinkingLevel(sessionId, variant)
      await refreshPiSessionState(sessionId)
      setApplied(true)
      window.setTimeout(() => setApplied(false), 2000)
    } finally {
      setApplying(false)
    }
  }, [sessionId, preferredModel, variant])

  const thinkingOptions = useMemo(
    () => [
      { value: '', label: t('models.thinkingFollowServer') },
      ...thinkingLevels.map(level => ({ value: level, label: level })),
    ],
    [thinkingLevels, t],
  )

  return (
    <SettingsSection title={t('models.quickConfig')} description={t('models.quickConfigDesc')}>
      <SettingRow label={t('models.defaultModel')} description={t('models.defaultModelDesc')}>
        {/* 与 settingsFieldClass 同观感：包一层字段盒，让选择器看起来像可输入的 combobox */}
        <div className="w-full max-w-[340px] rounded-lg border border-border-200/50 bg-bg-200/70 hover:bg-bg-200 transition-colors overflow-hidden">
          <ModelSelector
            models={[...models]}
            selectedModelKey={preferredKey}
            onSelect={handlePreferredChange}
            isLoading={isLoading}
            trigger="toolbar"
            placeholder={t('models.defaultModelPlaceholder')}
          />
        </div>
      </SettingRow>

      <SettingRow label={t('models.defaultThinking')} description={t('models.defaultThinkingDesc')}>
        <div className="w-full max-w-[340px]">
          <SettingsSelect
            ariaLabel={t('models.defaultThinking')}
            value={variant ?? ''}
            onChange={handleVariantChange}
            options={thinkingOptions}
            disabled={!preferredModel}
            className={settingsFieldClass}
          />
        </div>
      </SettingRow>

      {sessionId ? (
        <SettingRow label={t('models.applyToSession')} description={t('models.applyToSessionDesc')}>
          <div className="flex shrink-0 items-center gap-2">
            {applied ? <span className="text-[length:var(--fs-xs)] text-success-100">{t('models.appliedToSession')}</span> : null}
            <Button size="sm" variant="secondary" isLoading={applying} disabled={!preferredModel || applying} onClick={() => void handleApplyToSession()}>
              {t('models.applyToSessionAction')}
            </Button>
          </div>
        </SettingRow>
      ) : null}

      <ModelRolesConfig models={models} isLoading={isLoading} />
    </SettingsSection>
  )
}

// ============================================
// OMP 功能角色配置
// ============================================

function ModelRolesConfig({ models, isLoading }: { models: readonly Model<Api>[]; isLoading: boolean }) {
  const { t } = useTranslation(['settings', 'chat'])
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

  const roleCandidates = useCallback(
    (def: ModelRoleDef) => {
      const accepted = models.filter(model => {
        const kind = (model as { kind?: string }).kind ?? 'chat'
        return def.kinds.includes(kind)
      })
      // 某类能力（image/tts/stt 等）服务器可能没有模型：回退展示全部，仍可指派
      return accepted.length > 0 ? accepted : [...models]
    },
    [models],
  )

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
  if (!roles) {
    return isLoading ? null : null
  }

  const renderRoleRow = (def: ModelRoleDef) => {
    const parsed = parseRoleValue(roles[def.id])
    const rawValue = roles[def.id] ?? ''
    const currentKey = parsed ? `${parsed.provider}:${parsed.modelId}` : null
    const candidates = roleCandidates(def)
    const selectedModel = parsed ? models.find(model => model.provider === parsed.provider && model.id === parsed.modelId) ?? null : null
    const levels = selectedModel && selectedModel.reasoning
      ? PI_THINKING_LEVELS.filter(level => {
          const map = selectedModel.thinkingLevelMap as Record<string, string | null> | undefined
          return !map || map[level] !== null
        })
      : selectedModel ? ['off'] : []
    const levelOptions = [
      { value: '', label: t('models.roleLevelNone') },
      ...levels.map(level => ({ value: level, label: level })),
    ]
    const displayName = selectedModel?.name ?? currentKey ?? rawValue

    return (
      <SettingRow
        key={def.id}
        label={<span className="font-mono text-[length:var(--fs-xxs)] tracking-wide text-text-300">{def.tag}</span>}
        description={
          rawValue
            ? displayName
            : t('models.roleAuto')
        }
      >
        <div className="flex w-full max-w-[480px] items-center gap-2">
          <div className="min-w-0 flex-1 rounded-lg border border-border-200/50 bg-bg-200/70 hover:bg-bg-200 transition-colors overflow-hidden">
            <ModelSelector
              models={candidates}
              selectedModelKey={currentKey}
              onSelect={(_key, model) => handleRoleModel(def, model)}
              isLoading={isLoading || busyRole === def.id}
              trigger="toolbar"
              placeholder={t('models.roleAuto')}
            />
          </div>
          {parsed && selectedModel ? (
            <div className="w-[150px] shrink-0">
              <SettingsSelect
                ariaLabel={`${def.tag} ${t('models.defaultThinking')}`}
                value={parsed.level}
                onChange={level => handleRoleLevel(def, level)}
                options={levelOptions}
                disabled={busyRole === def.id}
                className={settingsFieldClass}
              />
            </div>
          ) : null}
          {rawValue ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busyRole === def.id}
              onClick={() => handleRoleModel(def, null)}
            >
              {t('models.roleClear')}
            </Button>
          ) : null}
        </div>
      </SettingRow>
    )
  }

  return (
    <SettingsSubgroup title={t('models.rolesTitle')} description={t('models.rolesDesc')}>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <div className="space-y-0.5">
        <p className="px-2.5 pb-1 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-400/75">{t('models.rolesChatGroup')}</p>
        {CHAT_ROLE_DEFS.map(renderRoleRow)}
      </div>
      <div className="space-y-0.5">
        <p className="px-2.5 pb-1 pt-3 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-400/75">{t('models.rolesKindGroup')}</p>
        {KIND_ROLE_DEFS.map(renderRoleRow)}
      </div>
    </SettingsSubgroup>
  )
}
