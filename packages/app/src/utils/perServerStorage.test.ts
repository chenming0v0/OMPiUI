import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingKeys = [
  'ompiui-last-directory',
  'ompiui-saved-directories',
  'ompiui-recent-projects',
  'ompiui-path-mode',
  'ompiui-detected-path-style',
  'ompiui-selected-project-id',
  'ompiui-hidden-model-keys',
  'ompiui-pinned-sessions',
  'ompiui-model-usage-stats',
  'ompiui-model-variant-prefs',
  'ompiui-model-pinned',
  'ompiui-session-model-selection',
  'ompiui-preferred-model-key',
  'ompiui-terminal-shell',
  'ompiui-remote-tab',
]

const unrelatedKeys = [
  'unrelated',
  'ompiui-auth-token',
  'srv:local:auth-token',
  'srv:local:ompiui-auth-token',
  'srv:local:other-app-setting',
  'srv::ompiui-last-directory',
  'srv:local:',
  'srv:local',
  'srv:local:extra:ompiui-last-directory',
  'srv:local:ompiui-last-directory:extra',
  'srv: :ompiui-last-directory',
  'other:srv:local:ompiui-last-directory',
  '__proto__',
]

describe('perServerStorage backup', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('exports the settings written by serverStorage, plus existing legacy entries', async () => {
    const { serverStorage, exportPerServerStorageBackup } = await import('./perServerStorage')
    const expected: Record<string, string> = { 'ompiui-srv:local:last-directory': '/legacy' }
    localStorage.setItem('ompiui-srv:local:last-directory', '/legacy')
    for (const key of settingKeys) {
      serverStorage.set(key, `value:${key}`)
      expected[`srv:local:${key}`] = `value:${key}`
    }
    for (const key of unrelatedKeys) localStorage.setItem(key, 'private')

    expect(exportPerServerStorageBackup()).toEqual({ entries: expected })
  })

  it('replaces only supported keys across both namespaces, ignoring malformed keys and non-string values', async () => {
    const { importPerServerStorageBackup, exportPerServerStorageBackup } = await import('./perServerStorage')
    localStorage.setItem('srv:local:ompiui-last-directory', '/stale')
    localStorage.setItem('srv:removed-server:ompiui-model-pinned', '[]')
    localStorage.setItem('ompiui-srv:local:last-directory', '/stale-legacy')
    for (const key of unrelatedKeys) localStorage.setItem(key, 'keep')

    const entries = Object.fromEntries(unrelatedKeys.map(key => [key, 'injected']))
    importPerServerStorageBackup({ entries: {
      ...entries,
      'srv:remote:ompiui-last-directory': '/restored',
      'srv:local:ompiui-terminal-shell': '',
      'ompiui-srv:remote:last-directory': '/legacy',
      'srv:local:ompiui-hidden-model-keys': ['not-a-string'],
      'srv:local:ompiui-model-pinned': null,
      'srv:local:ompiui-path-mode': 42,
      'ompiui-srv:local:auto-approve-enabled': true,
    } })

    expect(exportPerServerStorageBackup()).toEqual({ entries: {
      'srv:remote:ompiui-last-directory': '/restored',
      'srv:local:ompiui-terminal-shell': '',
      'ompiui-srv:remote:last-directory': '/legacy',
    } })
    expect(localStorage.getItem('srv:local:ompiui-last-directory')).toBeNull()
    expect(localStorage.getItem('srv:removed-server:ompiui-model-pinned')).toBeNull()
    expect(localStorage.getItem('ompiui-srv:local:last-directory')).toBeNull()
    for (const key of unrelatedKeys) expect(localStorage.getItem(key)).toBe('keep')
  })

  it.each([null, undefined, 'invalid', [], {}, { entries: null }, { entries: [] }, { entries: 42 }].map(raw => [raw]))(
    'treats malformed module %j as an empty snapshot without importing arbitrary keys',
    async raw => {
      const { importPerServerStorageBackup } = await import('./perServerStorage')
      localStorage.setItem('srv:local:ompiui-last-directory', '/stale')
      localStorage.setItem('ompiui-srv:local:last-directory', '/stale-legacy')
      localStorage.setItem('auth-token', 'keep')

      expect(() => importPerServerStorageBackup(raw)).not.toThrow()

      expect(localStorage.getItem('srv:local:ompiui-last-directory')).toBeNull()
      expect(localStorage.getItem('ompiui-srv:local:last-directory')).toBeNull()
      expect(localStorage.getItem('auth-token')).toBe('keep')
    },
  )
})
