import { useSyncExternalStore } from 'react'
import type { DshAppSession, DshHostListItem } from '../services/dshRemote'

export interface DshBrowserState {
  hostId: string
  phase: 'opening' | 'opened' | 'delivered' | 'ended'
}

interface DshControllerState {
  session: DshAppSession | null
  hosts: DshHostListItem[]
  browser: DshBrowserState | null
  authError: string | null
  /** 正在等用户完成登录授权；只给通道条显示状态用。 */
  signingIn: boolean
}

let state: DshControllerState = { session: null, hosts: [], browser: null, authError: null, signingIn: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 扫码配对的会话存在本机的这个键下（读写在 services/dshRemote）。 */
export const DSH_PAIRED_KEY = 'ompiui.dsh-remote.paired'

/** 本机有没有留着扫码配对的会话。只看有没有，不读内容。 */
export function hasSavedDshPairing(): boolean {
  try { return localStorage.getItem(DSH_PAIRED_KEY) !== null } catch { return false }
}

// A DSH controller is an authorization session, not a saved server or a permanent URL.
// 账号登录的会话只在内存里；扫码配对的会话会存下来，由 DshRemoteSettings 在加载时接回。
export const dshControllerStore = {
  get: () => state,
  update(patch: Partial<DshControllerState>) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  },
}

export function useDshController() {
  return useSyncExternalStore(subscribe, dshControllerStore.get)
}
