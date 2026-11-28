// ============================================
// Server Store - 多后端服务器配置管理
// ============================================

import { API_BASE_URL } from '../constants'
import { getHttpFetch } from '../utils/tauri'
import { PROTOCOL_VERSION } from '@ompiui/protocol'
import { resolveAndroidTailscaleUrl } from '../utils/androidTailscale'
import { auditHttpRequest } from '../omp/trafficAudit/http'

/** 这条连接是怎么加进来的：配对兑换，还是手动填的地址和密钥。只用于列表里的来源标记。 */
export type ServerSource = 'pair' | 'manual' | 'dsh'

/**
 * 服务器配置
 */
export interface ServerConfig {
  id: string // 唯一标识
  name: string // 显示名称
  url: string // 服务器 URL (不含尾部斜杠)
  isDefault?: boolean // 是否为默认服务器
  token?: string // Bearer token (OMPiUI 服务器分享链接使用)
  source?: ServerSource // 旧数据没有这个字段
}

/**
 * 服务器健康状态
 */
export interface ServerHealth {
  status: 'checking' | 'online' | 'offline' | 'error' | 'unauthorized'
  latency?: number // 响应延迟 (ms)
  lastCheck?: number // 上次检查时间戳
  error?: string // 错误信息
  details?: string // 原始诊断信息
  version?: string // 实际探测到的 OMP CLI 版本
}

export interface ServerSettingsBackup {
  servers: ServerConfig[]
  activeServerId: string | null
}

interface ServerClockCalibration {
  serverTimestamp: number
  calibratedAtMonotonic: number
}

type Listener = () => void
export type ServerChangeReason = 'server-switch' | 'local-runtime-url' | 'server-config-updated'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeConnectionError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'Connection timed out'
  if (!(err instanceof Error)) return 'Connection failed'

  const message = err.message || 'Connection failed'
  if (/certificate|cert|tls|ssl/i.test(message)) {
    return `TLS/certificate error: ${message}`
  }
  return message
}

function redactHeaderValue(key: string, value: string): string {
  return /set-cookie|authorization|proxy-authorization/i.test(key) ? '<redacted>' : value
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = redactHeaderValue(key, value)
  })
  return result
}

