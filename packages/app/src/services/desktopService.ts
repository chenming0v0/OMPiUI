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

export type DesktopBackgroundLifecycle = 'disabled' | 'running' | 'stopped' | 'update-paused' | 'recovering'

/** 原生层持久化的后台配置与状态;GUI 不以 localStorage 代表后台是否已生效。 */
export interface DesktopBackgroundStatus {
  supported: boolean
  loginStart: boolean
  crashRecovery: boolean
  lifecycle: DesktopBackgroundLifecycle
  pid: number | null
  lastError: string | null
}

export interface DesktopBackgroundSettingsInput {
  loginStart: boolean
  crashRecovery: boolean
}

/** 错误文本在显示前脱敏:令牌、密钥、Bearer、URL 查询参数与 Windows 用户目录名。 */
export function redactBackgroundError(message: string): string {
  return message
    .replace(/Bearer\s+[^\s'"]+/gi, 'Bearer ***')
    .replace(/((?:token|key|secret|password|credential)[\w-]*\s*[=:]\s*)[^\s'",;]+/gi, '$1***')
    .replace(/(https?:\/\/[^\s?#'"]+)\?[^\s'"]*/gi, '$1?***')
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s'"]+/gi, '$1***')
}

export async function getDesktopBackgroundStatus(): Promise<DesktopBackgroundStatus> {
  const invoke = await getInvoke()
  const status = await invoke<DesktopBackgroundStatus>('get_ompiui_background_status', environmentArgs())
  return { ...status, lastError: status.lastError ? redactBackgroundError(status.lastError) : null }
}

/**
 * 保存后台开关。调用方必须等待返回值才更新界面:只有原生层真实持久化成功后
 * 才会得到新的状态;失败时抛出错误,界面保持上一次已生效的配置。
 */
export async function setDesktopBackgroundSettings(
  settings: DesktopBackgroundSettingsInput,
): Promise<DesktopBackgroundStatus> {
  const invoke = await getInvoke()
  const status = await invoke<DesktopBackgroundStatus>('set_ompiui_background_settings', {
    loginStart: settings.loginStart,
    crashRecovery: settings.crashRecovery,
    ...environmentArgs(),
  })
  return { ...status, lastError: status.lastError ? redactBackgroundError(status.lastError) : null }
}

/** GUI 自动启动入口:尊重 native 持久化的用户停止与更新暂停,不把它们覆盖成运行中。 */
export async function startDesktopServiceIfAllowed(): Promise<DesktopServiceStartOutcome | null> {
  const background = await getDesktopBackgroundStatus().catch(() => null)
  if (background && (background.lifecycle === 'stopped' || background.lifecycle === 'update-paused')) return null
  return startDesktopService()
}
