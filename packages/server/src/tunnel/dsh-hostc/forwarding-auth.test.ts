import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { EVENT_WS_SUBPROTOCOL, PROTOCOL_VERSION } from '@ompiui/protocol'
import { TERMINAL_SECRET_HEADER } from '../../host/terminal-auth.ts'
import { decodeHead, encodeText, FrameType, type HeaderList } from './protocol/index.ts'
import { forwardingFixture, LOCAL_TOKEN, PUBLIC_HOST, PUBLIC_ORIGIN } from './forwarding-test-support.ts'

const HEALTH = '/api/v1/host/health'
const EVENTS = '/api/v1/events'
const terminalSecret = 'ab'.repeat(32)
const clientHeaders: HeaderList = [
  ['Host', 'client-controlled.invalid'], ['Origin', PUBLIC_ORIGIN],
  ['Cookie', 'remote_session=authorized-client'], ['Authorization', 'Bearer foreign-client-token'],
  [TERMINAL_SECRET_HEADER, terminalSecret], ['X-OmPiUi-Internal-Tunnel', 'forged-marker'],
  ['X-Forwarded-Host', 'client-controlled.invalid'],
]

function assertNoCredentialReturned(fixture: Awaited<ReturnType<typeof forwardingFixture>>): void {
  for (const frame of fixture.returned) assert.ok(!Buffer.from(frame.payload).toString().includes(LOCAL_TOKEN))
  assert.ok(!JSON.stringify(fixture.hooks).includes(LOCAL_TOKEN))
}

async function deniedEvents(port: number, headers: Record<string, string>): Promise<number> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${EVENTS}`, EVENT_WS_SUBPROTOCOL, { headers, handshakeTimeout: 5_000 })
  return new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.once('open', () => { socket.terminate(); reject(new Error('Unauthenticated events connection opened')) })
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0)
      response.destroy()
      socket.terminate()
    })
  })
}

test('forwards authenticated health and events while direct requests still require the local token', { timeout: 15_000 }, async t => {
  const fixture = await forwardingFixture(t)
  const { port, http, open, next, send, observed } = fixture
  for (const headers of [{}, { authorization: 'Bearer foreign-client-token' }, {
    host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, cookie: 'remote_session=authorized-client',
    'x-ompiui-internal-tunnel': 'forged-marker', 'x-dsh-web-authorized': 'true',
  }] as Record<string, string>[]) {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH}`, { headers, signal: AbortSignal.timeout(5_000) })
    assert.equal(response.status, 401)
    assert.ok(!(await response.text()).includes(LOCAL_TOKEN))
    assert.equal(await deniedEvents(port, headers), 403)
  }
  observed.length = 0
  // 手机只持有隧道 Cookie；同时覆盖夹带外来 Bearer 时必须覆盖而非沿用的情形。
  for (const headers of [clientHeaders.filter(([name]) => name !== 'Authorization'), clientHeaders]) {
    const response = await http(HEALTH, headers)
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.text).service, 'ompiui-server')
    const stream = open(EVENTS, headers, [EVENT_WS_SUBPROTOCOL])
    const head = decodeHead((await next(stream, FrameType.Head)).payload)
    assert.equal(head.status, 101)
    assert.equal(head.protocol, EVENT_WS_SUBPROTOCOL)
    assert.equal(JSON.parse(Buffer.from((await next(stream, FrameType.Text)).payload).toString()).type, 'hello')
    send(stream, FrameType.Text, encodeText(JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION })))
    assert.equal(JSON.parse(Buffer.from((await next(stream, FrameType.Text)).payload).toString()).type, 'pong')
    send(stream, FrameType.Reset)
  }
  assert.equal(observed.length, 4)
  for (const { headers } of observed) {
    assert.equal(headers.authorization, `Bearer ${LOCAL_TOKEN}`)
    assert.equal(headers.cookie, undefined)
    assert.equal(headers.host, PUBLIC_HOST)
    assert.equal(headers.origin, PUBLIC_ORIGIN)
    assert.equal(headers[TERMINAL_SECRET_HEADER], terminalSecret)
    assert.equal(headers['x-ompiui-internal-tunnel'], undefined)
    assert.equal(headers['x-forwarded-host'], undefined)
  }
  assertNoCredentialReturned(fixture)
})

