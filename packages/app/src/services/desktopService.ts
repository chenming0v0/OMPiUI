import type { OmpRuntimeInspection } from '@ompiui/protocol'
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

export interface DesktopTraySettings {
  supported: boolean
  closeToTray: boolean
}

export async function getDesktopTraySettings(language: string): Promise<DesktopTraySettings> {
  const invoke = await getInvoke()
  return invoke<DesktopTraySettings>('get_ompiui_tray_settings', { ...environmentArgs(), language })
}

export async function setDesktopTraySettings(closeToTray: boolean, language: string): Promise<DesktopTraySettings> {
  const invoke = await getInvoke()
  return invoke<DesktopTraySettings>('set_ompiui_tray_settings', { closeToTray, ...environmentArgs(), language })
}

/** 托盘启动和 GUI 启动使用同一连接同步路径，不再次启动后端。 */
export function applyDesktopServiceStart(result: DesktopServiceStartResult): void {
  if (!result.url || !result.token) {
    throw new Error('OMPiUI server did not return a usable URL and auth token')
  }
  applyLocalServerConfig(result.url, result.token)
  serviceStore.setRunning(true)
  serviceStore.setStartedByUs(result.startedByUs)
}

export interface DesktopRuntimeCatalog {
  available: OmpRuntimeInspection
  current: OmpRuntimeInspection | null
  currentError?: string | null
}

/** 即使后端未启动也可只读检查安装，current 仅来自正在运行的后端。 */
export async function getDesktopRuntimeCatalog(): Promise<DesktopRuntimeCatalog> {
  const invoke = await getInvoke()
  return invoke<DesktopRuntimeCatalog>('get_ompiui_runtime_catalog', environmentArgs())
}

const runtimeEnvironmentKeys = new Set([
  'OMPI_OMP_BIN',
  'OMPI_OMP_RUNTIME_DIR',
  'OMPI_OMP_PACKAGE_ROOT',
  'OMPI_BUN_BIN',
])

/**
 * 保存配套启动环境，不重启服务；后台恢复和托盘启动也使用同一选择。
 * 指定安装时返回校验所用的检测结果，调用方可直接沿用，免去再检测一次。
 */
export async function saveDesktopRuntimeSelection(
  path: string | null,
  runtimeRoot?: string | null,
): Promise<DesktopRuntimeCatalog | null> {
  const next = serviceStore.envVars.filter(item => !runtimeEnvironmentKeys.has(item.key.trim().toUpperCase()))
  if (path) {
    next.push(
      { key: 'OMPI_OMP_BIN', value: path },
      { key: 'OMPI_OMP_RUNTIME_DIR', value: runtimeRoot ?? '' },
      { key: 'OMPI_OMP_PACKAGE_ROOT', value: '' },
      { key: 'OMPI_BUN_BIN', value: '' },
    )
  }
  const invoke = await getInvoke()
  let checked: DesktopRuntimeCatalog | null = null
  if (path) {
    checked = await invoke<DesktopRuntimeCatalog>('get_ompiui_runtime_catalog', {
      envVars: Object.fromEntries(next.map(item => [item.key.trim(), item.value])),
    })
    const error = checked.available.error || checked.available.selected?.error
    if (error || !checked.available.selected?.version) throw new Error(error || 'OMP runtime could not be verified')
  }
  const background = await getDesktopBackgroundStatus()
  if (background.supported) {
    await invoke('set_ompiui_background_settings', {
      loginStart: background.loginStart,
      crashRecovery: background.crashRecovery,
      envVars: Object.fromEntries(next.map(item => [item.key.trim(), item.value])),
    })
  }
  serviceStore.setEnvVars(next)
  return checked
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
    applyDesktopServiceStart(result)
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
  const background = await getDesktopBackgroundStatus()
  if (background.lifecycle === 'stopped' || background.lifecycle === 'update-paused') return null
  return startDesktopService()
}
