import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DshRemoteAccount } from './dsh-remote-account.ts'
import { DshControl, type DshControlSocketFactory, dshConnectionId, dshDeviceId, parseDshSecure, verifyDshPeer } from './dsh-control.ts'
import { DSH_WEB_LEASE_ENDED, DshNoise, OMPIUI_DSH_WEB_CAPABILITY, parseDshBrowserGrant, type DshBrowserGrant, type DshWebLeaseEnd } from '@ompiui/protocol/dsh-remote'
import { openDshHostc } from './dsh-hostc/index.ts'

const TUNNEL_DOMAIN = /^(?:hostc|tun|hostc-test|tun-test)\.4ba\.io$/
const TUNNEL_ID = /^[tp][abcdefghijkmnpqrstuvwxyz23456789]{11}$/
const GRANT = /^[A-Za-z0-9_-]{43}$/
const LEASE_MS = 9 * 60_000
// 服务器自己定时长时最多给到两小时；不认这个选项的旧服务器仍按九分钟算。
const MAX_LEASE_MS = 120 * 60_000
const CHECK_MS = 15_000

const dshHostDefaults = { openHostc: openDshHostc, checkMs: CHECK_MS }

class WebLease {
  private connector?: Awaited<ReturnType<typeof openDshHostc>>
  private sessionId?: string
  private closing?: Promise<void>
  private readonly stop = new AbortController()
  private request?: { clientDeviceId: string; connectionId: string; requestId: string; leaseExpiresAt: number; sessionId?: string }

  constructor(private readonly account: DshRemoteAccount, private readonly path: string, private readonly localPort: number,
    private readonly activeOrigins: Set<string>, private readonly onEnd: (reason: DshWebLeaseEnd) => void,
    private readonly options = dshHostDefaults) {}

  private origin?: string

