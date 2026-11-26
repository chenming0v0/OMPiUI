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
}

let state: DshControllerState = { session: null, hosts: [], browser: null, authError: null }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// A DSH controller is an authorization session, not a saved server or a permanent URL.
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
