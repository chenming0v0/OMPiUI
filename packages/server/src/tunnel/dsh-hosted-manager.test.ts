import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { DSH_CONTROL_LIMIT, DSH_RELAY_LIMIT, dshFrame, parseDshFrame } from '@ompiui/protocol/dsh-remote'
import { DshRemoteAccount } from './dsh-remote-account.ts'
import { runDshHost } from './dsh-host.ts'
import {
  DshHostedManager, deriveDshHostState, dshHostFailure, isTerminalDshHostFailure,
} from './dsh-hosted-manager.ts'

const deviceId = '7c1d3e5f-2a4b-4c6d-8e0f-1a3b5c7d9e22'
const key = 'A'.repeat(43)

async function enrollment(dir: string): Promise<void> {
  await mkdir(join(dir, 'dsh-remote'), { recursive: true })
  await writeFile(join(dir, 'dsh-remote', 'host.json'), JSON.stringify({
    identity: { deviceId, identityKey: key, privateKey: key },
    tokens: {
      accessToken: 'access-token-0001', accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
      refreshToken: 'refresh-token-0001', refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER,
    },
  }))
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the DS Harness Remote host state')
}

test('derives the host state from enrollment, enablement and the last failure', () => {
  const idle = { registered: true, enabled: false, online: false, stopped: false, lastError: null }
  assert.equal(deriveDshHostState({ ...idle, registered: false }), 'unregistered')
  assert.equal(deriveDshHostState({ ...idle, enabled: true }), 'connecting')
  assert.equal(deriveDshHostState({ ...idle, enabled: true, online: true }), 'online')
  assert.equal(deriveDshHostState(idle), 'disabled')
  assert.equal(deriveDshHostState({ ...idle, stopped: true }), 'stopped')
  assert.equal(deriveDshHostState({ ...idle, lastError: { code: 'DSH_UNREACHABLE', message: 'offline' } }), 'error')
  // An explicit stop wins over a previous failure.
  assert.equal(deriveDshHostState({ ...idle, stopped: true, lastError: { code: 'DSH_UNREACHABLE', message: 'offline' } }), 'stopped')
})

test('maps runtime failures to status codes and marks authorization failures terminal', () => {
  assert.deepEqual(dshHostFailure(Object.assign(new Error('elsewhere'), { replaced: true })), {
    code: 'DSH_ALREADY_CONNECTED', message: 'This DS Harness Remote host is already connected elsewhere',
  })
  assert.equal(dshHostFailure(Object.assign(new Error('auth'), { code: 'AUTH_INVALID' })).code, 'DSH_AUTH_INVALID')
  assert.equal(dshHostFailure(Object.assign(new Error('revoked'), { code: 'DEVICE_REVOKED' })).code, 'DSH_DEVICE_REVOKED')
  assert.equal(dshHostFailure(Object.assign(new Error('network'), { code: 'DSH_UNREACHABLE' })).code, 'DSH_UNREACHABLE')
  assert.equal(dshHostFailure(new Error('socket closed')).code, 'DSH_UNREACHABLE')
  assert.equal(dshHostFailure(Object.assign(new Error('odd'), { code: 'PROTOCOL' })).code, 'DSH_HOST_ERROR')

  for (const code of ['DSH_ALREADY_CONNECTED', 'DSH_AUTH_INVALID', 'DSH_DEVICE_REVOKED']) {
    assert.equal(isTerminalDshHostFailure({ code, message: '' }), true)
  }
  assert.equal(isTerminalDshHostFailure({ code: 'DSH_UNREACHABLE', message: '' }), false)
})

test('reports availability against the listener address', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
  const manager = new DshHostedManager(dir, '0.6.69', false)
  t.after(async () => { await manager.dispose(); await rm(dir, { recursive: true, force: true }) })

  const before = await manager.status()
  assert.equal(before.available, false)
  assert.equal(before.reason, 'web')
  assert.equal(before.state, 'unregistered')

  await manager.attach(5000, '192.168.1.20')
  const status = await manager.status()
  assert.equal(status.available, false)
  assert.equal(status.reason, 'loopback')
  await assert.rejects(manager.manage('enable'), (error: { code?: string }) => error.code === 'DSH_LOOPBACK_REQUIRED')
})