  async open(clientDeviceId: string, connectionId: string, parent: AbortSignal): Promise<DshBrowserGrant> {
    const signal = AbortSignal.any([this.stop.signal, parent, AbortSignal.timeout(21_000)])
    const startedAt = Date.now()
    const request = { clientDeviceId, connectionId, requestId: randomUUID(), leaseExpiresAt: startedAt + LEASE_MS }
    this.request = request
    try {
      const data = await this.call('', signal) as {
        sessionId?: unknown; url?: unknown; connectUrl?: unknown; connectToken?: unknown; leaseExpiresAt?: unknown
      } | null
      if (typeof data?.sessionId !== 'string' || !TUNNEL_ID.test(data.sessionId)) throw new Error('Invalid DS Harness Remote allocation')
      this.sessionId = data.sessionId
      if (typeof data.url !== 'string' || typeof data.connectUrl !== 'string' || typeof data.connectToken !== 'string'
        || !GRANT.test(data.connectToken) || typeof data.leaseExpiresAt !== 'number' || !Number.isSafeInteger(data.leaseExpiresAt)
        || data.leaseExpiresAt <= Date.now() || data.leaseExpiresAt > startedAt + MAX_LEASE_MS) throw new Error('Invalid DS Harness Remote allocation')
      const browserUrl = new URL(data.url)
      const connect = new URL(data.connectUrl)
      if (!TUNNEL_DOMAIN.test(connect.hostname) || browserUrl.href !== `https://${data.sessionId}.${connect.hostname}/`
        || connect.href !== `wss://${connect.hostname}/api/tunnels/${data.sessionId}/connect`) throw new Error('Invalid DS Harness Remote allocation host')
      this.request = { ...request, leaseExpiresAt: data.leaseExpiresAt }
      this.connector = await this.options.openHostc({
        lease: { id: data.sessionId, url: browserUrl.href, connectUrl: connect.href, token: data.connectToken },
        localPort: this.localPort,
      }, signal)
      this.origin = browserUrl.origin
      this.activeOrigins.add(browserUrl.origin)
      // The first grant is bound to the allocating connection. Never use a dial token as a grant.
      const grant = parseDshBrowserGrant(await this.call('/grant', signal))
      if (grant.url !== browserUrl.href || grant.expiresAt > data.leaseExpiresAt) throw new Error('Invalid DS Harness Remote lease grant')
      signal.throwIfAborted()
      void this.monitor(parent, this.connector, data.leaseExpiresAt)
      return grant
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private async call(suffix: string, signal: AbortSignal): Promise<unknown> {
    return this.account.deviceRequest(`${this.path}${suffix}`, {
      method: 'POST', body: JSON.stringify({
        ...this.request,
        ...(suffix === '' ? { useServerLease: true } : suffix === '/check' ? { sessionId: this.sessionId } : {}),
      }), signal,
    })
  }

  private async monitor(signal: AbortSignal, connector: NonNullable<WebLease['connector']>, deadline: number): Promise<void> {
    const deadlineSignal = AbortSignal.timeout(Math.max(0, deadline - Date.now()))
    const transport = new AbortController()
    void connector.closed.then(() => transport.abort())
    const combined = AbortSignal.any([signal, this.stop.signal, deadlineSignal, transport.signal])
    let reason: DshWebLeaseEnd
    try {
      for (;;) {
        await delay(this.options.checkMs, undefined, { signal: combined, ref: false })
        await this.call('/check', combined)
      }
    } catch {
      if (signal.aborted || this.stop.signal.aborted) return
      reason = deadlineSignal.aborted ? 'expired' : transport.signal.aborted ? 'hostc-closed' : 'check-failed'
    }
    const closed = this.close()
    this.onEnd(reason)
    await closed
  }

  close(): Promise<void> {
    return this.closing ??= this.release()
  }

  private async release(): Promise<void> {
    this.stop.abort()
    this.connector?.close()
    this.connector = undefined
    if (this.origin) this.activeOrigins.delete(this.origin)
    this.origin = undefined
    const id = this.sessionId
    this.sessionId = undefined
    if (id) await this.account.deviceRequest(`${this.path}/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
  }
}

interface Peer {
  id: string
  noise: DshNoise
  lifetime: AbortController
  handshakeTimeout: NodeJS.Timeout
  selected: boolean
  pendingHandshake?: string
  lease?: WebLease
  operation?: Promise<void>
}

export async function runDshHost(account: DshRemoteAccount, localPort: number, signal: AbortSignal,
  activeOrigins: Set<string>, onReady?: () => void,
  options: Partial<typeof dshHostDefaults> & { socketFactory?: DshControlSocketFactory } = {}): Promise<void> {
  const settings = { ...dshHostDefaults, ...options }
  let rejected: string | undefined
  for (;;) {
    const { control, identity, accessToken, refreshed } = await DshControl.open(account, signal, rejected, options.socketFactory)
    try {
      await serveDshPeers(account, localPort, signal, activeOrigins, control, identity, settings, onReady)
      return
    } catch (error) {
      signal.throwIfAborted()
      if (refreshed || (error as { code?: string })?.code !== 'AUTH_INVALID') throw error
      rejected = accessToken
    }
  }
}

async function serveDshPeers(account: DshRemoteAccount, localPort: number, signal: AbortSignal,
  activeOrigins: Set<string>, control: DshControl, identity: Awaited<ReturnType<typeof DshControl.open>>['identity'],
  settings: typeof dshHostDefaults, onReady?: () => void): Promise<void> {
  const peers = new Map<string, Peer>()
  const path = `/api/v1/hosts/${encodeURIComponent(identity.deviceId)}/dsh-web/sessions`
  const closePeer = async (id: string) => {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id)
    peer.lifetime.abort()
    clearTimeout(peer.handshakeTimeout)
    peer.noise.destroy()
    await peer.operation?.catch(() => undefined)
    await peer.lease?.close()
  }
  onReady?.()
  try {
    for (let message = await control.next(signal); message; message = await control.next(signal)) {
      const { type, payload } = message
      if (type === 'connect.incoming') {
        const id = dshConnectionId(payload.connectionId)
        try {
          if (peers.has(id)) continue
          if (payload.authorization !== 'account' || typeof payload.clientIdentityKey !== 'string'
            || !Array.isArray(payload.preferredTransports) || !payload.preferredTransports.includes('relay') || peers.size >= 8) {
            throw new Error('Connection is not authorized for Relay')
          }
          const client = dshDeviceId(payload.clientDeviceId)
          const key = await verifyDshPeer(account, 'client', client, signal, payload.clientIdentityKey)
          const handshakeTimeout = setTimeout(() => void closePeer(id), 12_000)
          handshakeTimeout.unref()
          peers.set(id, { id: client, noise: new DshNoise(identity, key, id, identity.deviceId, client),
            selected: false, lifetime: new AbortController(), handshakeTimeout })
          control.send('connect.accepted', { connectionId: id })
        } catch {
          await closePeer(id)
          control.send('connect.rejected', { connectionId: id })
        }
      } else if (type === 'error' && typeof payload.connectionId !== 'string') {
        throw control.failure(payload.code)
      } else if (['error', 'transport.selected', 'secure.handshake', 'relay'].includes(type)) {
        const id = dshConnectionId(payload.connectionId)
        const peer = peers.get(id)
        if (!peer) continue
        try {
          if (type === 'error') { await closePeer(id); continue }
          if (payload.targetDeviceId !== identity.deviceId) throw new Error('Wrong DS Harness Remote target')
          const completeHandshake = (data: unknown) => {
            peer.noise.read(data)
            control.send('secure.handshake', { connectionId: id, targetDeviceId: peer.id, step: 2, data: peer.noise.write() })
            clearTimeout(peer.handshakeTimeout)
          }
          if (type === 'transport.selected') {
            if (payload.transport !== 'relay') throw new Error('Unexpected DS Harness Remote path')
            peer.selected = true
            if (peer.pendingHandshake) {
              const pending = peer.pendingHandshake
              peer.pendingHandshake = undefined
              completeHandshake(pending)
            }
          } else if (type === 'secure.handshake') {
            if (payload.step !== 1 || peer.noise.ready || peer.pendingHandshake
              || typeof payload.data !== 'string' || payload.data.length > 684) throw new Error('Wrong DS Harness Remote handshake')
            if (peer.selected) completeHandshake(payload.data)
            else peer.pendingHandshake = payload.data
          } else {
            const request = parseDshSecure(peer.noise, payload)
            const respond = (result: unknown) => {
              if (!peer.lifetime.signal.aborted) control.sendSecure(id, peer.id, peer.noise, 'rpc.response', { requestId: request.id, result })
            }
            const reject = (code: string, message: string) => {
              if (!peer.lifetime.signal.aborted) control.sendSecure(id, peer.id, peer.noise, 'rpc.error', { requestId: request.id, code, message, retryable: false })
            }
            if (request.type !== 'rpc.request') throw new Error('Unexpected DS Harness Remote application message')
            if (request.payload.method === 'harness.transport.describe') {
              respond({ capabilities: ['dsh.web.v1', OMPIUI_DSH_WEB_CAPABILITY], workspaceTypes: [] })
            } else if (request.payload.method === 'dsh.web.open' || request.payload.method === 'dsh.web.close') {
              if (peer.operation) { reject('RATE_LIMITED', 'A web handoff is already in progress'); continue }
              const method = request.payload.method
              const operation = (async () => {
                await peer.lease?.close()
                peer.lease = undefined
                if (peer.lifetime.signal.aborted) return
                if (method === 'dsh.web.close') { respond({ ok: true }); return }
                const lease = new WebLease(account, path, localPort, activeOrigins, reason => {
                  if (peer.lease !== lease || peer.lifetime.signal.aborted) return
                  try { control.sendSecure(id, peer.id, peer.noise, DSH_WEB_LEASE_ENDED, { requestId: request.id, reason }) }
                  catch { void closePeer(id) }
                }, settings)
                peer.lease = lease
                const grant = await lease.open(peer.id, id, peer.lifetime.signal)
                respond(grant)
              })()
              peer.operation = operation
              void operation.catch(() => reject('TUNNEL_UNAVAILABLE', 'Could not open the authorized web tunnel'))
                .catch(() => closePeer(id)).finally(() => { peer.operation = undefined })
            } else reject('METHOD_NOT_FOUND', 'This host only supports OMPiUI web handoff')
          }
        } catch { void closePeer(id) }
      }
    }
    throw control.failure()
  } finally {
    control.close()
    await Promise.all([control.closed, ...[...peers.keys()].map(closePeer)])
  }
}
