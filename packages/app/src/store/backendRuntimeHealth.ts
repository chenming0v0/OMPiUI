import { useSyncExternalStore } from 'react'

export interface BackendRuntimeHealth {
  workerReady?: boolean | null
  ompVersion?: string | null
}

export type BackendRuntimeStatus = 'ready' | 'worker-unready' | 'missing' | 'unknown'

export function backendRuntimeStatus(health: BackendRuntimeHealth | null | undefined): BackendRuntimeStatus {
  if (health?.workerReady === false) return 'worker-unready'
  if (health?.workerReady !== true) return 'unknown'
  return health.ompVersion ? 'ready' : 'missing'
}

// HTTP 探测和桌面诊断按实际后端地址共享运行时快照，以请求开始时间排除迟到结果。
const snapshots = new Map<string, BackendRuntimeHealth & { checkedAt: number }>()
const listeners = new Set<() => void>()
const endpoint = (url: string) => url.replace(/\/+$/, '')
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function receiveBackendRuntimeHealth(url: string, health: BackendRuntimeHealth, checkedAt: number): void {
  const key = endpoint(url)
  if ((snapshots.get(key)?.checkedAt ?? -Infinity) > checkedAt) return
  snapshots.set(key, { workerReady: health.workerReady, ompVersion: health.ompVersion, checkedAt })
  listeners.forEach(listener => listener())
}

export function useBackendRuntimeHealth(url: string | null | undefined): BackendRuntimeHealth | null {
  return useSyncExternalStore(subscribe, () => url ? snapshots.get(endpoint(url)) ?? null : null)
}