test('clears the persisted enabled flag after a terminal failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
  await enrollment(dir)
  const manager = new DshHostedManager(dir, '0.6.69', true, async () => {
    throw Object.assign(new Error('This DS Harness Remote host is already connected elsewhere'), { replaced: true })
  })
  t.after(async () => { await manager.dispose(); await rm(dir, { recursive: true, force: true }) })

  await manager.attach(5000)
  await until(async () => (await manager.status()).state === 'error')
  const status = await manager.status()
  assert.equal(status.enabled, false)
  assert.equal(status.registered, true)
  assert.deepEqual(status.lastError, {
    code: 'DSH_ALREADY_CONNECTED', message: 'This DS Harness Remote host is already connected elsewhere',
  })
  assert.equal(await readFile(join(dir, 'dsh-remote', 'enabled.json'), 'utf8'), 'false')
})

test('goes online once the host control connection is ready', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
  await enrollment(dir)
  const manager = new DshHostedManager(dir, '0.6.69', false, async (_account, _port, signal, _origins, onReady) => {
    onReady?.()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  t.after(async () => { await manager.dispose(); await rm(dir, { recursive: true, force: true }) })

  await manager.attach(5000)
  assert.equal((await manager.status()).state, 'disabled')
  await manager.manage('enable')
  await until(async () => (await manager.status()).state === 'online')
  assert.equal((await manager.status()).enabled, true)
  await manager.manage('disable')
  assert.equal((await manager.status()).state, 'stopped')
})

test('keeps retrying a network failure without clearing enablement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
  await enrollment(dir)
  const manager = new DshHostedManager(dir, '0.6.69', true, async () => {
    throw Object.assign(new Error('DS Harness Remote control socket could not open'), { code: 'DSH_UNREACHABLE' })
  })
  t.after(async () => { await manager.dispose(); await rm(dir, { recursive: true, force: true }) })

  await manager.attach(5000)
  await until(async () => (await manager.status()).lastError?.code === 'DSH_UNREACHABLE')
  const status = await manager.status()
  assert.equal(status.enabled, true)
  assert.equal(status.state, 'connecting')
})

test('passes the local credential to the host without publishing or persisting it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-auth-'))
  await enrollment(dir)
  const authToken = 'local-manager-credential'
  const received = Promise.withResolvers<Parameters<typeof runDshHost>[5]>()
  const manager = new DshHostedManager(dir, '0.6.78', true, async (_account, _port, signal, _origins, ready, options) => {
    received.resolve(options)
    ready?.()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }, undefined, undefined, authToken)
  t.after(async () => { await manager.dispose(); await rm(dir, { recursive: true, force: true }) })
  await manager.attach(5000)
  assert.equal((await received.promise)?.authToken, authToken)
  assert.equal((await manager.status()).state, 'online')
  assert.ok(!JSON.stringify(await manager.status()).includes(authToken))
  await manager.manage('disable')
  assert.equal(await readFile(join(dir, 'dsh-remote', 'enabled.json'), 'utf8'), 'false')
  assert.ok(!(await readFile(join(dir, 'dsh-remote', 'host.json'), 'utf8')).includes(authToken))
})