test('blocks cross-origin, rejected admission and credential-export routes before the local hop', { timeout: 15_000 }, async t => {
  const fixture = await forwardingFixture(t)
  const { http, open, next, observed, admission } = fixture
  for (const path of ['/__remote/session', '/api/v1/host/dsh-remote', '/api/v1/host/share',
    '/api/v1/host/%73hare', '/api/v1/host/pair/invite', '/api/v1/host/pair/redeem']) {
    assert.equal((await http(path, clientHeaders)).status, 403)
  }
  assert.equal((await http('/api/v1/host/pair/redeem', clientHeaders, { code: '123456' })).status, 403)
  for (const origin of ['https://attacker.invalid', 'null']) {
    const headers = clientHeaders.map(([name, value]): [string, string] => [name, name === 'Origin' ? origin : value])
    assert.equal((await http(HEALTH, headers)).status, 403)
    assert.equal(decodeHead((await next(open(EVENTS, headers, []), FrameType.Head)).payload).status, 403)
  }
  const hiddenOrigin: HeaderList = [['origin', 'https://attacker.invalid'], ['connection', 'origin']]
  assert.equal((await http(HEALTH, hiddenOrigin)).status, 403)
  admission.allowed = false
  assert.equal((await http(HEALTH, clientHeaders)).status, 403)
  assert.equal(decodeHead((await next(open(EVENTS, clientHeaders, []), FrameType.Head)).payload).status, 403)
  assert.equal(observed.length, 0)
  assertNoCredentialReturned(fixture)
})

test('omitting the optional host credential cannot reuse client authorization', { timeout: 15_000 }, async t => {
  const fixture = await forwardingFixture(t, {})
  // 即使客户端夹带恰好有效的本机 Bearer，也必须清理，不能作为缺失配置的后备。
  const headers = clientHeaders.map(([name, value]): [string, string] =>
    [name, name === 'Authorization' ? `Bearer ${LOCAL_TOKEN}` : value])
  assert.equal((await fixture.http(HEALTH, headers)).status, 401)
  const stream = fixture.open(EVENTS, headers, [EVENT_WS_SUBPROTOCOL])
  assert.equal(decodeHead((await fixture.next(stream, FrameType.Head)).payload).status, 403)
  for (const request of fixture.observed) {
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers.cookie, undefined)
  }
  assertNoCredentialReturned(fixture)
})

test('preserves terminal ownership and requires a valid single-use ticket through the tunnel', { timeout: 15_000 }, async t => {
  const fixture = await forwardingFixture(t)
  const headers: HeaderList = [...clientHeaders, ['content-type', 'application/json']]
  const created = await fixture.http('/api/v1/host/commands/terminals.create', headers, { workspacePath: fixture.directory })
  assert.equal(created.status, 200)
  const terminalId = JSON.parse(created.text).data.id as string
  assert.ok(terminalId)
  const response = await fixture.http('/api/v1/host/commands/terminals.connectToken', headers,
    { workspacePath: fixture.directory, terminalId })
  assert.equal(response.status, 200)
  const ticket = JSON.parse(response.text).data.token as string
  assert.ok(ticket)
  const base = `/api/v1/host/terminals/${terminalId}/stream`
  for (const suffix of ['', '?ticket=invalid']) {
    const rejected = fixture.open(base + suffix, headers, [])
    assert.equal(decodeHead((await fixture.next(rejected, FrameType.Head)).payload).status, 403)
  }
  const stream = fixture.open(`${base}?ticket=${ticket}&cursor=0`, headers, [])
  assert.equal(decodeHead((await fixture.next(stream, FrameType.Head)).payload).status, 101)
  const hello = JSON.parse(Buffer.from((await fixture.next(stream, FrameType.Text)).payload).toString())
  assert.equal(hello.type, 'hello')
  assert.equal(hello.terminal.id, terminalId)
  const replay = fixture.open(`${base}?ticket=${ticket}`, headers, [])
  assert.equal(decodeHead((await fixture.next(replay, FrameType.Head)).payload).status, 403)
  fixture.send(stream, FrameType.Reset)
  assertNoCredentialReturned(fixture)
})
