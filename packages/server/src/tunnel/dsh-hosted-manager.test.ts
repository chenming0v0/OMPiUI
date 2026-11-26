import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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
