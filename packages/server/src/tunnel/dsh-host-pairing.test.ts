import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DSH_REMOTE_ORIGIN, createDshIdentity, dshPairingProof } from '@ompiui/protocol/dsh-remote'
import { DshHostedManager } from './dsh-hosted-manager.ts'

const sessionId = '019a0000-0000-7000-8000-000000000001'
const root = `/api/v1/device-pairing/sessions/${sessionId}`
const tokens = {
  accessToken: 'access-token-0001', accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
  refreshToken: 'refresh-token-0001', refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER,
}

/** 一台只认一次验证码的假服务器，按上游协议核对每个请求的签名。 */
async function harness(t: TestContext, options: { code?: string; dropFirstConfirm?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ompiui-dsh-pairing-'))
  const server = createDshIdentity()
  const phone = createDshIdentity()
  const scanSecret = createDshIdentity().identityKey
  const expiresAt = Date.now() + 180_000
  let host: Record<string, unknown> | undefined
  let state = 'created'
  let failureReason: string | null = null
  let dropped = !options.dropFirstConfirm
  const confirms: string[] = []
  const status = () => ({
    v: 1, sessionId, state, expiresAt, recoverUntil: expiresAt + 300_000, failureReason, attemptConsumed: confirms.length > 0, submissionId: null,
    host, mobile: state === 'created' ? null : { deviceId: phone.deviceId, name: 'Pixel', role: 'client', platform: 'android', identityKey: phone.identityKey },
    credentials: state === 'completed' ? { account: 'dsh-device:x', accountKind: 'device_only', device: host, inboundOnly: true, pairingRestricted: true, tokens } : null,
  })
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, DSH_REMOTE_ORIGIN)
    const body = typeof init?.body === 'string' ? init.body : ''
    if (url.pathname === '/api/v1/auth/oauth/providers') {
      return Response.json({ capabilities: { devicePairing: 'dsh-pairing-v1', devicePairingQr: 'fragment-ticket-v1' }, items: [] })
    }
    if (url.pathname === '/api/v1/device-pairing/sessions') {
      host = JSON.parse(body).device
      assert.equal(host?.role, 'host')
      assert.equal('privateKey' in host!, false)
      return Response.json({ v: 1, sessionId, expiresAt, serverPublicKey: server.identityKey, scanSecret, host })
    }
    assert.equal(new Headers(init?.headers).get('x-dsh-pairing-proof'),
      dshPairingProof(server.privateKey, String(host?.identityKey), sessionId, 'host', url.pathname, body))
    if (url.pathname === `${root}/host/confirm`) {
      confirms.push(body)
      if (state === 'claimed') {
        const ok = JSON.parse(body).verificationCode === (options.code ?? '00123456')
        // 丢回复的那一次停在“验证码已通过、登记未完成”，要靠原样重发才能走完。
        state = !ok ? 'failed' : options.dropFirstConfirm ? 'approved' : 'completed'
        failureReason = ok ? null : 'verification_failed'
      } else if (state === 'approved') state = 'completed'
      if (!dropped) { dropped = true; throw new TypeError('socket closed') }
    } else if (url.pathname === `${root}/host/cancel`) {
      state = 'cancelled'
    } else assert.equal(url.pathname, `${root}/host/status`)
    return Response.json(status())
  }
  const manager = new DshHostedManager(dir, '0.6.74', false, async (_account, _port, signal, _origins, onReady) => {
    onReady?.()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }, request, 10)
  t.after(async () => { await manager.dispose(); await rm(dir, { recursive: true, force: true }) })
  await manager.attach(5000)
  const until = async (check: (status: Awaited<ReturnType<DshHostedManager['status']>>) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await manager.status()
      if (check(current)) return current
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Timed out waiting for the pairing state')
  }
  return { dir, manager, until, scanSecret, confirms, claim: () => { state = 'claimed' } }
}

test('pairs a phone by QR code and opens remote access once the code is confirmed here', async t => {
  const { dir, manager, until, scanSecret, confirms, claim } = await harness(t)
  await manager.manage('pair')
  const shown = await manager.status()
  assert.equal(shown.registered, false)
  assert.equal(shown.pairing?.state, 'created')
  assert.equal(shown.pairing?.qr, `${DSH_REMOTE_ORIGIN}/pair#v1.${scanSecret}`)
  // 手机还没扫码时不接受验证码。
  await assert.rejects(manager.manage('pair-confirm', '00123456'), (error: { code?: string }) => error.code === 'DSH_PAIRING_CODE_INVALID')

  claim()
  const claimed = await until(status => status.pairing?.state === 'claimed')
  assert.equal(claimed.pairing?.phone?.name, 'Pixel')
  assert.equal(claimed.pairing?.qr, undefined)
  await assert.rejects(manager.manage('pair-confirm', '1234'), (error: { code?: string }) => error.code === 'DSH_PAIRING_CODE_INVALID')

  await manager.manage('pair-confirm', '00123456')
  const paired = await until(status => status.state === 'online')
  assert.equal(paired.registered, true)
  assert.equal(paired.enabled, true)
  assert.equal(paired.pairing?.state, 'completed')
  assert.equal(confirms.length, 1)
  const saved = await readFile(join(dir, 'dsh-remote', 'host.json'), 'utf8')
  assert.equal(JSON.parse(saved).tokens.refreshToken, tokens.refreshToken)
  assert.equal(saved.includes('00123456'), false)

  await manager.manage('pair-cancel')
  assert.equal((await manager.status()).pairing, null)
})

test('a wrong code ends the pairing instead of allowing another guess', async t => {
  const { manager, until, claim } = await harness(t)
  await manager.manage('pair')
  claim()
  await until(status => status.pairing?.state === 'claimed')
  await manager.manage('pair-confirm', '99999999')
  const failed = await manager.status()
  assert.equal(failed.pairing?.state, 'failed')
  assert.equal(failed.pairing?.failure, 'verification_failed')
  assert.equal(failed.registered, false)
  assert.equal(failed.enabled, false)
  await assert.rejects(manager.manage('pair-confirm', '00123456'), (error: { code?: string }) => error.code === 'DSH_PAIRING_CLOSED')
})

test('an unknown confirm result can only be retried with the same request', async t => {
  const { manager, until, confirms, claim } = await harness(t, { dropFirstConfirm: true })
  await manager.manage('pair')
  claim()
  await until(status => status.pairing?.state === 'claimed')
  await assert.rejects(manager.manage('pair-confirm', '00123456'), (error: { code?: string }) => error.code === 'DSH_UNREACHABLE')
  await assert.rejects(manager.manage('pair-confirm', '11111111'), (error: { code?: string }) => error.code === 'DSH_PAIRING_ATTEMPT_USED')
  // 后台会把同一份请求原样重发，直到登记完成；发出去的不能是第二个码。
  await until(status => status.pairing?.state === 'completed')
  assert.ok(confirms.length >= 2)
  assert.equal(new Set(confirms).size, 1)
  assert.equal((await until(status => status.state === 'online')).registered, true)
})
