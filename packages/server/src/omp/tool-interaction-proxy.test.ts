import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolInteractionProxy, toolInteractionAuthScope } from './tool-interaction-proxy.ts'
import type { SessionHost } from './session-host.ts'

const identity = { runtimeId: 'runtime', sessionId: 'session', toolCallId: 'call', executionId: 'execution' }
const descriptor = { ...identity, protocolVersion: 1 as const, status: 'running' as const, command: 'read', cwd: '/workspace', cols: 80, rows: 24, cursor: 3, oldestCursor: 0 }
function fixture() {
  const calls: Record<string, unknown>[] = []
  let writes = 0, accepted = 0
  const host = { executeSessionCommand: async (sessionId: string, type: string, params: Record<string, unknown>) => {
    assert.equal(sessionId, 'session'); assert.equal(type, 'toolInteraction'); calls.push(params)
    switch (params.operation) {
      case 'describe': return descriptor
      case 'read': return { descriptor, fromCursor: Number(params.cursor ?? 0), cursor: 3, data: Number(params.cursor ?? 0) === 3 ? '' : 'abc', reset: false }
      case 'claim': return { writerId: params.writerId, writerEpoch: 'epoch', lastAcceptedSequence: accepted, expiresAt: Date.now() + 60000 }
      case 'input': if (Number(params.sequence) > accepted) { writes++; accepted = Number(params.sequence) }; return { sequence: params.sequence, lastAcceptedSequence: accepted }
      default: return {}
    }
  } } as unknown as Pick<SessionHost, 'executeSessionCommand'>
  return { proxy: new ToolInteractionProxy(host), calls, get writes() { return writes } }
}

test('tool stream tickets are one-use and bind execution, session and auth scope', async () => {
  const f = fixture(), scope = toolInteractionAuthScope('token')
  const ticket = await f.proxy.issueTicket(identity, scope)
  assert.equal(f.proxy.consumeTicket('other', identity.executionId, ticket.ticket, scope), undefined)
  assert.equal(f.proxy.consumeTicket(identity.sessionId, identity.executionId, ticket.ticket, scope), undefined)
  const next = await f.proxy.issueTicket(identity, scope)
  const binding = f.proxy.consumeTicket(identity.sessionId, identity.executionId, next.ticket, scope)
  assert.deepEqual(binding?.identity, identity)
  assert.equal(f.proxy.consumeTicket(identity.sessionId, identity.executionId, next.ticket, scope), undefined)
  f.proxy.dispose()
})

test('proxy only acknowledges actual execution-side acceptance and view detach does not cancel', async () => {
  const f = fixture(), reader = f.proxy.attach(identity)
  const lease = await f.proxy.claim(identity, 'writer')
  assert.equal((await f.proxy.input(identity, lease, 1, '中文')).lastAcceptedSequence, 1)
  assert.equal((await f.proxy.input(identity, lease, 1, '中文')).lastAcceptedSequence, 1)
  assert.equal(f.writes, 1)
  assert.equal((await reader.read(0)).data, 'abc')
  assert.equal((await reader.read(3)).data, '')
  reader.detach()
  assert.equal(f.calls.some(call => call.operation === 'cancel'), false)
  await assert.rejects(reader.read(3), /detached/)
  f.proxy.dispose()
})
