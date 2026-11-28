import { DshApiError, isDshControllerAuthFailure, type DshAppConnection, type DshAppSession } from './dshRemote'
import { openDshTunnelTransport } from './dshTunnelTransport'
import { recordDshDiagnostic } from './dshConnectionDiagnostics'
import { dshControllerStore } from '../store/dshControllerStore'
import { serverStore } from '../store/serverStore'

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
export async function disconnectDshServer(ended = false): Promise<void> {
  selection++
  const attempt = active
  active = undefined
  const connection = dshControllerStore.get().connection
  dshControllerStore.update({ connection: ended && connection ? { ...connection, phase: 'ended' } : null })
  if (!attempt) { await releasing; return }
  attempt.unlisten?.()
  attempt.tunnel?.close()
  serverStore.removeRuntimeServer(attempt.serverId, attempt.previousServerId)
  if (!attempt.connection) attempt.stop.abort()
  const release = (async () => {
    try { await attempt.connection?.close() } finally { attempt.stop.abort() }
  })()
  releasing = release
  try { await release } finally { if (releasing === release) releasing = undefined }
}

export function handleDshControllerFailure(session: DshAppSession, error: unknown): boolean {
  if (!isDshControllerAuthFailure(error) || dshControllerStore.get().session !== session) return false
  let authError: string = error.code
  try { session.invalidate() } catch { authError = 'DSH_STORAGE_FAILED' }
  void disconnectDshServer()
  dshControllerStore.update({ session: null, hosts: [], authError })
  return true
}

/** 验证租约后的业务 API，再交给现有服务器切换逻辑；不创建新页面。 */
export async function connectDshServer(session: DshAppSession, hostId: string, name: string,
  selectServer: (serverId: string) => void): Promise<void> {
  if (active?.hostId === hostId) return
  const release = disconnectDshServer()
  const selected = selection
  const generation = serverStore.getActiveServerGeneration()
  await release
  if (selection !== selected || serverStore.getActiveServerGeneration() !== generation) return
  const attempt: Attempt = {
    id: crypto.randomUUID(), hostId, serverId: `dsh:${hostId}`,
    previousServerId: serverStore.getActiveServerId(), stop: new AbortController(),
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
      if (!handleDshControllerFailure(session, error)) void disconnectDshServer(true)
    })
    const tunnel = await openDshTunnelTransport(connection.grant, attempt.stop.signal)
    if (active !== attempt) { tunnel.close(); return }
    attempt.tunnel = tunnel
    serverStore.registerRuntimeServer({ id: attempt.serverId, name, url: tunnel.url, source: 'dsh' })
    const health = await serverStore.checkHealth(attempt.serverId)
    if (active !== attempt) return
    if (health.status !== 'online') throw new DshApiError(health.status === 'unauthorized' ? 'HOST_UPDATE_REQUIRED' : 'LEASE_FAILED', 0)
    selectServer(attempt.serverId)
    if (serverStore.getActiveServerId() !== attempt.serverId) throw new DshApiError('LEASE_FAILED', 0)
    dshControllerStore.update({ connection: { hostId, serverId: attempt.serverId, phase: 'connected' } })
  } catch (error) {
    if (active !== attempt) return
    recordDshDiagnostic('connect.failure', { attemptId: attempt.id, durationMs: Date.now() - started,
      code: error instanceof DshApiError ? error.code : 'LEASE_FAILED' })
    if (handleDshControllerFailure(session, error)) return
    await disconnectDshServer()
    throw error
  }
}
