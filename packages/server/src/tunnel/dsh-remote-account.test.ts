import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DSH_REMOTE_ORIGIN, DshRemoteAccount } from './dsh-remote-account.ts'

const originalTokens = {
  accessToken: 'access-token-original',
  accessTokenExpiresAt: 1,
  refreshToken: 'refresh-token-original',
  refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER,
}

const currentTokens = {
  ...originalTokens,
  accessToken: 'access-token-current',
  accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
  refreshToken: 'refresh-token-current',
}

test('uses the hosted registration API and rotates device credentials before revoking', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const origins: string[] = []
  let registeredId: string | undefined
  const account = new DshRemoteAccount(dir, '0.6.69', async (input, init) => {
    const url = new URL(String(input))
    origins.push(url.origin)
    assert.equal(init?.redirect, 'error')
    if (url.pathname.endsWith('/devices/register-with-code')) {
      assert.equal(init?.method, 'POST')
      const { v, code, device } = JSON.parse(String(init?.body))
      assert.equal(v, 1)
      assert.equal(code, 'ABCD-EFGH')
      assert.equal(device.role, 'host')
      assert.match(device.identityKey, /^[A-Za-z0-9_-]{43}$/)
      assert.equal('privateKey' in device, false)
      registeredId = device.deviceId
      return Response.json(originalTokens)
    }
    if (url.pathname.endsWith('/auth/refresh')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { deviceId: registeredId, refreshToken: originalTokens.refreshToken })
      return Response.json(currentTokens)
    }
    assert.equal(url.pathname, '/api/v1/devices/self')
    assert.equal(init?.method, 'DELETE')
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${currentTokens.accessToken}`)
    return new Response(null, { status: 204 })
  })
  assert.deepEqual(await account.register('abcdefgh'), { deviceId: registeredId })
  assert.deepEqual(await account.status(), { registered: true, deviceId: registeredId })
  const saved = JSON.parse(await readFile(join(dir, 'dsh-remote', 'host.json'), 'utf8'))
  assert.equal(saved.tokens.refreshToken, originalTokens.refreshToken)
  assert.match(saved.identity.privateKey, /^[A-Za-z0-9_-]{43}$/)
  await account.revoke()
  assert.deepEqual(await account.status(), { registered: false, deviceId: null })
  assert.deepEqual(origins, [DSH_REMOTE_ORIGIN, DSH_REMOTE_ORIGIN, DSH_REMOTE_ORIGIN])
})

test('keeps the same device key after a lost registration response and does not leak upstream error text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const identities: unknown[] = []
  const account = new DshRemoteAccount(dir, '0.6.69', async (_input, init) => {
    identities.push(JSON.parse(String(init?.body)).device)
    return identities.length === 1
      ? Response.json({ error: { code: 'HOST_REGISTRATION_CODE_CONSUMED', message: 'ABCD-EFGH' } }, { status: 409 })
      : Response.json(currentTokens)
  })
  await assert.rejects(account.register('abcd-efgh'), error => error instanceof Error
    && error.message.includes('already been used') && !error.message.includes('ABCD-EFGH'))
  assert.equal((await account.status()).registered, false)
  await account.register('IJKL-MNOP')
  assert.deepEqual(identities[0], identities[1])
})

test('recovers a stale enrollment lock without breaking a current owner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const lockPath = join(dir, 'dsh-remote', 'locks', `${createHash('sha256').update('host').digest('hex')}.lock`)
  await mkdir(lockPath, { recursive: true })
  await writeFile(join(lockPath, 'meta.json'), JSON.stringify({ pid: process.pid }))
  const account = new DshRemoteAccount(dir, '0.6.71', async () => Response.json(currentTokens))
  await assert.rejects(account.register('abcd-efgh'), { code: 'DSH_OPERATION_IN_PROGRESS' })
  const owner = t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    assert.equal(pid, 12345)
    assert.equal(signal, 0)
    throw Object.assign(new Error('owner exited'), { code: 'ESRCH' })
  })
  try {
    await writeFile(join(lockPath, 'meta.json'), JSON.stringify({ pid: 12345 }))
    assert.ok((await account.register('abcd-efgh')).deviceId)
  } finally { owner.mock.restore() }
})

test('backs up a damaged binding and allows binding again', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'dsh-remote')
  await mkdir(root)
  await writeFile(join(root, 'host.json'), '{ invalid data')
  const account = new DshRemoteAccount(dir, '0.6.71', async () => Response.json(currentTokens))
  await assert.rejects(account.status(), { code: 'DSH_STATE_UNREADABLE' })
  await account.resetUnreadable()
  const backup = (await readdir(root)).find(name => name.startsWith('host.json.invalid-'))
  assert.ok(backup)
  assert.equal(await readFile(join(root, backup), 'utf8'), '{ invalid data')
  assert.equal((await account.status()).registered, false)
  await account.register('abcd-efgh')
  await assert.rejects(account.resetUnreadable(), { code: 'DSH_RESET_NOT_REQUIRED' })
})
