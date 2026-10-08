import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsBackupFile } from './settingsBackup'

describe('settingsBackup', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.resetModules()
  })

  it('exports settings as module snapshots including legacy per-server entries', async () => {
    localStorage.setItem('ompiui-theme-preset', 'claude')
    localStorage.setItem('ompiui-theme-mode', 'dark')
    localStorage.setItem('ompiui-sidebar-expanded', 'false')
    localStorage.setItem('ompiui-right-panel-width', '512')
    localStorage.setItem('ompiui-notifications-enabled', 'true')
    localStorage.setItem('ompiui:toast-enabled', 'false')
    localStorage.setItem('ompiui-srv:local:last-directory', '/workspace/project')
    localStorage.setItem('ompiui-srv:local:auto-approve-enabled', 'true')
    localStorage.setItem('ompiui-service-env-vars', JSON.stringify([{ key: 'OMPIUI_USE_SYSTEM_PI', value: '1' }]))

    const { exportSettingsBackup } = await import('./settingsBackup')
    const { data } = await exportSettingsBackup()
    const backup = JSON.parse(new TextDecoder().decode(data)) as {
      schemaVersion: number
      modules: Record<string, unknown>
    }

    expect(backup.schemaVersion).toBe(4)
    expect((backup.modules.theme as { presetId: string }).presetId).toBe('claude')
    expect((backup.modules.layout as { rightPanelWidth: number }).rightPanelWidth).toBe(512)
    expect((backup.modules.notifications as { browserNotificationsEnabled: boolean }).browserNotificationsEnabled).toBe(
      true,
    )
    expect(
      (backup.modules.perServerStorage as { entries: Record<string, string> }).entries['ompiui-srv:local:last-directory'],
    ).toBe('/workspace/project')
    expect((backup.modules.service as { envVars: Array<{ key: string }> }).envVars[0]?.key).toBe('OMPIUI_USE_SYSTEM_PI')
  })

  it('restores settings from legacy module snapshots', async () => {
    localStorage.setItem('ompiui-theme-preset', 'claude')
    localStorage.setItem('ompiui-theme-mode', 'dark')
    localStorage.setItem('ompiui-sidebar-expanded', 'false')
    localStorage.setItem('ompiui-right-panel-width', '512')
    localStorage.setItem('ompiui-notifications-enabled', 'true')
    localStorage.setItem('ompiui:toast-enabled', 'false')
    localStorage.setItem('ompiui-srv:local:last-directory', '/workspace/project')
    localStorage.setItem('ompiui-srv:local:auto-approve-enabled', 'true')
    localStorage.setItem(
      'ompiui-service-env-vars',
      JSON.stringify([{ key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' }]),
    )

    const { exportSettingsBackup, importSettingsBackup } = await import('./settingsBackup')
    const { data, fileName } = await exportSettingsBackup()
    const file = new File([new TextDecoder().decode(data)], fileName, {
      type: 'application/json',
    })

    localStorage.clear()
    sessionStorage.clear()

    await importSettingsBackup(file)

    expect(localStorage.getItem('ompiui-theme-preset')).toBe('claude')
    expect(localStorage.getItem('ompiui-theme-mode')).toBe('dark')
    expect(localStorage.getItem('ompiui-sidebar-expanded')).toBe('false')
    expect(localStorage.getItem('ompiui-right-panel-width')).toBe('512')
    expect(localStorage.getItem('ompiui-notifications-enabled')).toBe('true')
    expect(localStorage.getItem('ompiui-srv:local:last-directory')).toBe('/workspace/project')
    expect(localStorage.getItem('ompiui-srv:local:auto-approve-enabled')).toBe('true')
    expect(localStorage.getItem('ompiui:toast-enabled')).toBe('false')
    expect(localStorage.getItem('ompiui-service-env-vars')).toBe(
      JSON.stringify([{ key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' }]),
    )
    expect(sessionStorage.getItem('ompiui-active-server')).toBe('local')
  })

  it('roundtrips real per-server stores across export, clear, import and reload', async () => {
    const { serverStore } = await import('../store/serverStore')
    const { serverStorage } = await import('./perServerStorage')
    const { modelVisibilityStore } = await import('../store/modelVisibilityStore')
    const { pinnedSessionsStore } = await import('../store/pinnedSessionsStore')
    const { setPreferredModelKey } = await import('./modelUtils')
    const remote = serverStore.addServer({ name: 'Remote', url: 'https://remote.test', isDefault: false })
    const fixtures = [
      { id: 'local', directory: '/local/project', model: 'local/model' },
      { id: remote.id, directory: 'D:\\remote\\project', model: 'remote/model' },
    ]

    for (const fixture of fixtures) {
      serverStore.setActiveServer(fixture.id)
      serverStorage.set('ompiui-last-directory', fixture.directory)
      serverStorage.setJSON('ompiui-saved-directories', [fixture.directory])
      setPreferredModelKey(fixture.model)
      modelVisibilityStore.setVisible(fixture.model, false)
      pinnedSessionsStore.pin({ sessionId: 'same-session', directory: fixture.directory, title: fixture.id })
    }

    const serversBefore = serverStore.getStoredServers()
    const { exportSettingsBackup, importSettingsBackup } = await import('./settingsBackup')
    const { data, fileName } = await exportSettingsBackup()
    const text = new TextDecoder().decode(data)
    const backup = JSON.parse(text) as SettingsBackupFile
    expect(Object.keys(backup.modules.perServerStorage.entries)).toHaveLength(10)
    for (const fixture of fixtures) {
      expect(backup.modules.perServerStorage.entries[`srv:${fixture.id}:ompiui-last-directory`]).toBe(fixture.directory)
    }

    localStorage.clear()
    sessionStorage.clear()
    await importSettingsBackup(new File([text], fileName, { type: 'application/json' }))
    vi.resetModules()

    const { serverStore: restoredServers } = await import('../store/serverStore')
    const { serverStorage: restoredStorage } = await import('./perServerStorage')
    const { modelVisibilityStore: restoredModels } = await import('../store/modelVisibilityStore')
    const { pinnedSessionsStore: restoredPins } = await import('../store/pinnedSessionsStore')
    const { getPreferredModelKey } = await import('./modelUtils')
    expect(restoredServers.getStoredServers()).toEqual(serversBefore)
    expect(restoredServers.getActiveServerId()).toBe(remote.id)

    for (const fixture of fixtures) {
      restoredServers.setActiveServer(fixture.id)
      expect(restoredStorage.get('ompiui-last-directory')).toBe(fixture.directory)
      expect(restoredStorage.getJSON('ompiui-saved-directories')).toEqual([fixture.directory])
      expect(getPreferredModelKey()).toBe(fixture.model)
      expect(restoredModels.getSnapshot()).toEqual([fixture.model])
      expect(restoredPins.getSnapshot()).toEqual([
        { sessionId: 'same-session', directory: fixture.directory, title: fixture.id },
      ])
    }
  })

  it('still accepts the PiUI app name in schema 4 backups', async () => {
    const { exportSettingsBackup, importSettingsBackup } = await import('./settingsBackup')
    const { data } = await exportSettingsBackup()
    const backup = JSON.parse(new TextDecoder().decode(data))
    backup.app = 'PiUI'
    backup.modules.perServerStorage.entries = { 'ompiui-srv:local:last-directory': '/legacy' }

    await importSettingsBackup(new File([JSON.stringify(backup)], 'legacy.json'))

    expect(localStorage.getItem('ompiui-srv:local:last-directory')).toBe('/legacy')
  })

  it('does not expand the existing credential export policy to arbitrary storage', async () => {
    const { serverStore } = await import('../store/serverStore')
    serverStore.updateServer('local', { token: 'configured-server-token' })
    localStorage.setItem('ompiui-service-env-vars', JSON.stringify([{ key: 'EXISTING_SECRET', value: 'configured-env' }]))
    const excluded = ['auth-token', 'other-app:key', 'srv:local:auth-token', 'srv:local:ompiui-auth-token']
    for (const key of excluded) localStorage.setItem(key, 'unrelated-secret')

    const { exportSettingsBackup } = await import('./settingsBackup')
    const { data } = await exportSettingsBackup()
    const text = new TextDecoder().decode(data)
    const backup = JSON.parse(text) as SettingsBackupFile
    expect(backup.modules.servers.servers[0].token).toBe('configured-server-token')
    expect(backup.modules.service.envVars).toContainEqual({ key: 'EXISTING_SECRET', value: 'configured-env' })
    expect(text).not.toContain('unrelated-secret')
  })

  it.each([
    ['invalid JSON', '{', 'Invalid backup file'],
    ['non-object', 'null', 'Invalid backup file'],
    ['wrong app', JSON.stringify({ app: 'Other', kind: 'settings-backup', schemaVersion: 4 }), 'Unsupported backup format'],
    ['wrong schema', JSON.stringify({ app: 'OMPiUI', kind: 'settings-backup', schemaVersion: 3 }), 'Unsupported backup format'],
    ['missing modules', JSON.stringify({ app: 'OMPiUI', kind: 'settings-backup', schemaVersion: 4 }), 'Missing backup modules'],
    ['missing module', JSON.stringify({ app: 'OMPiUI', kind: 'settings-backup', schemaVersion: 4, modules: {} }), 'Missing backup module: theme'],
  ])('rejects %s without mutating storage', async (_name, text, error) => {
    const { importSettingsBackup } = await import('./settingsBackup')
    localStorage.setItem('srv:local:ompiui-last-directory', '/keep')

    await expect(importSettingsBackup(new File([text], 'invalid.json'))).rejects.toThrow(error)

    expect(localStorage.getItem('srv:local:ompiui-last-directory')).toBe('/keep')
  })
})
