import { serverStore } from '../store/serverStore'
import { serverStorage } from '../utils/perServerStorage'
import type { Api, Model } from './vendor/pi-ai'

const MODELS_KEY = 'ompiui-models-cache'
const ROLES_KEY = 'ompiui-model-roles-cache'

function endpoint(): string | undefined {
  // 使用保存的地址，避免桌面服务重启时临时端口变化导致缓存失效。
  return serverStore.getStoredServers().find(server => server.id === serverStore.getActiveServerId())?.url
}

function readCache(key: string): unknown {
  const cache = serverStorage.getJSON<{ version?: number; endpoint?: string; value?: unknown }>(key)
  return cache?.version === 1 && cache.endpoint === endpoint() ? cache.value : null
}

function writeCache(key: string, value: unknown): void {
  serverStorage.setJSON(key, { version: 1, endpoint: endpoint(), value })
}

export function readModelsCache(): Model<Api>[] {
  const models = readCache(MODELS_KEY)
  if (!Array.isArray(models)) return []
  return models.filter((model): model is Model<Api> =>
    model != null && typeof model.id === 'string' && typeof model.provider === 'string' &&
    typeof model.name === 'string' && Array.isArray(model.input),
  )
}

export function writeModelsCache(models: readonly Model<Api>[]): void {
  // 仅持久化界面需要的字段，不保存可能包含凭据的 headers、baseUrl 等运行时配置。
  writeCache(MODELS_KEY, models.map(model => ({
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: '',
    provider: model.provider,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevelMap: model.thinkingLevelMap,
    kind: (model as Model<Api> & { kind?: string }).kind,
  })))
}

export function readModelRolesCache(): Record<string, string> | null {
  const roles = readCache(ROLES_KEY)
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return null
  if (!Object.values(roles).every(value => typeof value === 'string')) return null
  return roles as Record<string, string>
}

export function writeModelRolesCache(roles: Record<string, string>): void {
  writeCache(ROLES_KEY, roles)
}
