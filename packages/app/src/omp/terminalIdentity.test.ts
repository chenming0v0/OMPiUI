import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({ base: 'https://backend-a.test' }))
vi.mock('./httpClient', () => ({ getApiBase: () => backend.base }))
import { getOptionalTerminalSecret, getTerminalSecret } from './terminalIdentity'

describe('durable private terminal identity', () => {
  beforeEach(() => {
    window.localStorage.clear()
    backend.base = 'https://backend-a.test'
    let next = 1
    vi.spyOn(window.crypto, 'getRandomValues').mockImplementation(array => {
      const bytes = array as Uint8Array
      bytes.fill(next++)
      return array
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('preserves the creator secret through module reload/refresh and reconnect', async () => {
    const secret = getTerminalSecret()
    expect(secret).toBe('01'.repeat(32))
    expect(getTerminalSecret()).toBe(secret)
    vi.resetModules()
    const refreshed = await import('./terminalIdentity')
    expect(refreshed.getTerminalSecret()).toBe(secret)
    expect(window.crypto.getRandomValues).toHaveBeenCalledTimes(1)
  })

  it('assigns independent browser clients independent secrets even on the same backend', () => {
    const clientA = getTerminalSecret()
    const savedA = Array.from({ length: window.localStorage.length }, (_, index) => {
      const key = window.localStorage.key(index)!
      return [key, window.localStorage.getItem(key)!] as const
    })
    window.localStorage.clear()
    const clientB = getTerminalSecret()
    expect(clientA).not.toBe(clientB)
    expect(clientB).toBe('02'.repeat(32))
    window.localStorage.clear()
    savedA.forEach(([key, value]) => window.localStorage.setItem(key, value))
    expect(getTerminalSecret()).toBe(clientA)
  })

  it('scopes private secrets to the effective backend and returns to the original identity', () => {
    const first = getTerminalSecret()
    backend.base = 'https://backend-b.test'
    expect(getTerminalSecret()).not.toBe(first)
    backend.base = 'https://backend-a.test/'
    expect(getTerminalSecret()).toBe(first)
  })

  it.each(['read', 'write'])('fails private access closed when durable storage %s is unavailable without blocking chat subscription', operation => {
    vi.spyOn(Storage.prototype, operation === 'read' ? 'getItem' : 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    expect(() => getTerminalSecret()).toThrow('Blocked')
    expect(getOptionalTerminalSecret()).toBeUndefined()
  })

  it('does not replace a corrupt saved credential or silently take over a different identity', () => {
    const secret = getTerminalSecret()
    const key = window.localStorage.key(0)!
    window.localStorage.setItem(key, 'corrupt')
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    expect(() => getTerminalSecret()).toThrow('was not replaced')
    expect(getOptionalTerminalSecret()).toBeUndefined()
    expect(writes).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(key)).not.toBe(secret)
  })
})
