import { useSyncExternalStore } from 'react'

const key = 'ompiui-reasoning-translation'
export const REASONING_TRANSLATION_BUDGETS = [6144, 8192, 16384, 32768] as const
export type ReasoningTranslationBudget = (typeof REASONING_TRANSLATION_BUDGETS)[number]
type Settings = { enabled: boolean; budget: ReasoningTranslationBudget }
const defaults: Settings = { enabled: false, budget: 32768 }
let settings = defaults
try {
  const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Settings> | null
  if (saved) settings = {
    enabled: saved.enabled === true,
    budget: REASONING_TRANSLATION_BUDGETS.find(value => value === saved.budget) ?? defaults.budget,
  }
} catch { /* 本地存储不可用时使用默认配置。 */ }
const listeners = new Set<() => void>()

export function setReasoningTranslationSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  try { localStorage.setItem(key, JSON.stringify(settings)) } catch { /* 保存失败时保留内存中的偏好。 */ }
  for (const listener of listeners) listener()
}

export function useReasoningTranslationSettings() {
  return useSyncExternalStore(subscribe, () => settings, () => defaults)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
