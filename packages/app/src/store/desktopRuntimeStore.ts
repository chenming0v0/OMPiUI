import { useSyncExternalStore } from 'react'
import {
  getDesktopRuntimeCatalog,
  saveDesktopRuntimeSelection,
  type DesktopRuntimeCatalog,
} from '../services/desktopService'
import { serviceStore } from './serviceStore'

const STORAGE_KEY = 'ompiui-runtime-catalog'
// 检测要逐个执行 omp --version，几秒级；同一后端进程和同一启动环境下的结果在这段时间内直接复用。
const FRESH_MS = 5 * 60_000

export interface DesktopRuntimeSnapshot {
  catalog: DesktopRuntimeCatalog | null
  /** 检测时使用的启动环境签名；与当前不同说明 available 已过期。 */
  environment: string | null
  /** 读取 current 时的后端进程标识；与正在运行的进程不同则 current 不能代表正在使用。 */
  backend: string | null
  checkedAt: number | null
  loading: boolean
  error: string
}

function environmentSignature() {
  return JSON.stringify(serviceStore.envVarsRecord)
}

function readStored(): Pick<DesktopRuntimeSnapshot, 'catalog' | 'environment' | 'backend' | 'checkedAt'> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.catalog?.available || !Array.isArray(parsed.catalog.available.candidates)) return null
    return {
      catalog: parsed.catalog,
      environment: typeof parsed.environment === 'string' ? parsed.environment : null,
      backend: typeof parsed.backend === 'string' ? parsed.backend : null,
      checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : null,
    }
  } catch {
    return null
  }
}

class DesktopRuntimeStore {
  private snapshot: DesktopRuntimeSnapshot = {
    catalog: null,
    environment: null,
    backend: null,
    checkedAt: null,
    loading: false,
    error: '',
    ...readStored(),
  }
  private listeners = new Set<() => void>()
  private request = 0
  private inflight: { key: string; promise: Promise<void> } | null = null
  private saving = false

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<DesktopRuntimeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach(listener => listener())
  }

  /** 写入一次完整检测结果并持久化，下次打开面板先显示它，再按需后台刷新。 */
  receive(catalog: DesktopRuntimeCatalog, backend: string | null) {
    this.request += 1
    this.inflight = null
    const stored = { catalog, environment: environmentSignature(), backend, checkedAt: Date.now() }
    this.update({ ...stored, loading: false, error: '' })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    } catch {
      // Storage can be unavailable in restricted webviews.
    }
  }

  /** 缓存仍对应当前环境与后端进程时跳过；同一目标的并发请求合并为一次检测。 */
  refresh(backend: string | null, force = false): Promise<void> {
    const environment = environmentSignature()
    const key = `${environment}\n${backend ?? ''}`
    const { catalog, checkedAt } = this.snapshot
    const fresh =
      !!catalog &&
      this.snapshot.environment === environment &&
      this.snapshot.backend === backend &&
      checkedAt !== null &&
      Date.now() - checkedAt < FRESH_MS
    if (!force && (fresh || this.saving)) return Promise.resolve()
    if (this.inflight?.key === key) return this.inflight.promise
    const request = ++this.request
    this.update({ loading: true, error: '' })
    const promise = getDesktopRuntimeCatalog().then(
      next => {
        if (request === this.request) this.receive(next, backend)
      },
      reason => {
        if (request !== this.request) return
        this.inflight = null
        this.update({ loading: false, error: String(reason) })
      },
    )
    this.inflight = { key, promise }
    return promise
  }

  /**
   * 保存选择并直接沿用保存时的校验结果。保存期间启动环境会变化，
   * 期间触发的自动刷新跳过，避免同一选择再检测一遍。
   */
  async save(path: string | null, runtimeRoot: string | null | undefined, backend: string | null) {
    this.saving = true
    let checked: DesktopRuntimeCatalog | null
    try {
      checked = await saveDesktopRuntimeSelection(path, runtimeRoot)
    } finally {
      this.saving = false
    }
    if (checked) this.receive(checked, backend)
    else await this.refresh(backend, true)
  }

  reset() {
    this.request += 1
    this.inflight = null
    this.saving = false
    this.update({ catalog: null, environment: null, backend: null, checkedAt: null, loading: false, error: '' })
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Storage can be unavailable in restricted webviews.
    }
  }
}

export const desktopRuntimeStore = new DesktopRuntimeStore()

export function useDesktopRuntime() {
  return useSyncExternalStore(desktopRuntimeStore.subscribe, desktopRuntimeStore.getSnapshot)
}
