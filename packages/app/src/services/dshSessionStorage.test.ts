import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DSH_REMOTE_ORIGIN, encodeDshBase64 } from '@ompiui/protocol/dsh-remote'
import { clearDshSession, hasSavedDshSession, loadDshSession, saveDshSession, type DshSessionRecord } from './dshSessionStorage'

const NOW = 1_800_000_000_000
const SESSION_KEY = `ompiui.dsh-remote.session:${DSH_REMOTE_ORIGIN}`
const LEGACY_PAIRED_KEY = 'ompiui.dsh-remote.paired'
let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function session(mode: DshSessionRecord['mode'] = 'account'): DshSessionRecord {
  return {
    identity: {
      deviceId: '3f2a6c1e-8b4d-4f7a-9c2e-1d5b7a9c0e11',
      identityKey: encodeDshBase64(new Uint8Array(32).fill(1)),
      privateKey: encodeDshBase64(new Uint8Array(32).fill(2)),
    },
    tokens: {
      accessToken: 'test-access-token-0001', accessTokenExpiresAt: NOW + 3_600_000,
      refreshToken: 'test-refresh-token-0001', refreshTokenExpiresAt: NOW + 86_400_000,
    },
    mode,
  }
}

function storeLegacy(record = session('paired')): string {
  const raw = JSON.stringify({ identity: record.identity, tokens: record.tokens })
  storage.setItem(LEGACY_PAIRED_KEY, raw)
  return raw
}

beforeEach(() => {
  const values = new Map<string, string>()
  storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
  vi.stubGlobal('localStorage', storage)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DS Remote session persistence', () => {
  it.each(['account', 'paired'] as const)('saves and restores %s credentials with their explicit mode', mode => {
    const record = session(mode)
    expect(hasSavedDshSession()).toBe(false)
    saveDshSession(record)

    expect(JSON.parse(storage.getItem(SESSION_KEY)!)).toEqual({ origin: DSH_REMOTE_ORIGIN, ...record })
    expect(hasSavedDshSession()).toBe(true)
    expect(loadDshSession()).toEqual(record)
  })

  it('restores an expired access token while the refresh token is usable', () => {
    const record = session()
    record.tokens.accessTokenExpiresAt = NOW - 1
    saveDshSession(record)
    expect(loadDshSession()).toEqual(record)
    expect(hasSavedDshSession()).toBe(true)
  })

  it('replaces rotated tokens without changing the device identity or account mode', () => {
    const record = session()
    saveDshSession(record)
    const rotated = { ...record, tokens: { ...record.tokens, accessToken: 'test-access-token-0002', refreshToken: 'test-refresh-token-0002' } }
    saveDshSession(rotated)
    expect(loadDshSession()).toEqual(rotated)
  })

  it('migrates the legacy pairing only when loading and preserves paired mode', () => {
    const record = session('paired')
    const raw = storeLegacy(record)
    expect(hasSavedDshSession()).toBe(true)
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBe(raw)
    expect(storage.getItem(SESSION_KEY)).toBeNull()

    expect(loadDshSession()).toEqual(record)
    expect(JSON.parse(storage.getItem(SESSION_KEY)!)).toEqual({ origin: DSH_REMOTE_ORIGIN, ...record })
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBeNull()
  })

  it('keeps the current account session ahead of a leftover pairing and clears both when it expires', () => {
    const record = session()
    saveDshSession(record)
    storeLegacy({ ...session('paired'), tokens: { ...record.tokens, refreshTokenExpiresAt: NOW + 172_800_000 } })
    expect(loadDshSession()).toEqual(record)

    vi.mocked(Date.now).mockReturnValue(record.tokens.refreshTokenExpiresAt)
    expect(hasSavedDshSession()).toBe(false)
    expect(loadDshSession()).toBeNull()
    expect(storage.getItem(SESSION_KEY)).toBeNull()
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBeNull()
  })

  it('keeps credentials for other remote origins isolated during load, save and clear', () => {
    const otherKey = 'ompiui.dsh-remote.session:https://other.example'
    const raw = JSON.stringify({ origin: 'https://other.example', ...session() })
    storage.setItem(otherKey, raw)
    expect(hasSavedDshSession()).toBe(false)
    expect(loadDshSession()).toBeNull()
    saveDshSession(session())
    clearDshSession()
    expect(storage.getItem(otherKey)).toBe(raw)
  })
})

