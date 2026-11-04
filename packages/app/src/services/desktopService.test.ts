import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyDesktopServiceStart,
  getDesktopRuntimeCatalog,
  getDesktopTraySettings,
  saveDesktopRuntimeSelection,
  setDesktopTraySettings,
  restartDesktopService,
  startDesktopService,
  stopDesktopService,
} from './desktopService'
import { desktopDiagnosticsStore } from '../store/desktopDiagnosticsStore'

const { invokeMock, applyLocalServerConfigMock, serviceStoreMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  applyLocalServerConfigMock: vi.fn(),
  serviceStoreMock: {
    envVarsRecord: { OMPI_OMP_BIN: '/opt/omp/bin/omp' },
    envVars: [
      { key: 'OMPI_OMP_BIN', value: '/opt/omp/bin/omp' },
      { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
    ],
    setEnvVars: vi.fn(),
    setRunning: vi.fn(),
    setStartedByUs: vi.fn(),
    setStarting: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../store/serverStore', () => ({ applyLocalServerConfig: applyLocalServerConfigMock }))
vi.mock('../store/serviceStore', () => ({ serviceStore: serviceStoreMock }))

const runningStatus = {
  running: true,
  startedByUs: true,
  pid: 42,
  url: 'http://127.0.0.1:8787',
  environment: { OMPI_OMP_BIN: '/opt/omp/bin/omp' },
}

describe('desktopService', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    applyLocalServerConfigMock.mockReset()
    serviceStoreMock.setRunning.mockReset()
    serviceStoreMock.setStartedByUs.mockReset()
    serviceStoreMock.setStarting.mockReset()
    serviceStoreMock.setEnvVars.mockReset()
  })

  it('queries runtime installations with the configured startup environment without starting a service', async () => {
    invokeMock.mockResolvedValue({ available: {}, current: null })
    await getDesktopRuntimeCatalog()
    expect(invokeMock).toHaveBeenCalledWith('get_ompiui_runtime_catalog', { envVars: serviceStoreMock.envVarsRecord })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('verifies and persists a complete runtime choice before changing local settings, without restarting', async () => {
    invokeMock
      .mockResolvedValueOnce({ available: { selected: { version: '18.12.6', error: null }, error: null } })
      .mockResolvedValueOnce({ supported: true, loginStart: true, crashRecovery: false })
      .mockResolvedValueOnce({ supported: true })
    await saveDesktopRuntimeSelection('/new/omp-runtime/bin/omp', '/new/omp-runtime')
    const environment = {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      OMPI_OMP_BIN: '/new/omp-runtime/bin/omp',
      OMPI_OMP_RUNTIME_DIR: '/new/omp-runtime',
      OMPI_OMP_PACKAGE_ROOT: '',
      OMPI_BUN_BIN: '',
    }
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_ompiui_runtime_catalog', { envVars: environment })
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'set_ompiui_background_settings', {
      loginStart: true,
      crashRecovery: false,
      envVars: environment,
    })
    expect(serviceStoreMock.setEnvVars).toHaveBeenCalledWith(
      Object.entries(environment).map(([key, value]) => ({ key, value })),
    )
    expect(invokeMock.mock.calls.some(([command]) => /^(?:start|restart)_/.test(command))).toBe(false)
  })

  it.each(['verification', 'persistence'])('does not change local runtime selection after %s fails', async failure => {
    if (failure === 'verification')
      invokeMock.mockResolvedValueOnce({ available: { selected: null, error: 'Missing OMP' } })
    else
      invokeMock
        .mockResolvedValueOnce({ available: { selected: { version: '18.12.6', error: null }, error: null } })
        .mockResolvedValueOnce({ supported: true, loginStart: false, crashRecovery: true })
        .mockRejectedValueOnce(new Error('disk full'))
    await expect(saveDesktopRuntimeSelection('/new/omp')).rejects.toThrow(
      failure === 'verification' ? 'Missing OMP' : 'disk full',
    )
    expect(serviceStoreMock.setEnvVars).not.toHaveBeenCalled()
  })

  it('restores inherited runtime discovery without removing unrelated environment settings', async () => {
    invokeMock.mockResolvedValueOnce({ supported: false })
    await saveDesktopRuntimeSelection(null)
    expect(serviceStoreMock.setEnvVars).toHaveBeenCalledWith([{ key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' }])
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('reads and saves tray settings with the current desktop environment and language', async () => {
    invokeMock.mockResolvedValue({ supported: true, closeToTray: false })
    await expect(getDesktopTraySettings('zh-CN')).resolves.toEqual({ supported: true, closeToTray: false })
    expect(invokeMock).toHaveBeenLastCalledWith('get_ompiui_tray_settings', {
      envVars: serviceStoreMock.envVarsRecord,
      language: 'zh-CN',
    })
    invokeMock.mockResolvedValue({ supported: true, closeToTray: true })
    await expect(setDesktopTraySettings(true, 'en')).resolves.toEqual({ supported: true, closeToTray: true })
    expect(invokeMock).toHaveBeenLastCalledWith('set_ompiui_tray_settings', {
      closeToTray: true,
      envVars: serviceStoreMock.envVarsRecord,
      language: 'en',
    })
    invokeMock.mockRejectedValue(new Error('disk full'))
    await expect(setDesktopTraySettings(false, 'en')).rejects.toThrow('disk full')
  })

  it('applies credentials from a tray start without starting another service', () => {
    applyDesktopServiceStart({ started: true, startedByUs: true, url: runningStatus.url, token: 'tray-token' })
    expect(applyLocalServerConfigMock).toHaveBeenCalledWith(runningStatus.url, 'tray-token')
    expect(serviceStoreMock.setRunning).toHaveBeenCalledWith(true)
    expect(serviceStoreMock.setStartedByUs).toHaveBeenCalledWith(true)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('starts the service, applies credentials, and synchronizes status', async () => {
    invokeMock
      .mockResolvedValueOnce({
        started: true,
        startedByUs: true,
        url: 'http://127.0.0.1:8787',
        token: 'token',
      })
      .mockResolvedValueOnce(runningStatus)

    const outcome = await startDesktopService()

    expect(outcome.status).toEqual(runningStatus)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'start_ompiui_service', {
      envVars: { OMPI_OMP_BIN: '/opt/omp/bin/omp' },
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_ompiui_service_status', {
      envVars: { OMPI_OMP_BIN: '/opt/omp/bin/omp' },
    })
    expect(applyLocalServerConfigMock).toHaveBeenCalledWith('http://127.0.0.1:8787', 'token')
  })

  it('uses the same validation and state path for restart', async () => {
    invokeMock.mockResolvedValueOnce({ started: true, startedByUs: true, url: null, token: null })

    await expect(restartDesktopService()).rejects.toThrow(/usable URL and auth token/)
    expect(invokeMock).toHaveBeenCalledWith('restart_ompiui_service', {
      envVars: { OMPI_OMP_BIN: '/opt/omp/bin/omp' },
    })
    expect(applyLocalServerConfigMock).not.toHaveBeenCalled()
  })

  it('stops the service and refreshes the authoritative status', async () => {
    const stoppedStatus = { ...runningStatus, running: false, startedByUs: false, pid: null, url: null }
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(stoppedStatus)

    await expect(stopDesktopService()).resolves.toEqual(stoppedStatus)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'stop_ompiui_service')
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_ompiui_service_status', {
      envVars: { OMPI_OMP_BIN: '/opt/omp/bin/omp' },
    })
  })

  it('retains startup failures for the status panel and permits a successful retry', async () => {
    invokeMock.mockRejectedValueOnce('failed to spawn')
    await expect(startDesktopService()).rejects.toBe('failed to spawn')
    expect(desktopDiagnosticsStore.getSnapshot().commandError).toBe('failed to spawn')
    expect(desktopDiagnosticsStore.getSnapshot().operation).toBeNull()
    expect(serviceStoreMock.setStarting).toHaveBeenLastCalledWith(false)
    invokeMock
      .mockResolvedValueOnce({ started: true, startedByUs: true, url: runningStatus.url, token: 'token' })
      .mockResolvedValueOnce(runningStatus)
    await startDesktopService()
    expect(desktopDiagnosticsStore.getSnapshot().commandError).toBeNull()
  })
})
