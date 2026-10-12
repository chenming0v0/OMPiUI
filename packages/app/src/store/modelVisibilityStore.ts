import { useSyncExternalStore } from 'react'
import { serverStorage } from '../utils/perServerStorage'
import { getModelKey, type AnyModel } from '../utils/modelUtils'
import { serverStore } from './serverStore'

type Listener = () => void

const STORAGE_KEY_HIDDEN_MODELS = 'ompiui-hidden-model-keys'

function loadHiddenModelKeys(): string[] {
  const stored = serverStorage.getJSON<unknown>(STORAGE_KEY_HIDDEN_MODELS)
  if (!Array.isArray(stored)) return []
  return stored.filter((item): item is string => typeof item === 'string')
}

class ModelVisibilityStore {
  private hiddenModelKeys = new Set<string>()
  private listeners = new Set<Listener>()
  private snapshot: string[] = []
  private ownerServerId = ''

  constructor() {
    this.reload()
    serverStore.onServerChange(() => {
      this.reload()
      this.emit()
    })
  }

  private syncSnapshot() {
    this.snapshot = Array.from(this.hiddenModelKeys).sort()
  }

  private emit() {
    this.listeners.forEach(listener => listener())
  }

  // 写入前校验归属,避免把旧服务器的隐藏模型集合写入新服务器键
  private ensureOwner(): boolean {
    if (serverStore.getActiveServerId() === this.ownerServerId) return true
    this.reload()
    this.emit()
    return false
  }

  private commit() {
    this.syncSnapshot()
    serverStorage.setJSON(STORAGE_KEY_HIDDEN_MODELS, this.snapshot)
    this.emit()
  }

  private reload() {
    this.hiddenModelKeys = new Set(loadHiddenModelKeys())
    this.ownerServerId = serverStore.getActiveServerId()
    this.syncSnapshot()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): string[] => this.snapshot

  isVisible(model: AnyModel | string): boolean {
    const key = typeof model === 'string' ? model : getModelKey(model)
    return !this.hiddenModelKeys.has(key)
  }

  setVisible(model: AnyModel | string, visible: boolean) {
    if (!this.ensureOwner()) return
    const key = typeof model === 'string' ? model : getModelKey(model)
    let changed = false
    if (visible) {
      changed = this.hiddenModelKeys.delete(key)
    } else if (!this.hiddenModelKeys.has(key)) {
      this.hiddenModelKeys.add(key)
      changed = true
    }
    if (!changed) return
    this.commit()
  }

  setManyVisible(models: AnyModel[], visible: boolean) {
    if (!this.ensureOwner()) return
    let changed = false
    for (const model of models) {
      const key = getModelKey(model)
      if (visible) {
        changed = this.hiddenModelKeys.delete(key) || changed
      } else if (!this.hiddenModelKeys.has(key)) {
        this.hiddenModelKeys.add(key)
        changed = true
      }
    }
    if (!changed) return
    this.commit()
  }
}

export const modelVisibilityStore = new ModelVisibilityStore()

export function useHiddenModelKeys(): string[] {
  return useSyncExternalStore(modelVisibilityStore.subscribe, modelVisibilityStore.getSnapshot)
}