describe('DS Remote saved credential validation', () => {
  const invalidRecords: Array<[string, (record: DshSessionRecord) => Record<string, unknown>]> = [
    ['device ID', record => ({ ...record, identity: { ...record.identity, deviceId: 'invalid-device' } })],
    ['short public key', record => ({ ...record, identity: { ...record.identity, identityKey: encodeDshBase64(new Uint8Array(31)) } })],
    ['short private key', record => ({ ...record, identity: { ...record.identity, privateKey: encodeDshBase64(new Uint8Array(31)) } })],
    ['long private key', record => ({ ...record, identity: { ...record.identity, privateKey: encodeDshBase64(new Uint8Array(33)) } })],
    ['invalid key encoding', record => ({ ...record, identity: { ...record.identity, identityKey: '!'.repeat(43) } })],
    ['missing identity', record => ({ ...record, identity: null })],
    ['missing tokens', record => ({ ...record, tokens: null })],
    ['invalid access token', record => ({ ...record, tokens: { ...record.tokens, accessToken: '' } })],
    ['invalid refresh token', record => ({ ...record, tokens: { ...record.tokens, refreshToken: '' } })],
    ['invalid expiry', record => ({ ...record, tokens: { ...record.tokens, accessTokenExpiresAt: 'tomorrow' } })],
    ['invalid refresh expiry', record => ({ ...record, tokens: { ...record.tokens, refreshTokenExpiresAt: 'tomorrow' } })],
    ['expired refresh token', record => ({ ...record, tokens: { ...record.tokens, refreshTokenExpiresAt: NOW } })],
    ['unknown mode', record => ({ ...record, mode: 'oauth' })],
    ['missing mode', record => ({ identity: record.identity, tokens: record.tokens })],
    ['wrong origin', record => ({ ...record, origin: 'https://other.example' })],
  ]

  it.each(invalidRecords)('rejects and removes a saved session with %s', (_name, corrupt) => {
    const record = corrupt(session())
    storage.setItem(SESSION_KEY, JSON.stringify({ origin: DSH_REMOTE_ORIGIN, ...record }))
    expect(hasSavedDshSession()).toBe(false)
    expect(storage.getItem(SESSION_KEY)).not.toBeNull()
    expect(loadDshSession()).toBeNull()
    expect(storage.getItem(SESSION_KEY)).toBeNull()
  })

  it.each([SESSION_KEY, LEGACY_PAIRED_KEY])('cleans up malformed JSON at %s', key => {
    storage.setItem(key, '{broken')
    expect(hasSavedDshSession()).toBe(false)
    expect(loadDshSession()).toBeNull()
    expect(storage.getItem(key)).toBeNull()
  })

  it('removes expired legacy credentials without migrating them', () => {
    const record = session('paired')
    record.tokens.refreshTokenExpiresAt = NOW - 1
    storeLegacy(record)
    expect(loadDshSession()).toBeNull()
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBeNull()
    expect(storage.getItem(SESSION_KEY)).toBeNull()
  })

  it.each(['account', 'unknown'])('does not reinterpret legacy mode %s as a pairing', mode => {
    storage.setItem(LEGACY_PAIRED_KEY, JSON.stringify({ ...session(), mode }))
    expect(loadDshSession()).toBeNull()
    expect(storage.getItem(SESSION_KEY)).toBeNull()
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBeNull()
  })

  it('rejects invalid saves before replacing an existing authorization', () => {
    const record = session('paired')
    saveDshSession(record)
    const raw = storage.getItem(SESSION_KEY)
    expect(() => saveDshSession({ ...session(), mode: 'unknown' } as unknown as DshSessionRecord)).toThrow()
    expect(storage.getItem(SESSION_KEY)).toBe(raw)
    expect(loadDshSession()).toEqual(record)
  })
})

describe('DS Remote storage failures and cleanup', () => {
  it('throws on migration write failure, retaining the legacy record for a later retry', () => {
    const raw = storeLegacy()
    const failure = new DOMException('Storage full', 'QuotaExceededError')
    const write = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw failure })

    expect(() => loadDshSession()).toThrow(failure)
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBe(raw)
    expect(storage.getItem(SESSION_KEY)).toBeNull()
    expect(hasSavedDshSession()).toBe(true)

    write.mockRestore()
    expect(loadDshSession()).toEqual(session('paired'))
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBeNull()
  })

  it('preserves both old records when saving new credentials fails', () => {
    saveDshSession(session())
    const current = storage.getItem(SESSION_KEY)
    const legacy = storeLegacy()
    const failure = new DOMException('Storage full', 'QuotaExceededError')
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw failure })

    expect(() => saveDshSession(session('paired'))).toThrow(failure)
    expect(storage.getItem(SESSION_KEY)).toBe(current)
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBe(legacy)
  })

  it('reports failed legacy removal after migration while retaining both credential copies', () => {
    const raw = storeLegacy()
    const failure = new DOMException('Storage unavailable', 'SecurityError')
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw failure })

    expect(() => loadDshSession()).toThrow(failure)
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBe(raw)
    expect(JSON.parse(storage.getItem(SESSION_KEY)!)).toEqual({ origin: DSH_REMOTE_ORIGIN, ...session('paired') })
  })

  it('does not delete credentials when storage cannot be read', () => {
    const raw = storeLegacy()
    const failure = new DOMException('Storage unavailable', 'SecurityError')
    const read = vi.spyOn(storage, 'getItem').mockImplementation(() => { throw failure })
    const remove = vi.spyOn(storage, 'removeItem')

    expect(() => loadDshSession()).toThrow(failure)
    expect(hasSavedDshSession()).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    read.mockRestore()
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBe(raw)
  })

  it('clears both session formats while leaving other application storage intact', () => {
    saveDshSession(session())
    storeLegacy()
    storage.setItem('other-setting', 'kept')
    clearDshSession()
    expect(storage.getItem(SESSION_KEY)).toBeNull()
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBeNull()
    expect(storage.getItem('other-setting')).toBe('kept')
    expect(hasSavedDshSession()).toBe(false)
    expect(loadDshSession()).toBeNull()
  })

  it('reports cleanup failure without removing the current session ahead of the legacy record', () => {
    saveDshSession(session())
    const current = storage.getItem(SESSION_KEY)
    const legacy = storeLegacy()
    const failure = new DOMException('Storage unavailable', 'SecurityError')
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw failure })

    expect(() => clearDshSession()).toThrow(failure)
    expect(storage.getItem(SESSION_KEY)).toBe(current)
    expect(storage.getItem(LEGACY_PAIRED_KEY)).toBe(legacy)
  })
})
