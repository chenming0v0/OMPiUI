import { applyLocalServerConfig } from '../store/serverStore'
import { serviceStore } from '../store/serviceStore'
import { desktopDiagnosticsStore, type DesktopServiceDiagnostics } from '../store/desktopDiagnosticsStore'

export interface DesktopServiceStatus {
  running: boolean
  startedByUs: boolean
  pid?: number | null
  url?: string | null
  environment: Record<string, string>
}

export interface DesktopServiceStartResult {
  started: boolean
  startedByUs: boolean
  url?: string | null
  token?: string | null
}

export interface DesktopServiceStartOutcome {
  result: DesktopServiceStartResult
  status: DesktopServiceStatus
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

let invokePromise: Promise<Invoke> | null = null
let pendingOperations = 0

async function getInvoke(): Promise<Invoke> {
  invokePromise ??= import('@tauri-apps/api/core').then(module => module.invoke as Invoke)
  return invokePromise
}

function environmentArgs(): { envVars: Record<string, string> } {
  return { envVars: serviceStore.envVarsRecord }
}

function applyStatus(status: DesktopServiceStatus): DesktopServiceStatus {
  serviceStore.setRunning(status.running)
  serviceStore.setStartedByUs(status.startedByUs)
  return status
}

async function withOperation<T>(operation: () => Promise<T>): Promise<T> {
  pendingOperations += 1
  serviceStore.setStarting(true)
  try {
    const result = await operation()
    desktopDiagnosticsStore.finish()
    return result
  } catch (error) {
    desktopDiagnosticsStore.finish(error)
    throw error
  } finally {
    pendingOperations -= 1
    serviceStore.setStarting(pendingOperations > 0)
  }
}

export async function refreshDesktopServiceStatus(): Promise<DesktopServiceStatus> {
  const invoke = await getInvoke()
  return applyStatus(await invoke<DesktopServiceStatus>('get_ompiui_service_status', environmentArgs()))
}

export async function readDesktopServiceDiagnostics(): Promise<DesktopServiceDiagnostics> {
  const invoke = await getInvoke()
  return invoke<DesktopServiceDiagnostics>('get_ompiui_service_diagnostics', environmentArgs())
}

async function startOrRestartDesktopService(
  command: 'start_ompiui_service' | 'restart_ompiui_service',
): Promise<DesktopServiceStartOutcome> {
  return withOperation(async () => {
    desktopDiagnosticsStore.begin('preparing')
    const invoke = await getInvoke()
    const result = await invoke<DesktopServiceStartResult>(command, environmentArgs())
    if (!result.url || !result.token) {
      throw new Error('OMPiUI server did not return a usable URL and auth token')
    }
    applyLocalServerConfig(result.url, result.token)
    serviceStore.setRunning(true)
    serviceStore.setStartedByUs(result.startedByUs)
    return { result, status: await refreshDesktopServiceStatus() }
  })
}

export function startDesktopService(): Promise<DesktopServiceStartOutcome> {
  return startOrRestartDesktopService('start_ompiui_service')
}

export function restartDesktopService(): Promise<DesktopServiceStartOutcome> {
  return startOrRestartDesktopService('restart_ompiui_service')
}

export function stopDesktopService(): Promise<DesktopServiceStatus> {
  return withOperation(async () => {
    desktopDiagnosticsStore.begin('stopping')
    const invoke = await getInvoke()
    await invoke('stop_ompiui_service')
    serviceStore.setRunning(false)
    serviceStore.setStartedByUs(false)
    return refreshDesktopServiceStatus()
  })
}
