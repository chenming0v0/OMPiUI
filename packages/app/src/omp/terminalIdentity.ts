import { getApiBase } from './httpClient'

export const TERMINAL_SECRET_HEADER = 'x-ompiui-terminal-secret'
const STORAGE_PREFIX = 'ompiui:private-terminal:v1:'

/** One private principal per browser profile and effective backend, not host token/clientId. */
export function getTerminalSecret(): string {
  const backend = new URL(getApiBase() || window.location.origin, window.location.origin).toString().replace(/\/$/, '')
  const key = `${STORAGE_PREFIX}${backend}`
  // Fail closed when durable storage is unavailable. An ephemeral fallback would
  // strand the user's live shells on refresh and silently change their identity.
  const existing = window.localStorage.getItem(key)
  if (existing !== null) {
    if (!/^[a-f0-9]{64}$/.test(existing)) throw new Error('Private terminal credential is invalid; it was not replaced')
    return existing
  }
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  const secret = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  window.localStorage.setItem(key, secret)
  return secret
}

/** Chat/events remain available when durable private terminal storage is blocked. */
export function getOptionalTerminalSecret(): string | undefined {
  try { return getTerminalSecret() } catch { return undefined }
}