function truncateForDiagnostics(value: string, maxLength = 5000): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`
}

function formatResponseDiagnostics(options: {
  url: string
  response: Response
  latency: number
  body: string
}): string {
  const contentType = options.response.headers.get('content-type') ?? ''
  return [
    `Request: GET ${options.url}`,
    `Status: ${options.response.status}${options.response.statusText ? ` ${options.response.statusText}` : ''}`,
    `Latency: ${options.latency}ms`,
    `Content-Type: ${contentType || '(none)'}`,
    `Headers:\n${JSON.stringify(headersToRecord(options.response.headers), null, 2)}`,
    `Body (${options.body.length} chars):\n${truncateForDiagnostics(options.body)}`,
  ].join('\n\n')
}

function formatExceptionDiagnostics(url: string, err: unknown): string {
  if (!(err instanceof Error)) return `Request: GET ${url}\n\nError: ${String(err)}`

  const cause = 'cause' in err && err.cause !== undefined ? `\n\nCause:\n${String(err.cause)}` : ''
  return [
    `Request: GET ${url}`,
    `Error name: ${err.name}`,
    `Message: ${err.message}`,
    err.stack ? `Stack:\n${err.stack}` : '',
  ]
    .filter(Boolean)
    .join('\n\n') + cause
}

const STORAGE_KEY = 'ompiui-servers'
const ACTIVE_SERVER_KEY = 'ompiui-active-server'
const RUNTIME_ROUTE_KEY = 'ompiui-runtime-server-route'
const LEGACY_STORAGE_KEY = 'piui-servers'
const LEGACY_ACTIVE_SERVER_KEY = 'piui-active-server'
export const LOCAL_SERVER_ID = 'local'

/**
 * 默认 local 条目是否被用户改过地址：保存的是绝对 http(s) URL 且不等于内置
 * API_BASE_URL。旧数据里的相对路径（如 /api）不算改过，健康检查仍走同源。
 */
export function isCustomizedLocalServerUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && url !== API_BASE_URL
}

function isLoopbackServerUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return (protocol === 'http:' || protocol === 'https:') &&
      (hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.') && /^127(?:\.\d{1,3}){3}$/.test(hostname))
  } catch {
    return false
  }
}

/**
 * Server Store
 * 管理多个 OMPiUI server 配置
 */
class ServerStore {
  private servers: ServerConfig[] = []
  private runtimeServers = new Map<string, ServerConfig>()
  private activeServerId: string | null = null
  private healthMap = new Map<string, ServerHealth>()
  private healthCheckSeqMap = new Map<string, number>()
  private clockCalibrationMap = new Map<string, ServerClockCalibration>()
  private listeners: Set<Listener> = new Set()
  private localServerUrlOverride: string | null = null

  // server 切换监听器（用于触发 SSE 重连等副作用，避免循环依赖）
  private serverChangeListeners: Set<(newServerId: string, reason: ServerChangeReason) => void> = new Set()
  private serverChangeGeneration = 0

  // 快照缓存 (用于 useSyncExternalStore)
  private _serversSnapshot: ServerConfig[] = []
  private _activeServerSnapshot: ServerConfig | null = null
  private _healthMapSnapshot: Map<string, ServerHealth> = new Map()

  // 默认本地服务器 ID
  private readonly DEFAULT_SERVER_ID = LOCAL_SERVER_ID

  constructor() {
    this.loadFromStorage()
    this.updateSnapshots()
  }

  // ============================================
  // Storage
  // ============================================

  private loadFromStorage(): void {
    try {
      // 加载服务器列表；改名前的 piui-servers 只读迁移一次
      const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
      if (stored) {
        this.servers = JSON.parse(stored)
      }

      // 如果没有服务器，添加默认的本地服务器
      if (this.servers.length === 0) {
        this.servers = [
          {
            id: this.DEFAULT_SERVER_ID,
            name: 'Local',
            url: API_BASE_URL,
            isDefault: true,
          },
        ]
      }

      // 加载当前选中的服务器
      // 优先从 sessionStorage 读取（per-window 隔离，刷新保持）
      // 回退到 localStorage（新窗口首次打开时继承上次默认）
      const activeId = sessionStorage.getItem(ACTIVE_SERVER_KEY)
        ?? localStorage.getItem(ACTIVE_SERVER_KEY)
        ?? localStorage.getItem(LEGACY_ACTIVE_SERVER_KEY)
      if (activeId && this.servers.some(s => s.id === activeId)) {
        this.activeServerId = activeId
      } else {
        // 默认选中第一个
        this.activeServerId = this.servers[0]?.id ?? null
      }
    } catch {
      // 初始化默认值
      this.servers = [
        {
          id: this.DEFAULT_SERVER_ID,
          name: 'Local',
          url: API_BASE_URL,
          isDefault: true,
        },
      ]
      this.activeServerId = this.DEFAULT_SERVER_ID
    }
  }

  private saveToStorage(selection?: 'window' | 'default'): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.servers))
      if (selection) {
        if (this.activeServerId && this.runtimeServers.has(this.activeServerId)) {
          sessionStorage.setItem(RUNTIME_ROUTE_KEY, this.activeServerId)
        } else sessionStorage.removeItem(RUNTIME_ROUTE_KEY)
      }
      if (selection && this.activeServerId && !this.runtimeServers.has(this.activeServerId)) {
        sessionStorage.setItem(ACTIVE_SERVER_KEY, this.activeServerId)
        if (selection === 'default') localStorage.setItem(ACTIVE_SERVER_KEY, this.activeServerId)
      }
    } catch {
      // ignore
    }
  }

  // ============================================
  // Subscription
  // ============================================

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 注册 active server 入口变化监听器（server id 切换或 active local runtime URL 变化）。
   * 返回取消注册函数。
   */
  onServerChange(fn: (newServerId: string, reason: ServerChangeReason) => void): () => void {
    this.serverChangeListeners.add(fn)
    return () => this.serverChangeListeners.delete(fn)
  }

  private notifyServerChange(serverId: string, reason: ServerChangeReason): void {
    this.serverChangeGeneration += 1
    // The visible server fields can stay identical when Tauri re-attaches to
    // the same local URL. Notify React subscribers after the generation moves
    // so generation-aware data loaders start a fresh flight.
    this.listeners.forEach(listener => listener())
    this.serverChangeListeners.forEach(fn => {
      fn(serverId, reason)
    })
  }

  getActiveServerGeneration(): number {
    return this.serverChangeGeneration
  }

  private notify(): void {
    this.updateSnapshots()
    this.listeners.forEach(l => {
      l()
    })
  }

  /**
   * 更新快照缓存
   */
  private updateSnapshots(): void {
    this._serversSnapshot = [...this.servers.map(server => this.withRuntimeServerUrl(server)), ...this.runtimeServers.values()]
    this._activeServerSnapshot = this._serversSnapshot.find(s => s.id === this.activeServerId) ?? null
    this._healthMapSnapshot = new Map(this.healthMap)
  }

  private withRuntimeServerUrl(server: ServerConfig): ServerConfig {
    if (server.id === this.DEFAULT_SERVER_ID && this.localServerUrlOverride) {
      return { ...server, url: this.localServerUrlOverride }
    }
    return server
  }

  // ============================================
  // Getters
  // ============================================

  /**
   * 获取所有服务器配置 (返回缓存快照)
   */
  getServers(): ServerConfig[] {
    return this._serversSnapshot
  }

  getStoredServers(): ServerConfig[] {
    return [...this.servers]
  }

  /**
   * 获取当前活动服务器 (返回缓存快照)
   */
  getActiveServer(): ServerConfig | null {
    return this._activeServerSnapshot
  }

  getLocalServer(): ServerConfig | null {
    return this._serversSnapshot.find(s => s.id === this.DEFAULT_SERVER_ID) ?? null
  }

  getLocalServerUrl(): string {
    return this.getLocalServer()?.url ?? API_BASE_URL
  }

  isActiveLocalServer(): boolean {
    return this.getActiveServerId() === this.DEFAULT_SERVER_ID
  }

  acceptsLocalDirectory(): boolean {
    return this.isActiveLocalServer() &&
      (this.localServerUrlOverride !== null || isLoopbackServerUrl(this.getActiveBaseUrl()))
  }

  matchesSavedBackend(id: string, url: string): boolean {
    return this.servers.some(server => server.id === id && server.url === url)
  }

  applyManagedLocalService(url: string, token: string): boolean {
    if (!url || !token) return false
    const index = this.servers.findIndex(server => server.id === this.DEFAULT_SERVER_ID)
    const local = this.servers[index]
    // A user-edited remote endpoint in the default slot is still remote.
    if (!local || (isCustomizedLocalServerUrl(local.url) && !isLoopbackServerUrl(local.url))) return false
    const normalizedUrl = url.replace(/\/+$/, '')
    if (local.token === token && this.localServerUrlOverride === normalizedUrl) return true
    this.servers[index] = { ...local, token }
    this.localServerUrlOverride = normalizedUrl
    this.healthMap.delete(this.DEFAULT_SERVER_ID)
    this.healthCheckSeqMap.set(this.DEFAULT_SERVER_ID, (this.healthCheckSeqMap.get(this.DEFAULT_SERVER_ID) ?? 0) + 1)
    this.saveToStorage()
    this.notify()
    if (this.isActiveLocalServer()) this.notifyServerChange(this.DEFAULT_SERVER_ID, 'local-runtime-url')
    return true
  }

  /**
   * 获取当前活动服务器 ID（用于 per-server storage 等场景）
   * 返回 'local' 作为默认值，保证永远有值
   */
  getActiveServerId(): string {
    return this.activeServerId ?? this.DEFAULT_SERVER_ID
  }

  /** 刷新会结束内存租约，旧隧道的会话路由不能落到恢复的普通服务器。 */
  consumeExpiredRuntimeRoute(): boolean {
    try {
      const id = sessionStorage.getItem(RUNTIME_ROUTE_KEY)
      if (!id || this.runtimeServers.has(id)) return false
      sessionStorage.removeItem(RUNTIME_ROUTE_KEY)
      return true
    } catch { return false }
  }

  /**
   * 获取当前 API Base URL
   */
  getActiveBaseUrl(): string {
    const server = this.getActiveServer()
    return server?.url ?? API_BASE_URL
  }

  /**
   * 获取当前活动服务器的 Bearer token
   */
  getActiveToken(): string | undefined {
    return this.getActiveServer()?.token
  }

  /**
   * 获取服务器健康状态
   */
  getHealth(serverId: string): ServerHealth | null {
    return this.healthMap.get(serverId) ?? null
  }

  /**
   * 获取所有服务器的健康状态 (返回缓存快照)
   */
  getAllHealth(): Map<string, ServerHealth> {
    return this._healthMapSnapshot
  }

  getActiveCalibratedNow(): number | undefined {
    const calibration = this.clockCalibrationMap.get(this.getActiveServerId())
    if (!calibration) return undefined
    return calibration.serverTimestamp + (performance.now() - calibration.calibratedAtMonotonic)
  }

  // ============================================
  // Mutations
  // ============================================

  /**
   * 添加服务器
   */
  addServer(config: Omit<ServerConfig, 'id'>): ServerConfig {
    const id = `server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const server: ServerConfig = {
      ...config,
      id,
      url: config.url.replace(/\/+$/, ''), // 移除尾部斜杠
    }
    this.servers.push(server)
    this.saveToStorage()
    this.notify()
    return server
  }

  /** 短期隧道只在当前前端进程内注册，地址和会话凭据不进入保存的服务器列表。 */
  registerRuntimeServer(server: ServerConfig): void {
    if (this.servers.some(saved => saved.id === server.id)) throw new Error('Server ID already exists')
    this.runtimeServers.set(server.id, { ...server, url: server.url.replace(/\/+$/, '') })
    this.notify()
  }

  removeRuntimeServer(id: string, fallbackId?: string): void {
    if (!this.runtimeServers.delete(id)) return
    const wasActive = this.activeServerId === id
    this.healthMap.delete(id)
    this.healthCheckSeqMap.delete(id)
    this.clockCalibrationMap.delete(id)
    if (wasActive) {
      this.activeServerId = this.servers.find(server => server.id === fallbackId)?.id ?? this.servers[0]?.id ?? null
      this.saveToStorage('window')
    }
    this.notify()
    if (wasActive) this.notifyServerChange(this.getActiveServerId(), 'server-switch')
  }

  /**
   * 更新服务器配置
   */
  updateServer(id: string, updates: Partial<Omit<ServerConfig, 'id'>>): boolean {
    const index = this.servers.findIndex(s => s.id === id)
    if (index === -1) return false

    const server = this.servers[index]
    const endpointChanged =
      (updates.url !== undefined && updates.url.replace(/\/+$/, '') !== server.url) ||
      (updates.url !== undefined && id === this.DEFAULT_SERVER_ID && this.localServerUrlOverride !== null) ||
      (updates.token !== undefined && updates.token !== server.token)
    this.servers[index] = {
      ...server,
      ...updates,
      id: server.id, // 确保 id 不被覆盖
      url: updates.url ? updates.url.replace(/\/+$/, '') : server.url,
    }
    if (id === this.DEFAULT_SERVER_ID && updates.url) {
      this.localServerUrlOverride = null
    }
    if (endpointChanged) {
      // Drop the previous endpoint's verdict (e.g. 401 for the old token) and invalidate in-flight checks.
      // Bump the sequence instead of deleting it so a reused sequence number can never commit a stale result.
      this.healthMap.delete(id)
      this.healthCheckSeqMap.set(id, (this.healthCheckSeqMap.get(id) ?? 0) + 1)
    }
    this.saveToStorage()
    this.notify()
    if (id === this.getActiveServerId() && endpointChanged) {
      this.notifyServerChange(id, 'server-config-updated')
    }
    return true
  }

  setLocalServerRuntimeUrl(url: string): boolean {
    if (!this.servers.some(s => s.id === this.DEFAULT_SERVER_ID)) return false

    const normalizedUrl = url.replace(/\/+$/, '')
    if (this.localServerUrlOverride === normalizedUrl) return false

    this.localServerUrlOverride = normalizedUrl
    this.notify()
    if (this.isActiveLocalServer()) {
      this.notifyServerChange(this.DEFAULT_SERVER_ID, 'local-runtime-url')
    }
    return true
  }

  /**
   * 删除服务器
   */
  removeServer(id: string): boolean {
    // 不能删除默认服务器
    const server = this.servers.find(s => s.id === id)
    if (!server || server.isDefault) return false
    const wasActive = this.activeServerId === id

    this.servers = this.servers.filter(s => s.id !== id)
    this.healthMap.delete(id)
    this.healthCheckSeqMap.delete(id)
    this.clockCalibrationMap.delete(id)

    // 如果删除的是当前选中的，切换到默认
    if (this.activeServerId === id) {
      this.activeServerId = this.servers[0]?.id ?? null
    }

    this.saveToStorage(wasActive ? 'default' : undefined)
    this.notify()
    if (wasActive) {
      this.notifyServerChange(this.activeServerId ?? this.DEFAULT_SERVER_ID, 'server-switch')
    }
    return true
  }

  /**
   * 设置活动服务器
   * 如果实际切换了服务器，会通知 serverChangeListeners（用于 SSE 重连等）
   */
  setActiveServer(id: string, scope: 'window' | 'default' = 'default'): boolean {
    if (!this.servers.some(s => s.id === id) && !this.runtimeServers.has(id)) return false

    const changed = this.activeServerId !== id
    this.activeServerId = id
    this.saveToStorage(scope)
    this.notify()

    if (changed) {
      this.notifyServerChange(id, 'server-switch')
    }

    return true
  }

  applyServerConnectedTimestamp(serverId: string, timestamp: unknown): boolean {
    const normalizedTimestamp = normalizeServerTimestamp(timestamp)
    if (normalizedTimestamp == null) return false

    this.clockCalibrationMap.set(serverId, {
      serverTimestamp: normalizedTimestamp,
      calibratedAtMonotonic: performance.now(),
    })
    this.notify()
    return true
  }

  // ============================================
  // Health Check
  // ============================================

  /**
   * 健康检查始终打向用户保存的地址。默认 Local 就是 127.0.0.1:8787，
   * 静态前端不能把“没有后端”误判成“同源就是后端”。
   */
  private resolveHealthBaseUrl(server: ServerConfig): string {
    // 旧数据里默认 Local 可能存的是相对路径（如 /api）：数据请求会落到内置地址，检查也打向同一个地方。
    if (server.id === this.DEFAULT_SERVER_ID && !/^https?:\/\//i.test(server.url)) return API_BASE_URL
    return server.url
  }

  /**
   * 检查服务器健康状态
   */
  async checkHealth(serverId: string): Promise<ServerHealth> {
    const storedServer = this.servers.find(s => s.id === serverId) ?? this.runtimeServers.get(serverId)
    if (!storedServer) {
      return { status: 'error', error: 'Server not found' }
    }
    const server = this.withRuntimeServerUrl(storedServer)
    const checkSeq = (this.healthCheckSeqMap.get(serverId) ?? 0) + 1
    this.healthCheckSeqMap.set(serverId, checkSeq)
    const healthUrl = `${this.resolveHealthBaseUrl(server)}/api/v1/host/health`

    const commitHealth = (health: ServerHealth) => {
      if (this.healthCheckSeqMap.get(serverId) === checkSeq) {
        this.healthMap.set(serverId, health)
        this.notify()
      }
      return health
    }

    // 首次检查才标为检查中；已有结果的轮询保持原状态，避免指示器抖动
    if (!this.healthMap.has(serverId)) {
      this.healthMap.set(serverId, { status: 'checking' })
      this.notify()
    }

    const startTime = Date.now()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)

    try {
      const headers: Record<string, string> = {}
      if (server.token) {
        headers['Authorization'] = `Bearer ${server.token}`
      }

      const f = await getHttpFetch()
      const resolvedUrl = await resolveAndroidTailscaleUrl(healthUrl)
      const init: RequestInit = {
        method: 'GET',
        signal: controller.signal,
        headers,
      }
      const response = await auditHttpRequest(healthUrl, init, () => f(resolvedUrl, init), server.url)

      const latency = Date.now() - startTime
      const responseBody = await response.text().catch(err => `[Failed to read response body: ${normalizeConnectionError(err)}]`)
      const details = formatResponseDiagnostics({ url: healthUrl, response, latency, body: responseBody })

      if (response.ok) {
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
        if (!contentType.includes('application/json')) {
          const health: ServerHealth = {
            status: 'error',
            latency,
            lastCheck: Date.now(),
            error: contentType.includes('text/html')
              ? 'Server returned HTML instead of OMPiUI health JSON. Check the URL path.'
              : 'Server did not return OMPiUI health JSON',
            details,
          }
          return commitHealth(health)
        }

        let data: unknown
        try {
          data = JSON.parse(responseBody)
        } catch {
          const health: ServerHealth = {
            status: 'error',
            latency,
            lastCheck: Date.now(),
            error: 'Invalid OMPiUI health JSON',
            details,
          }
          return commitHealth(health)
        }

        if (!isRecord(data) || data.ok !== true || data.service !== 'ompiui-server' || data.protocolVersion !== PROTOCOL_VERSION) {
          const health: ServerHealth = {
            status: 'error',
            latency,
            lastCheck: Date.now(),
            error: 'Not a compatible OMPiUI server',
            details,
          }
          return commitHealth(health)
        }

        const health: ServerHealth = {
          status: 'online',
          latency,
          lastCheck: Date.now(),
          version: typeof data.ompVersion === 'string' ? data.ompVersion : undefined,
          details,
        }
        return commitHealth(health)
      } else if (response.status === 401) {
        // 认证失败
        const health: ServerHealth = {
          status: 'unauthorized',
          latency,
          lastCheck: Date.now(),
          error: 'Invalid credentials',
          details,
        }
        return commitHealth(health)
      } else {
        const health: ServerHealth = {
          status: 'error',
          latency,
          lastCheck: Date.now(),
          error: `HTTP ${response.status}`,
          details,
        }
        return commitHealth(health)
      }
    } catch (err) {
      const health: ServerHealth = {
        status: 'offline',
        lastCheck: Date.now(),
        error: normalizeConnectionError(err),
        details: formatExceptionDiagnostics(healthUrl, err),
      }
      return commitHealth(health)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 检查所有服务器健康状态
   */
  async checkAllHealth(): Promise<void> {
    await Promise.all(this._serversSnapshot.map(s => this.checkHealth(s.id)))
  }
}

// 单例导出
export const serverStore = new ServerStore()

function normalizeServerBackup(raw: unknown): ServerSettingsBackup {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const servers = Array.isArray(parsed?.servers)
    ? parsed.servers
        .filter(
          (item): item is ServerConfig =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).id === 'string' &&
            typeof (item as Record<string, unknown>).name === 'string' &&
            typeof (item as Record<string, unknown>).url === 'string',
        )
        .map(item => ({
          id: item.id,
          name: item.name,
          url: item.url.replace(/\/+$/, ''),
          isDefault: item.isDefault === true,
          token: typeof item.token === 'string' && item.token ? item.token : undefined,
          source: item.source === 'pair' || item.source === 'manual' ? item.source : undefined,
        }))
    : []

  const normalizedServers = servers.length
    ? servers
    : [
        {
          id: 'local',
          name: 'Local',
          url: API_BASE_URL,
          isDefault: true,
        },
      ]

  const activeServerId =
    typeof parsed?.activeServerId === 'string' && normalizedServers.some(server => server.id === parsed.activeServerId)
      ? parsed.activeServerId
      : (normalizedServers[0]?.id ?? null)

  return {
    servers: normalizedServers,
    activeServerId,
  }
}

