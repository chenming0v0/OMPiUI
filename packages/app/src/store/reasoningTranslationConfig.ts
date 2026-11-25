import { useEffect, useSyncExternalStore } from 'react'
import { REASONING_TRANSLATION_CONCURRENCY, type ReasoningTranslationConfig } from '@ompiui/protocol'
import { useServerStore } from '../hooks/useServerStore'
import { serverStore } from './serverStore'
import { getApiBase, piFetch } from '../omp/httpClient'

type Snapshot = ReasoningTranslationConfig & { generation: number; loading: boolean; failed: boolean }
const initial: Snapshot = { generation: -1, concurrency: REASONING_TRANSLATION_CONCURRENCY.default, loading: true, failed: false }
let snapshot = initial
let version = 0
let loading: Promise<void> | undefined
let savingGeneration: number | undefined
let savingVersion: number | undefined
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(next: Snapshot) {
  snapshot = next
  for (const listener of listeners) listener()
}
async function readConfig(response: Response): Promise<ReasoningTranslationConfig> {
  if (!response.ok) throw new Error('Translation configuration unavailable')
  const config = await response.json() as ReasoningTranslationConfig
  if (!Number.isInteger(config.concurrency) || config.concurrency < REASONING_TRANSLATION_CONCURRENCY.min || config.concurrency > REASONING_TRANSLATION_CONCURRENCY.max) throw new Error('Invalid translation configuration')
  return config
}

export function loadReasoningTranslationConfig(): Promise<void> {
  const generation = serverStore.getActiveServerGeneration()
  if (savingGeneration === generation) return Promise.resolve()
  if (loading && snapshot.generation === generation) return loading
  const requestVersion = ++version
  if (snapshot.generation !== generation) publish({ ...initial, generation })
  const request = (async () => {
    try {
      const config = await readConfig(await piFetch(`${getApiBase()}/api/v1/pi/reasoning/config`, { privateStream: true }))
      if (generation === serverStore.getActiveServerGeneration() && requestVersion === version) publish({ ...config, generation, loading: false, failed: false })
    } catch {
      if (generation === serverStore.getActiveServerGeneration() && requestVersion === version) publish({ ...snapshot, generation, loading: false, failed: true })
    }
  })()
  loading = request
  void request.finally(() => { if (loading === request) loading = undefined })
  return request
}

export async function setReasoningTranslationConcurrency(concurrency: number) {
  const generation = serverStore.getActiveServerGeneration()
  const requestVersion = ++version
  savingGeneration = generation
  savingVersion = requestVersion
  publish({ ...snapshot, generation, loading: true, failed: false })
  try {
    const config = await readConfig(await piFetch(`${getApiBase()}/api/v1/pi/reasoning/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ concurrency }), privateStream: true,
    }))
    if (generation === serverStore.getActiveServerGeneration() && requestVersion === version) publish({ ...config, generation, loading: false, failed: false })
  } catch {
    if (generation === serverStore.getActiveServerGeneration() && requestVersion === version) publish({ ...snapshot, generation, loading: false, failed: true })
  } finally {
    if (savingVersion === requestVersion) { savingVersion = undefined; savingGeneration = undefined }
  }
}

export function useReasoningTranslationConfig() {
  const { activeServerGeneration } = useServerStore()
  const config = useSyncExternalStore(subscribe, () => snapshot.generation === activeServerGeneration ? snapshot : initial, () => initial)
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadReasoningTranslationConfig()
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [activeServerGeneration])
  return config
}
