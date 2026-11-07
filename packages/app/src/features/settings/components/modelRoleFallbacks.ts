export type ModelRoleFallback =
  | 'startup'
  | 'fastPriority'
  | 'thinkingPriority'
  | 'advisorPriority'
  | 'inheritDefault'
  | 'inheritFast'
  | 'inheritTiny'
  | 'inheritThinking'
  | 'vision'
  | 'plan'
  | 'commit'
  | 'task'
  | 'image'
  | 'web'
  | 'speech'
  | 'dictation'
  | 'judge'
  | 'unassigned'

/**
 * 对齐 OMP 18.12.6 的展示提示，不在前端解析或写入最终模型。
 * 角色继承见 config/model-resolver.ts；能力优先列表见 pi-catalog 的
 * compat/rules/runtime/behavior.kdl。视觉、提交和子任务还遵循各自调用入口的回退。
 */
export function getModelRoleFallback(role: string, roles: Readonly<Record<string, string>>): ModelRoleFallback {
  switch (role) {
    case 'default': return 'startup'
    case 'smol': return roles.default?.trim() ? 'inheritDefault' : 'fastPriority'
    case 'slow': return roles.default?.trim() ? 'inheritDefault' : 'thinkingPriority'
    case 'tiny': return 'inheritFast'
    case 'memory': return 'inheritTiny'
    // 顾问只继承显式配置的思考角色，不经由未配置的思考角色继承默认模型。
    case 'advisor': return roles.slow?.trim() ? 'inheritThinking' : 'advisorPriority'
    case 'vision': return 'vision'
    case 'plan': return 'plan'
    case 'commit': return 'commit'
    case 'task': return 'task'
    case 'image': return 'image'
    case 'web': return 'web'
    case 'speech': return 'speech'
    case 'dictation': return 'dictation'
    case 'judge': return 'judge'
    default: return 'unassigned'
  }
}
