import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DshRemoteAccount } from './dsh-remote-account.ts'
import { DshControl, dshConnectionId, dshDeviceId, parseDshSecure, verifyDshPeer } from './dsh-control.ts'
import { DshNoise, OMPIUI_DSH_WEB_CAPABILITY, parseDshBrowserGrant, requireDshOmpiuiWeb, type DshBrowserGrant } from '@ompiui/protocol/dsh-remote'
import { openDshHostc } from './dsh-hostc/index.ts'

const TUNNEL_DOMAIN = /^(?:hostc|tun|hostc-test|tun-test)\.4ba\.io$/
const TUNNEL_ID = /^[tp][abcdefghijkmnpqrstuvwxyz23456789]{11}$/
const GRANT = /^[A-Za-z0-9_-]{43}$/
const LEASE_MS = 9 * 60_000
const CHECK_MS = 15_000

class WebLease {
  private connector?: Awaited<ReturnType<typeof openDshHostc>>
  private sessionId?: string
  private readonly stop = new AbortController()
  private request?: { clientDeviceId: string; connectionId: string; requestId: string; leaseExpiresAt: number; sessionId?: string }

  constructor(private readonly account: DshRemoteAccount, private readonly path: string, private readonly localPort: number,
    private readonly activeOrigins: Set<string>) {}

  private origin?: string

  async open(clientDeviceId: string, connectionId: string, parent: AbortSignal): Promise<DshBrowserGrant> {
    const signal = AbortSignal.any([this.stop.signal, parent, AbortSignal.timeout(21_000)])
    const request = { clientDeviceId, connectionId, requestId: randomUUID(), leaseExpiresAt: Date.now() + LEASE_MS }
    this.request = request
    try {
      const data = await this.call('', signal) as {
        sessionId?: unknown; url?: unknown; connectUrl?: unknown; connectToken?: unknown; leaseExpiresAt?: unknown
      } | null
      if (typeof data?.sessionId !== 'string' || !TUNNEL_ID.test(data.sessionId)) throw new Error('Invalid DS Harness Remote allocation')
      this.sessionId = data.sessionId
      if (typeof data.url !== 'string' || typeof data.connectUrl !== 'string' || typeof data.connectToken !== 'string'
        || !GRANT.test(data.connectToken) || typeof data.leaseExpiresAt !== 'number' || !Number.isSafeInteger(data.leaseExpiresAt)
        || data.leaseExpiresAt <= Date.now() || data.leaseExpiresAt > request.leaseExpiresAt) throw new Error('Invalid DS Harness Remote allocation')
      const browserUrl = new URL(data.url)
      const connect = new URL(data.connectUrl)
      if (!TUNNEL_DOMAIN.test(connect.hostname) || browserUrl.href !== `https://${data.sessionId}.${connect.hostname}/`
        || connect.href !== `wss://${connect.hostname}/api/tunnels/${data.sessionId}/connect`) throw new Error('Invalid DS Harness Remote allocation host')
      this.request = { ...request, leaseExpiresAt: data.leaseExpiresAt }
      this.connector = await openDshHostc({
        lease: { id: data.sessionId, url: browserUrl.href, connectUrl: connect.href, token: data.connectToken },
        localPort: this.localPort,
      }, signal)
      this.origin = browserUrl.origin
      this.activeOrigins.add(browserUrl.origin)
      // The first grant is bound to the allocating connection. Never use a dial token as a grant.
      const grant = parseDshBrowserGrant(await this.call('/grant', signal))
      if (grant.url !== browserUrl.href || grant.expiresAt > data.leaseExpiresAt) throw new Error('Invalid DS Harness Remote lease grant')
      signal.throwIfAborted()
      void this.monitor(AbortSignal.any([this.stop.signal, parent]), this.connector, data.leaseExpiresAt)
      return grant
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private async call(suffix: string, signal: AbortSignal): Promise<unknown> {
    return this.account.deviceRequest(`${this.path}${suffix}`, {
      method: 'POST', body: JSON.stringify({ ...this.request, ...(suffix === '/check' ? { sessionId: this.sessionId } : {}) }), signal,
    })
  }

  private async monitor(signal: AbortSignal, connector: NonNullable<WebLease['connector']>, deadline: number): Promise<void> {
    const closeTimer = setTimeout(() => void this.close(), deadline - Date.now())
    closeTimer.unref()
    const lifetime = new AbortController()
    void connector.closed.then(() => lifetime.abort())
    const combined = AbortSignal.any([signal, lifetime.signal])
    try {
      while (!combined.aborted) {
        await delay(CHECK_MS, undefined, { signal: combined, ref: false })
        await this.call('/check', combined)
      }
    } catch { /* Close immediately on revocation, link loss or expiration. */ }
    finally { clearTimeout(closeTimer); await this.close() }
  }

  async close(): Promise<void> {
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
  activeOrigins: Set<string>, onReady?: () => void): Promise<void> {
  const { control, identity } = await DshControl.open(account, signal)
  const peers = new Map<string, Peer>()
  const path = `/api/v1/hosts/${encodeURIComponent(identity.deviceId)}/dsh-web/sessions`
  const closePeer = async (id: string) => {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id)
    peer.lifetime.abort()
    clearTimeout(peer.handshakeTimeout)
    peer.noise.destroy()
    await peer.lease?.close()
  }
  onReady?.()
  try {
    for (let message = await control.next(signal); message; message = await control.next(signal)) {
      const { type, payload } = message
      if (type === 'connect.incoming') {
        const id = dshConnectionId(payload.connectionId)
        try {
          if (payload.authorization !== 'account' || typeof payload.clientIdentityKey !== 'string'
            || !Array.isArray(payload.preferredTransports) || !payload.preferredTransports.includes('relay') || peers.size >= 8) {
            throw new Error('Connection is not authorized for Relay')
          }
          const client = dshDeviceId(payload.clientDeviceId)
          const key = await verifyDshPeer(account, 'client', client, signal, payload.clientIdentityKey)
          for (const [old, peer] of peers) if (peer.id === client || old === id) void closePeer(old)
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
        throw Object.assign(new Error('DS Harness Remote closed the host control connection'), { code: 'DSH_UNREACHABLE' })
      } else if (['error', 'transport.selected', 'secure.handshake', 'relay'].includes(type)) {
        const id = dshConnectionId(payload.connectionId)
        const peer = peers.get(id)
        if (!peer) continue
        try {
          if (type === 'error') { void closePeer(id); continue }
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
                const lease = new WebLease(account, path, localPort, activeOrigins)
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
    if (await control.closed === 4003) throw Object.assign(new Error('This DS Harness Remote host is already connected elsewhere'), { replaced: true })
  } finally {
    control.close()
    await Promise.all([...peers.keys()].map(closePeer))
  }
}
