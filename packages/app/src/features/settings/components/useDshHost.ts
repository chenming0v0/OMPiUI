import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { serviceStore } from '../../../store/serviceStore'
import type { LampTone } from './ChannelBoard'

const HOST_POLL_MS = 5_000
// 扫码配对进行中要跟上手机那一侧的动作。
const PAIRING_POLL_MS = 2_000

export interface DshHostPairing {
  state: 'created' | 'claimed' | 'approved' | 'completed' | 'failed' | 'cancelled' | 'expired'
  expiresAt: number
  qr?: string
  fingerprint: string
  phone?: { name: string; fingerprint: string }
  failure?: string
  retry: boolean
}

interface DshHostStatus {
  available: boolean
  reason?: 'loopback' | 'web' | null
  enabled: boolean
  registered: boolean
  deviceId: string | null
  state: 'unregistered' | 'disabled' | 'connecting' | 'online' | 'error' | 'stopped'
  lastError?: { code: string; message: string } | null
  updatedAt?: number
  pairing?: DshHostPairing | null
}

class HostRequestError extends Error {
  readonly code: string
  constructor(code: string, message = '') { super(message); this.code = code }
}

type HostAction = 'register' | 'enable' | 'disable' | 'revoke' | 'reset' | 'pair' | 'pair-confirm' | 'pair-cancel'
async function queryLocalHost(action?: HostAction, code?: string): Promise<DshHostStatus> {
  const response = await invoke<{ status?: DshHostStatus; error?: { code: string; message?: string } }>('dsh_remote_host_manage', {
    envVars: serviceStore.envVarsRecord, action, code,
  })
  if (!response.status) throw new HostRequestError(response.error?.code ?? 'DSH_UNAVAILABLE', response.error?.message)
  return response.status
}

type DshHostState = 'loading' | 'unavailable' | DshHostStatus['state']

/** 本机在 DS 远程里的绑定状态。通道条和面板共用同一份，所以放在页面这一层。 */
export function useDshHost(enabled: boolean) {
  const [status, setStatus] = useState<DshHostStatus>()
  const [unreachable, setUnreachable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)
  const pairingState = status?.pairing?.state
  const pairingActive = pairingState === 'created' || pairingState === 'claimed' || pairingState === 'approved'

  useEffect(() => {
    if (!enabled) return
    let stop = false
    let polling = false
    const load = async () => {
      if (polling || document.visibilityState === 'hidden') return
      polling = true
      try {
        const next = await queryLocalHost()
        if (!stop) { setStatus(next); setUnreachable(false) }
      } catch (error) {
        if (!stop) {
          setStatus(error instanceof HostRequestError && error.code === 'DSH_LOOPBACK_REQUIRED'
            ? { available: false, reason: 'loopback', enabled: false, registered: false, deviceId: null, state: 'unregistered' } : undefined)
          setUnreachable(true)
        }
      }
      finally { polling = false }
    }
    void load()
    const timer = setInterval(load, pairingActive ? PAIRING_POLL_MS : HOST_POLL_MS)
    return () => { stop = true; clearInterval(timer) }
  }, [enabled, pairingActive])

  /** 成功返回 true；失败原因留在 failure 里。 */
  const manage = async (action: HostAction, code?: string): Promise<boolean> => {
    setBusy(true)
    setFailure(null)
    try {
      setStatus(await queryLocalHost(action, action === 'register' || action === 'pair-confirm' ? code?.trim() : undefined))
      return true
    } catch (error) {
      setFailure(error instanceof HostRequestError ? { code: error.code, message: error.message } : { code: '', message: '' })
      return false
    } finally { setBusy(false) }
  }

  const unreadable = status?.lastError?.code === 'DSH_STATE_UNREADABLE'
  const state: DshHostState = unreadable ? 'error'
    : !status ? (unreachable ? 'unavailable' : 'loading')
    : !status.available ? 'unavailable'
    : !status.registered ? 'unregistered'
    : status.state === 'stopped' && !status.enabled ? 'disabled' : status.state
  const tone: LampTone = state === 'online' ? 'on' : state === 'connecting' || state === 'loading' ? 'busy' : state === 'error' ? 'warn' : 'off'
  return { status, unreachable, unreadable, state, tone, busy, failure, manage }
}

export type DshHost = ReturnType<typeof useDshHost>