async function wireServer(onHello: (socket: WebSocket, accessToken: unknown) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  server.on('connection', socket => socket.once('message', raw => {
    const hello = parseDshFrame(raw.toString())
    assert.equal(hello.type, 'hello')
    onHello(socket, hello.payload.accessToken)
  }))
  return {
    open: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
    close: async () => {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function helloAck(socket: WebSocket): void {
  socket.send(JSON.stringify(dshFrame('hello.ack', {
    protocol: 1, capabilities: ['transport.relay'], maxControlFrameBytes: DSH_CONTROL_LIMIT, maxRelayFrameBytes: DSH_RELAY_LIMIT,
  })))
}

for (const mode of ['close 4004', 'error DEVICE_REVOKED', 'error frame then close 4004'] as const) {
  test(`stops and persists revocation on live control ${mode}`, { timeout: 5_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
    await enrollment(dir)
    const wire = await wireServer(socket => {
      helloAck(socket)
      if (mode === 'error DEVICE_REVOKED') socket.send(JSON.stringify(dshFrame('error', { code: 'DEVICE_REVOKED' })))
      else if (mode === 'error frame then close 4004') {
        socket.send(JSON.stringify(dshFrame('error', { code: 'DEVICE_REVOKED' })))
        socket.close(4004, 'device revoked')
      } else socket.close(4004, 'device revoked')
    })
    let runs = 0
    const manager = new DshHostedManager(dir, '0.6.71', true, (account, port, signal, origins, ready) => {
      runs++
      return runDshHost(account, port, signal, origins, ready, { socketFactory: wire.open })
    })
    t.after(async () => { await manager.dispose(); await wire.close(); await rm(dir, { recursive: true, force: true }) })
    await manager.attach(5000)
    await until(async () => (await manager.status()).lastError?.code === 'DSH_DEVICE_REVOKED')
    assert.equal((await manager.status()).enabled, false)
    assert.equal(await readFile(join(dir, 'dsh-remote', 'enabled.json'), 'utf8'), 'false')
    assert.equal(runs, 1)
  })
}

test('refreshes only once on two on-wire authentication denials', { timeout: 5_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
  await enrollment(dir)
  const seen: unknown[] = []
  const wire = await wireServer((socket, token) => {
    seen.push(token)
    if (seen.length === 1) socket.close(4002, 'TOKEN_EXPIRED')
    else socket.send(JSON.stringify(dshFrame('error', { code: 'AUTH_INVALID' })))
  })
  t.after(async () => { await wire.close(); await rm(dir, { recursive: true, force: true }) })
  let refreshes = 0
  const account = new DshRemoteAccount(dir, '0.6.71', async url => {
    assert.equal(new URL(String(url)).pathname, '/api/v1/auth/refresh')
    refreshes++
    return Response.json({
      accessToken: 'access-token-0002', refreshToken: 'refresh-token-0002',
      accessTokenExpiresAt: Number.MAX_SAFE_INTEGER, refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER,
    })
  })
  await assert.rejects(runDshHost(account, 5000, AbortSignal.timeout(4_000), new Set(), undefined, { socketFactory: wire.open }), { code: 'AUTH_INVALID' })
  assert.deepEqual(seen, ['access-token-0001', 'access-token-0002'])
  assert.equal(refreshes, 1)
})

test('4001 and ordinary server shutdown do not refresh or invalidate host credentials', { timeout: 5_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
  await enrollment(dir)
  const codes = [4001, 1001]
  const wire = await wireServer(socket => socket.close(codes.shift()!, 'server shutdown'))
  t.after(async () => { await wire.close(); await rm(dir, { recursive: true, force: true }) })
  const account = new DshRemoteAccount(dir, '0.6.71', async () => assert.fail('unexpected credential refresh'))
  for (const _ of [4001, 1001]) {
    await assert.rejects(runDshHost(account, 5000, AbortSignal.timeout(2_000), new Set(), undefined, { socketFactory: wire.open }), { code: 'DSH_UNREACHABLE' })
  }
  assert.equal(codes.length, 0)
})

test('persists explicit disable through an in-flight terminal close and restarts once enabled', { timeout: 5_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
  await enrollment(dir)
  let connections = 0
  const wire = await wireServer(socket => {
    helloAck(socket)
    if (++connections === 1) socket.close(4003, 'ALREADY_CONNECTED')
  })
  const exited = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let oldTaskRunning = true
  let runs = 0
  const manager = new DshHostedManager(dir, '0.6.71', true, async (account, port, signal, origins, ready) => {
    const run = ++runs
    if (run > 1) assert.equal(oldTaskRunning, false)
    try { await runDshHost(account, port, signal, origins, ready, { socketFactory: wire.open }) }
    catch (error) {
      if (run === 1) {
        exited.resolve()
        await release.promise
        oldTaskRunning = false
      }
      throw error
    }
  })
  t.after(async () => { release.resolve(); await manager.dispose(); await wire.close(); await rm(dir, { recursive: true, force: true }) })
  await manager.attach(5000)
  await exited.promise
  // Interleave a user enable with the terminal socket's cleanup.
  const enabling = manager.manage('enable')
  release.resolve()
  await enabling
  await until(async () => (await manager.status()).state === 'online')
  assert.equal(await readFile(join(dir, 'dsh-remote', 'enabled.json'), 'utf8'), 'true')
  assert.equal(connections, 2)
  const disabling = manager.manage('disable')
  const restarting = manager.manage('enable')
  await Promise.all([disabling, restarting])
  await until(async () => (await manager.status()).state === 'online')
  assert.equal(connections, 3)
})

test('exposes terminal persistence failure instead of reporting a saved terminal state', { timeout: 5_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-manager-'))
  await enrollment(dir)
  const manager = new DshHostedManager(dir, '0.6.71', true, async () => {
    // Let attach read a missing state file; then make the write target unusable.
    await mkdir(join(dir, 'dsh-remote', 'enabled.json'))
    throw Object.assign(new Error('revoked'), { code: 'DEVICE_REVOKED' })
  })
  t.after(async () => {
    await rm(join(dir, 'dsh-remote', 'enabled.json'), { recursive: true, force: true })
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await manager.attach(5000)
  await until(async () => (await manager.status()).lastError?.code === 'DSH_STATE_WRITE_FAILED')
  assert.equal((await manager.status()).enabled, false)
  await assert.rejects(manager.manage('enable'), { code: 'DSH_STATE_WRITE_FAILED' })
})