export function exportServerSettingsBackup(): ServerSettingsBackup {
  const servers = serverStore.getStoredServers()
  const activeId = serverStore.getActiveServerId()
  return {
    servers: servers.map(server => ({ ...server })),
    activeServerId: servers.some(server => server.id === activeId) ? activeId : LOCAL_SERVER_ID,
  }
}

export function importServerSettingsBackup(raw: unknown): void {
  const normalized = normalizeServerBackup(raw)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized.servers))
  if (normalized.activeServerId) {
    localStorage.setItem(ACTIVE_SERVER_KEY, normalized.activeServerId)
    sessionStorage.setItem(ACTIVE_SERVER_KEY, normalized.activeServerId)
  } else {
    localStorage.removeItem(ACTIVE_SERVER_KEY)
    sessionStorage.removeItem(ACTIVE_SERVER_KEY)
  }
}

/**
 * 解析分享链接 `ompiui://connect?url=...&token=...`（兼容改名前的
 * `piui://connect`），不是分享链接时返回 null。
 */
export function parseConnectLink(input: string): { url: string; token: string } | null {
  const trimmed = input.trim()
  const lowered = trimmed.toLowerCase()
  if (!lowered.startsWith('ompiui://connect') && !lowered.startsWith('piui://connect')) return null
  try {
    const parsed = new URL(trimmed)
    const url = parsed.searchParams.get('url')
    const token = parsed.searchParams.get('token')
    if (!url || !token) return null
    new URL(url)
    return { url: url.replace(/\/+$/, ''), token }
  } catch {
    return null
  }
}

