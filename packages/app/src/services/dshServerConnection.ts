import { DshApiError, isDshControllerAuthFailure, restoreDshPairedSession, type DshAppConnection, type DshAppSession } from './dshRemote'
import { openDshTunnelTransport } from './dshTunnelTransport'
import { recordDshDiagnostic } from './dshConnectionDiagnostics'
import { dshControllerStore } from '../store/dshControllerStore'
import { serverStore } from '../store/serverStore'
import { DSH_PENDING_URL } from '../store/dshServerSelection'
import { isTauri } from '../utils/tauri'

interface Attempt {
  id: string
  hostId: string
  serverId: string
  previousServerId: string
  stop: AbortController
  connection?: DshAppConnection
  tunnel?: { close(): void }
  unlisten?: () => void
}

let active: Attempt | undefined
let releasing: Promise<void> | undefined
let selection = 0

/** 切回已有服务器时释放本次隧道，原服务器配置始终保留在当前前端。 */
export async function disconnectDshServer(ended = false, preserveSelection = false): Promise<void> {
  selection++
  const attempt = active
  active = undefined
  const connection = dshControllerStore.get().connection
  dshControllerStore.update({ connection: ended && connection ? { ...connection, phase: 'ended' } : null })
  if (!attempt) {
    const server = serverStore.getActiveServer()
    if (!preserveSelection && server?.source === 'dsh') {
      serverStore.removeRuntimeServer(server.id, serverStore.getRuntimeFallbackId(server.id))
    }
    await releasing
    return
  }
  attempt.unlisten?.()
  attempt.tunnel?.close()
  if (preserveSelection) {
    const server = serverStore.getActiveServer()
    if (server?.id === attempt.serverId) serverStore.registerRuntimeServer({ ...server, url: DSH_PENDING_URL })
  } else serverStore.removeRuntimeServer(attempt.serverId, attempt.previousServerId)
  if (!attempt.connection) attempt.stop.abort()
  const release = (async () => {
    try { await attempt.connection?.close() } finally { attempt.stop.abort() }
  })()
  releasing = release
  try { await release } finally { if (releasing === release) releasing = undefined }
}

export function handleDshControllerFailure(session: DshAppSession, error: unknown,
  preserveSelection = serverStore.getActiveServer()?.source === 'dsh'): boolean {
  if (!isDshControllerAuthFailure(error) || dshControllerStore.get().session !== session) return false
  let authError: string = error.code
  try { session.invalidate() } catch { authError = 'DSH_STORAGE_FAILED' }
  void disconnectDshServer(preserveSelection, preserveSelection)
  dshControllerStore.update({ session: null, hosts: [], authError })
  return true
}

/** 验证租约后的业务 API，再交给现有服务器切换逻辑；不创建新页面。 */
export async function connectDshServer(session: DshAppSession, hostId: string, name: string,
  selectServer: (serverId: string) => void): Promise<void> {
  if (active?.hostId === hostId) return
  const restoring = serverStore.getActiveServer()?.id === `dsh:${hostId}` && serverStore.getActiveBaseUrl() === DSH_PENDING_URL
  const release = disconnectDshServer(false, restoring)
  const selected = selection
  const generation = serverStore.getActiveServerGeneration()
  await release
  if (selection !== selected || serverStore.getActiveServerGeneration() !== generation) return
  const attempt: Attempt = {
    id: crypto.randomUUID(), hostId, serverId: `dsh:${hostId}`,
    previousServerId: restoring ? serverStore.getRuntimeFallbackId(`dsh:${hostId}`) : serverStore.getActiveServerId(), stop: new AbortController(),
  }
  active = attempt
  dshControllerStore.update({ connection: { hostId, serverId: attempt.serverId, phase: 'connecting' } })
  // 等待握手期间也允许切换普通服务器；取消结果不会晚到后抢回当前选择。
  attempt.unlisten = serverStore.onServerChange(id => {
    if (active === attempt && id !== attempt.serverId) void disconnectDshServer()
  })
  const started = Date.now()
  recordDshDiagnostic('connect.start', { attemptId: attempt.id })
  try {
    const connection = await session.connect(hostId, attempt.stop.signal, attempt.id)
    if (active !== attempt) { await connection.close(); return }
    attempt.connection = connection
    void connection.closed.then(({ error }) => {
      if (active !== attempt) return
      if (!handleDshControllerFailure(session, error, restoring)) void disconnectDshServer(true, restoring)
      if (restoring) dshControllerStore.update({ connection: { hostId, serverId: attempt.serverId, phase: 'ended',
        error: error instanceof DshApiError ? error.code : 'LEASE_FAILED' } })
    })
    const tunnel = await openDshTunnelTransport(connection.grant, attempt.stop.signal)
    if (active !== attempt) { tunnel.close(); return }
    attempt.tunnel = tunnel
    serverStore.registerRuntimeServer({ id: attempt.serverId, name, url: tunnel.url, source: 'dsh' }, attempt.previousServerId)
    const health = await serverStore.checkHealth(attempt.serverId)
    if (active !== attempt) return
    if (health.status !== 'online') throw new DshApiError(health.status === 'unauthorized' ? 'HOST_UPDATE_REQUIRED' : 'LEASE_FAILED', 0)
    // 冷启动已经恢复了该电脑的路由，重新取得租约不能把用户送回首页。
    if (!restoring) selectServer(attempt.serverId)
    if (serverStore.getActiveServerId() !== attempt.serverId) throw new DshApiError('LEASE_FAILED', 0)
    dshControllerStore.update({ connection: { hostId, serverId: attempt.serverId, phase: 'connected' } })
  } catch (error) {
    if (active !== attempt) return
    recordDshDiagnostic('connect.failure', { attemptId: attempt.id, durationMs: Date.now() - started,
      code: error instanceof DshApiError ? error.code : 'LEASE_FAILED' })
    if (handleDshControllerFailure(session, error, restoring)) return
    await disconnectDshServer(restoring, restoring)
    if (restoring && !active && serverStore.getActiveServerId() === attempt.serverId) dshControllerStore.update({ connection: {
      hostId, serverId: attempt.serverId, phase: 'ended', error: error instanceof DshApiError ? error.code : 'LEASE_FAILED',
    } })
    throw error
  }
}

/** 在主界面启动时恢复设备授权及上次选择，网络握手在后台进行。 */
export async function restoreDshServer(): Promise<void> {
  if (!isTauri()) return
  const server = serverStore.getActiveServer()
  if (server?.source !== 'dsh' || server.url !== DSH_PENDING_URL) return
  const hostId = server.id.slice(4)
  try {
    const session = dshControllerStore.get().session ?? restoreDshPairedSession()
    if (!session) throw new DshApiError('TOKEN_EXPIRED', 0)
    dshControllerStore.update({ session })
    await connectDshServer(session, hostId, server.name, id => { serverStore.setActiveServer(id) })
  } catch (error) {
    if (serverStore.getActiveServerId() !== server.id) return
    dshControllerStore.update({ connection: { hostId, serverId: server.id, phase: 'ended',
      error: error instanceof DshApiError ? error.code : 'LEASE_FAILED' } })
    if (!dshControllerStore.get().session) dshControllerStore.update({ authError: error instanceof DshApiError ? error.code : 'DSH_STORAGE_FAILED' })
  }
}
