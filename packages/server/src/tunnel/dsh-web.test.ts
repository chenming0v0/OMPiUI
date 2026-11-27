import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { DSH_CONTROL_LIMIT, DSH_RELAY_LIMIT, DshNoise, dshFrame, parseDshBrowserGrant, parseDshFrame, type DshIdentity } from '@ompiui/protocol/dsh-remote'
import { DshRemoteAccount } from './dsh-remote-account.ts'
import { runDshHost } from './dsh-host.ts'
import { openDshBrowser } from './dsh-client.ts'

function identity(): DshIdentity {
  const { privateKey } = generateKeyPairSync('x25519')
  const { d, x } = privateKey.export({ format: 'jwk' })
  assert.ok(d && x)
  return { deviceId: randomUUID(), identityKey: x, privateKey: d }
}

test('authenticates both ends of a DSH relay and rejects replay and different connection IDs', () => {
  const host = identity()
  const client = identity()
  const connection = randomUUID()
  const initiator = new DshNoise(client, host.identityKey, connection, host.deviceId, client.deviceId)
  const responder = new DshNoise(host, client.identityKey, connection, host.deviceId, client.deviceId)
  const another = new DshNoise(host, client.identityKey, randomUUID(), host.deviceId, client.deviceId)
  const first = initiator.write()
  assert.throws(() => another.read(first))
  responder.read(first)
  initiator.read(responder.write())
  assert.ok(initiator.ready && responder.ready)
  const request = initiator.send({ type: 'rpc.request' })
  assert.equal(request.counter, 0)
  assert.equal(Buffer.from(responder.receive(request.counter, request.ciphertext)).toString(), '{"type":"rpc.request"}')
  assert.throws(() => responder.receive(request.counter, request.ciphertext), /counter/)
  initiator.destroy()
  responder.destroy()
  another.destroy()
})

test('accepts only a current grant for a canonical DSH hosted origin', () => {
  const grant = { url: 'https://tabcdefghjkm.tun.4ba.io/', browserGrant: 'a'.repeat(43), expiresAt: Date.now() + 30_000 }
  assert.deepEqual(parseDshBrowserGrant(grant), grant)
  for (const url of [
    'http://tabcdefghjkm.tun.4ba.io/',
    'https://tabcdefghjkm.tun.4ba.io.attacker.invalid/',
    'https://tabcdefghjkm.tun.4ba.io/?token=not-a-grant',
    'https://tabcdefghjkm.tun.4ba.io:8443/',
  ]) assert.throws(() => parseDshBrowserGrant({ ...grant, url }), /origin/)
  assert.throws(() => parseDshBrowserGrant({ ...grant, expiresAt: Date.now() - 1 }), /grant/)
})

for (const reason of ['hostc-closed', 'check-failed', 'expired', 'explicit'] as const) {
  test(`propagates ${reason} through a live encrypted lease over relay`, { timeout: 10_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-web-'))
    await mkdir(join(dir, 'dsh-remote'))
    const host = identity()
    const client = identity()
    const tokens = {
      accessToken: 'access-token-0001', accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
      refreshToken: 'refresh-token-0001', refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER,
    }
    await Promise.all([['host', host], ['client', client]].map(([role, identity]) =>
      writeFile(join(dir, 'dsh-remote', `${role}.json`), JSON.stringify({ identity, tokens }))))
    const hostc = Promise.withResolvers<{ code: number; reason: string }>()
    const deleted = Promise.withResolvers<void>()
    const url = 'https://tabcdefghjkm.tun.4ba.io/'
    let leaseExpiresAt = 0
    let released = false
    const request: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      const peer = path.endsWith(host.deviceId) ? host : path.endsWith(client.deviceId) ? client : undefined
      if (peer) return Response.json({ role: peer === host ? 'host' : 'client', membershipId: 'test-membership', deviceId: peer.deviceId, identityKey: peer.identityKey })
      if (path.endsWith('/sessions')) {
        leaseExpiresAt = Date.now() + (reason === 'expired' ? 1_000 : 30_000)
        return Response.json({ sessionId: 'tabcdefghjkm', url, connectUrl: 'wss://tun.4ba.io/api/tunnels/tabcdefghjkm/connect', connectToken: 'b'.repeat(43), leaseExpiresAt })
      }
      if (path.endsWith('/grant')) return Response.json({ url, browserGrant: 'a'.repeat(43), expiresAt: leaseExpiresAt })
      if (path.endsWith('/check')) return Response.json({}, { status: reason === 'check-failed' ? 403 : 200 })
      assert.equal(init?.method, 'DELETE')
      released = true
      deleted.resolve()
      return new Response(null, { status: 204 })
    }
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const openSocket = () => new WebSocket(`ws://127.0.0.1:${address.port}`)
    const sockets = new Map<string, WebSocket>()
    const connectionId = randomUUID()
    const send = (role: string, type: string, payload: Record<string, unknown>) => sockets.get(role)!.send(JSON.stringify(dshFrame(type, payload)))
    server.on('connection', socket => {
      let role: string
      socket.on('message', raw => {
        const { type, payload } = parseDshFrame(raw.toString())
        if (type === 'hello') {
          role = String(payload.role)
          sockets.set(role, socket)
          send(role, 'hello.ack', { protocol: 1, capabilities: ['transport.relay'], maxControlFrameBytes: DSH_CONTROL_LIMIT, maxRelayFrameBytes: DSH_RELAY_LIMIT })
        } else if (type === 'connect.request') {
          send('host', 'connect.incoming', { connectionId, authorization: 'account', clientDeviceId: client.deviceId, clientIdentityKey: client.identityKey, preferredTransports: ['relay'] })
        } else if (type === 'connect.accepted') {
          send('client', type, { connectionId })
        } else if (['transport.selected', 'secure.handshake', 'relay'].includes(type)) {
          send(role === 'host' ? 'client' : 'host', type, payload)
        }
      })
    })
    const stop = new AbortController()
    const ready = Promise.withResolvers<void>()
    const origins = new Set<string>()
    const running = runDshHost(new DshRemoteAccount(dir, '0.6.71', request), 5000, stop.signal, origins, ready.resolve, {
      socketFactory: openSocket,
      checkMs: 50,
      openHostc: async () => ({ closed: hostc.promise, close: () => hostc.resolve({ code: 1000, reason: 'closed' }) }),
    }).catch(error => { if (!stop.signal.aborted) ready.reject(error) })
    t.after(async () => {
      stop.abort()
      for (const socket of server.clients) socket.terminate()
      await running
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    })
    await ready.promise
    const browser = await openDshBrowser(new DshRemoteAccount(dir, '0.6.71', request, 'client'), host.deviceId, stop.signal, openSocket)
    assert.equal(browser.grant.url, url)
    if (reason === 'hostc-closed') hostc.resolve({ code: 1006, reason: 'disconnected' })
    if (reason === 'explicit') {
      const releasedBeforeClose = once(sockets.get('client')!, 'close').then(() => released)
      await browser.close()
      assert.equal(await releasedBeforeClose, true)
      assert.equal(await browser.closed, undefined)
    } else assert.equal(await browser.closed, reason)
    await deleted.promise
    assert.equal(origins.size, 0)
    assert.equal(sockets.get('host')!.readyState, WebSocket.OPEN)
  })
}
