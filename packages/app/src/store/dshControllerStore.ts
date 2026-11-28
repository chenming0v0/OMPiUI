import { useSyncExternalStore } from 'react'
import type { DshAppSession, DshHostListItem } from '../services/dshRemote'
import { hasSavedDshSession } from '../services/dshSessionStorage'

export interface DshServerState {
  hostId: string
  serverId: string
  phase: 'connecting' | 'connected' | 'ended'
}

interface DshControllerState {
  session: DshAppSession | null
  hosts: DshHostListItem[]
  connection: DshServerState | null
  authError: string | null
  /** 正在等用户完成登录授权；只给通道条显示状态用。 */
  signingIn: boolean
}

let state: DshControllerState = { session: null, hosts: [], connection: null, authError: null, signingIn: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 扫码配对的会话存在本机的这个键下（读写在 services/dshRemote）。 */
export const DSH_PAIRED_KEY = 'ompiui.dsh-remote.paired'

/** 是否存在可恢复的控制端授权，供延迟挂载面板恢复会话。 */
export function hasSavedDshPairing(): boolean {
  return hasSavedDshSession()
}

// 账号和配对授权均按设备保存，由 DS 面板恢复为当前进程的控制端会话。
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
