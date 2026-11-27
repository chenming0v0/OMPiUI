import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DSH_REMOTE_ORIGIN, createDshIdentity, dshPairingFingerprint, dshPairingProof, dshPairingQr,
  parseDshPairingScan, parseDshPairingSession, parseDshPairingStatus, dshControlFailure,
} from './dsh-remote.ts'

// ds-harness-remote 的 fixtures/pairing/v1/proof.json：公开的固定测试向量，不能用于真实设备。
const sessionId = '019a0000-0000-7000-8000-000000000001'
const devicePrivateKey = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA'
const serverPublicKey = 'WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns'

test('known authorization close reasons are handled even with private close codes', () => {
  assert.equal(dshControlFailure(undefined, { code: 4010, reason: 'AUTH_INVALID' }), 'AUTH_INVALID')
  assert.equal(dshControlFailure(undefined, { code: 4010, reason: 'TOKEN_EXPIRED' }), 'AUTH_INVALID')
  assert.equal(dshControlFailure(undefined, { code: 4010, reason: 'DEVICE_REVOKED' }), 'DEVICE_REVOKED')
  assert.equal(dshControlFailure(undefined, { code: 4010, reason: 'ALREADY_CONNECTED' }), 'ALREADY_CONNECTED')
  assert.equal(dshControlFailure(undefined, { code: 4010, reason: 'unknown' }), 'DSH_UNREACHABLE')
})

test('pairing proofs match the upstream interoperability vectors', () => {
  const root = `/api/v1/device-pairing/sessions/${sessionId}`
  assert.equal(dshPairingProof(devicePrivateKey, serverPublicKey, sessionId, 'host', `${root}/host/status`, '{}'),
    '91fmfY_gpU9ToA2cU13yoyRb9IdFqoqChvDUu11Befg')
  assert.equal(dshPairingProof(devicePrivateKey, serverPublicKey, sessionId, 'mobile', `${root}/mobile/status`, '{}'),
    '3izg2tEapIkukkVFqJc7cPhHHtGLUEgHzs8f_O0r-Ag')
  assert.equal(dshPairingProof(devicePrivateKey, serverPublicKey, sessionId, 'host', `${root}/host/confirm`,
    '{"submissionId":"fixed-submission-0001","verificationCode":"00123456"}'), 'G3Ujz3E507BAwAtWVyPZCN8KJNb4-sGy84ff4nLGi18')
})

function pairing() {
  const host = createDshIdentity()
  const phone = createDshIdentity()
  const hostDevice = { deviceId: host.deviceId, name: 'Desk PC', role: 'host', platform: 'win32', identityKey: host.identityKey }
  const phoneDevice = { deviceId: phone.deviceId, name: 'Phone', role: 'client', platform: 'android', identityKey: phone.identityKey }
  const created = {
    v: 1, sessionId, expiresAt: Date.now() + 180_000, serverPublicKey, scanSecret: createDshIdentity().identityKey, host: hostDevice,
  }
  const tokens = {
    accessToken: 'access-token-0001', accessTokenExpiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-token-0001', refreshTokenExpiresAt: Date.now() + 120_000,
  }
  return { host, phone, hostDevice, phoneDevice, created, tokens, session: parseDshPairingSession(created) }
}

test('a scanned short code only carries the ticket and must belong to this server', () => {
  const { session, created } = pairing()
  const short = dshPairingQr(session, true)
  assert.equal(short, `${DSH_REMOTE_ORIGIN}/pair#v1.${session.scanSecret}`)
  assert.deepEqual(parseDshPairingScan(short), { ticket: session.scanSecret })
  assert.deepEqual(parseDshPairingScan(dshPairingQr(session, false)), { session })
  assert.throws(() => parseDshPairingScan(short.replace(DSH_REMOTE_ORIGIN, 'https://example.com')))
  assert.throws(() => parseDshPairingScan(`${short}?x=1`))
  assert.throws(() => parseDshPairingScan('https://example.com/'))
  // 解析短码拿回来的会话必须就是扫到的那一张票。
  assert.throws(() => parseDshPairingSession(created, createDshIdentity().identityKey))
  assert.throws(() => parseDshPairingSession({ ...created, expiresAt: Date.now() + 60 * 60_000 }))
})

test('a pairing status is accepted only for the pinned computer, phone and own credentials', () => {
  const { host, phone, hostDevice, phoneDevice, tokens, session } = pairing()
  const status = { v: 1, sessionId, state: 'claimed', failureReason: null, host: hostDevice, mobile: phoneDevice, credentials: null }
  const claimed = parseDshPairingStatus(status, session, 'host', host)
  assert.equal(claimed.state, 'claimed')
  assert.equal(claimed.mobile?.name, 'Phone')
  assert.equal(claimed.tokens, null)

  const other = createDshIdentity()
  assert.throws(() => parseDshPairingStatus({ ...status, host: { ...hostDevice, identityKey: other.identityKey } }, session, 'host', host))
  assert.throws(() => parseDshPairingStatus({ ...status, mobile: { ...phoneDevice, identityKey: other.identityKey } }, session, 'host', host, claimed.mobile))
  assert.throws(() => parseDshPairingStatus(status, session, 'mobile', other))
  assert.throws(() => parseDshPairingStatus({ ...status, sessionId: '019a0000-0000-7000-8000-000000000002' }, session, 'host', host))

  const completed = { ...status, state: 'completed', credentials: { device: phoneDevice, tokens } }
  assert.deepEqual(parseDshPairingStatus(completed, session, 'mobile', phone).tokens, tokens)
  // 另一侧的授权不能被当成自己的收下。
  assert.throws(() => parseDshPairingStatus(completed, session, 'host', host))
  assert.equal(parseDshPairingStatus({ ...status, state: 'failed', failureReason: 'verification_failed' }, session, 'mobile', phone).failureReason,
    'verification_failed')
})

test('the fingerprint is the grouped SHA-256 of the public key', () => {
  assert.match(dshPairingFingerprint(serverPublicKey), /^(?:[\da-f]{4} ){15}[\da-f]{4}$/)
})
