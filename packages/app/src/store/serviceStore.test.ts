import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('serviceStore', () => {
  // Static imports would initialize the store before each test seeds its persisted settings.
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('keeps auto start enabled for a new OMPiUI install', async () => {
    const { serviceStore } = await import('./serviceStore')
    expect(serviceStore.autoStart).toBe(true)
  })

  it('cleans saved SDK settings while preserving the CLI and other environment variables', async () => {
    const retained = [
      { key: 'OMPI_OMP_BIN', value: 'C:/Program Files/omp/omp.exe' },
      { key: 'PI_CODING_AGENT_DIR', value: 'D:/omp/agent' },
      { key: 'PI_CODING_AGENT_SESSION_DIR', value: 'D:/omp/sessions' },
      { key: 'OMPIUI_OMP_SESSION_DIRS', value: 'D:/shared/sessions' },
      { key: 'PIUI_EMBEDDED', value: '1' },
      { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
      { key: 'CUSTOM_SDK_PATH', value: '/other/sdk' },
    ]
    localStorage.setItem('ompiui-service-env-vars', JSON.stringify([
      { key: 'OMPIUI_USE_SYSTEM_PI', value: '1' },
      { key: 'OMPIUI_SDK_PATH', value: '/old/pi-sdk' },
      { key: 'PIUI_USE_SYSTEM_PI', value: '1' },
      { key: 'PIUI_SDK_PATH', value: '/older/pi-sdk' },
      { key: ' piui_sdk_path ', value: '/padded/pi-sdk' },
      ...retained,
      { key: 'PIUI_HOST', value: '127.0.0.2' },
      { key: 'OMPIUI_HOST', value: '127.0.0.3' },
    ]))

    const { serviceStore } = await import('./serviceStore')
    const expected = [...retained, { key: 'OMPIUI_HOST', value: '127.0.0.2' }]

    expect(serviceStore.envVars).toEqual(expected)
    expect(JSON.parse(localStorage.getItem('ompiui-service-env-vars')!)).toEqual(expected)
  })

  it('does not import a retired SDK directory as an OMP executable', async () => {
    const { importServiceSettingsBackup, serviceStore } = await import('./serviceStore')

    importServiceSettingsBackup({
      autoStart: false,
      envVars: [
        { key: 'OMPIUI_USE_SYSTEM_PI', value: '1' },
        { key: 'OMPIUI_SDK_PATH', value: '/old/pi-sdk' },
        { key: 'PIUI_USE_SYSTEM_PI', value: '1' },
        { key: 'PIUI_SDK_PATH', value: '/older/pi-sdk' },
        { key: 'PI_CODING_AGENT_DIR', value: '/keep/agent' },
      ],
    })

    expect(serviceStore.autoStart).toBe(false)
    expect(serviceStore.envVarsRecord).toEqual({ PI_CODING_AGENT_DIR: '/keep/agent' })
    expect(JSON.parse(localStorage.getItem('ompiui-service-env-vars')!)).toEqual([
      { key: 'PI_CODING_AGENT_DIR', value: '/keep/agent' },
    ])
  })

  it('retains the usable CLI configuration when migration cannot update storage', async () => {
    localStorage.setItem('ompiui-service-env-vars', JSON.stringify([
      { key: 'OMPIUI_SDK_PATH', value: '/old/pi-sdk' },
      { key: 'OMPI_OMP_BIN', value: '/opt/omp/bin/omp' },
    ]))
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    })

    try {
      const { serviceStore } = await import('./serviceStore')
      expect(serviceStore.envVarsRecord).toEqual({ OMPI_OMP_BIN: '/opt/omp/bin/omp' })
    } finally {
      setItem.mockRestore()
    }
  })

  it('upserts example variables without creating duplicate keys', async () => {
    const { serviceStore } = await import('./serviceStore')

    serviceStore.setEnvVars([{ key: 'https_proxy', value: 'old' }])
    serviceStore.upsertEnvVar('HTTPS_PROXY', 'http://127.0.0.1:7890')

    expect(serviceStore.envVars).toEqual([{ key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' }])
  })
})
