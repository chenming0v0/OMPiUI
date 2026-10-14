import { useSyncExternalStore } from 'react'
import { PROTOCOL_VERSION, type HealthResponse, type PiRegistrySnapshot } from '@ompiui/protocol'
import { fetchHostHealth, fetchPiRegistry } from './transport/index.js'
import { serverStore } from '../store/serverStore'

const CORE_PI_COMMANDS = [
  'session.open',
  'session.listAll',
  'state.get',
  'branch.get',
  'prompt',
  'abort',
  'registry.get',
]

export type PiNativeStatus = {
  status: 'booting' | 'online' | 'degraded' | 'offline' | 'unauthorized'
  health?: HealthResponse
  registry?: PiRegistrySnapshot
  missingCoreCommands: string[]
  error?: string
  /** 凭据错误或端点不兼容时为 false，必须停止自动探测。 */
  retryable?: boolean
  checkedAt?: number
}

let current: PiNativeStatus = {
  status: 'booting',
  missingCoreCommands: CORE_PI_COMMANDS,
}
const listeners = new Set<() => void>()

export function getPiNativeStatus(): PiNativeStatus {
  return current
}

export function usePiNativeStatus(): PiNativeStatus {
  return useSyncExternalStore(subscribe, getPiNativeStatus, getPiNativeStatus)
}

export async function refreshPiNativeStatus(signal?: AbortSignal): Promise<PiNativeStatus> {
  const generation = serverStore.getActiveServerGeneration()
  if (!signal?.aborted) setStatus({ ...current, status: 'booting', error: undefined, retryable: undefined })
  try {
    const [healthResult, registryResult] = await Promise.allSettled([
      fetchHostHealth(signal).then(validateHealth),
      fetchPiRegistry(signal).then(validateRegistry),
    ])
    // 一端的快速瞬态失败不能遮蔽另一端的终态结果，
    // 也不能让旧请求延续到下一轮探测。
    if (healthResult.status === 'rejected' && !isRetryableNativeError(healthResult.reason)) throw healthResult.reason
    if (registryResult.status === 'rejected') throw registryResult.reason
    if (healthResult.status === 'rejected') throw healthResult.reason
    const health = healthResult.value
    const registry = registryResult.value
    const missingCoreCommands = missingCore(registry)
    const next: PiNativeStatus = {
      status: missingCoreCommands.length > 0 ? 'degraded' : 'online',
      health,
      registry,
      missingCoreCommands,
      checkedAt: Date.now(),
    }
    if (!signal?.aborted && generation === serverStore.getActiveServerGeneration()) setStatus(next)
    return next
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const next: PiNativeStatus = {
      status: isUnauthorized(error) ? 'unauthorized' : 'offline',
      missingCoreCommands: CORE_PI_COMMANDS,
      error: message,
      retryable: isRetryableNativeError(error),
      checkedAt: Date.now(),
    }
    if (!signal?.aborted && generation === serverStore.getActiveServerGeneration()) setStatus(next)
    return next
  }
}

class UnexpectedBackendError extends Error {}

function validateHealth(health: HealthResponse): HealthResponse {
  if (health?.service !== 'ompiui-server' || health.protocolVersion !== PROTOCOL_VERSION) {
    throw new UnexpectedBackendError('Unexpected backend service or protocol version')
  }
  return health
}

function validateRegistry(registry: PiRegistrySnapshot): PiRegistrySnapshot {
  if (
    registry?.protocolVersion !== PROTOCOL_VERSION ||
    (registry.driver !== 'omp' && registry.driver !== 'mock') ||
    !Array.isArray(registry.globalCommands) ||
    !Array.isArray(registry.sessionCommands) ||
    !registry.globalCommands.every(command => typeof command?.name === 'string') ||
    !registry.sessionCommands.every(command => typeof command?.name === 'string')
  ) {
    throw new UnexpectedBackendError('Unexpected backend registry or protocol version')
  }
  return registry
}

function httpStatus(error: unknown): number | undefined {
  return error !== null && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined
}

function isUnauthorized(error: unknown): boolean {
  const status = httpStatus(error)
  return status === 401 || status === 403
}

function isRetryableNativeError(error: unknown): boolean {
  if (error instanceof UnexpectedBackendError || error instanceof SyntaxError) return false
  const status = httpStatus(error)
  // 超时、Too Early 和限流仍属瞬态；固定只读端点的其他 4xx
  // 需要修正配置或协议，不能无限重试。
  return status === undefined || status < 400 || status >= 500 || status === 408 || status === 425 || status === 429
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export { subscribe as subscribePiNativeStatus }

/**
 * Test helper: inject a fake registry into the native status snapshot.
 */
export function piNativeStatusForTest(registry: Partial<import('@ompiui/protocol').PiRegistrySnapshot> | undefined): void {
  setStatus({
    status: registry ? 'online' : 'offline',
    registry: registry
      ? {
          protocolVersion: PROTOCOL_VERSION,
          revision: 1,
          sdkVersion: 'test',
          driver: 'mock',
          globalCommands: [],
          sessionCommands: [],
          ...registry,
        } as import('@ompiui/protocol').PiRegistrySnapshot
      : undefined,
    missingCoreCommands: [],
    checkedAt: Date.now(),
  })
}

function setStatus(next: PiNativeStatus): void {
  current = next
  for (const listener of listeners) listener()
}

function missingCore(registry: PiRegistrySnapshot): string[] {
  const names = new Set([
    ...registry.globalCommands.map(command => command.name),
    ...registry.sessionCommands.map(command => command.name),
  ])
  return CORE_PI_COMMANDS.filter(name => !names.has(name))
}