/**
 * 服务器托管 Web 客户端时的入口：URL 上的 ?token= 落到本地服务器配置里。
 * 页面与 API 同源，token 写入 local server 后即可直连；随后清掉地址栏参数，
 * 避免 token 留在历史记录和书签里。返回是否应用了 token。
 */
export function applyUrlTokenParam(search: string, origin: string): boolean {
  const params = new URLSearchParams(search)
  const token = params.get('token')
  if (!token) return false
  // 静态前端可能部署在任意域名：分享链接必须显式带 server，页面自身 origin
  // 只在后端直接托管页面时才是后端地址。
  const explicit = params.get('server')
  const server = explicit && /^https?:\/\//i.test(explicit) ? explicit : origin
  serverStore.updateServer(LOCAL_SERVER_ID, { url: server.replace(/\/+$/, ''), token })
  serverStore.setActiveServer(LOCAL_SERVER_ID)
  return true
}

/**
 * 手机远程扫码配对的入口：URL 上的 ?pair=<id>.<secret> 向同源服务端兑换
 * 一次性访问令牌（服务端单次有效 + 频控），成功后与 ?token= 一样落地并
 * 清掉地址栏参数。异步——调用方应等它完成后再渲染，避免闪一次未授权态。
 */
export async function applyPairParam(pair: string, origin: string, serverUrl?: string): Promise<boolean> {
  try {
    const requested = serverUrl && /^https?:\/\//i.test(serverUrl) ? serverUrl : origin
    const base = requested.replace(/\/+$/, '')
    const f = await getHttpFetch()
    const resolved = await resolveAndroidTailscaleUrl(`${base}/api/v1/host/pair/redeem`)
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pair }),
      signal: AbortSignal.timeout(10_000),
    }
    const response = await auditHttpRequest(`${base}/api/v1/host/pair/redeem`, init, () => f(resolved, init))
    if (!response.ok) return false
    const body = (await response.json()) as { url?: string; token?: string }
    if (!body.token) return false
    const url = (body.url ?? base).replace(/\/+$/, '')
    serverStore.updateServer(LOCAL_SERVER_ID, { url, token: body.token })
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    window.history.replaceState(null, '', window.location.pathname)
    return true
  } catch {
    return false
  }
}

/** Tauri 桌面壳启动本地 server 后，把 Rust 读到的 token 接入现有 server store。 */
export function applyLocalServerConfig(url: string, token: string): boolean {
  return serverStore.applyManagedLocalService(url, token)
}

function normalizeServerTimestamp(timestamp: unknown): number | null {
  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) ? timestamp : null
  }

  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}
