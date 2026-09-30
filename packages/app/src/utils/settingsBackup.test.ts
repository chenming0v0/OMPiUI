import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('settingsBackup', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.resetModules()
  })

  it('exports settings as module snapshots', async () => {
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

  it('restores settings from module snapshots', async () => {
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

})
