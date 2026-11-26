import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { DshNoise, parseDshBrowserGrant, type DshIdentity } from '@ompiui/protocol/dsh-remote'

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
