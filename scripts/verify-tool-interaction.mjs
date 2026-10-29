import assert from 'node:assert/strict'
import path from 'node:path'
import { createToolInteractionFixture } from './tool-interaction-fixture.mjs'

const fixture = await createToolInteractionFixture(process.argv[2] ?? '.slim/issue-repair-native-runtime')
process.env.OMPIUI_DRIVER = 'omp'
const { OmpRpcSession } = await import('../packages/omp-worker/src/omp/omp-session.ts')
let session
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(50) }
  throw new Error(`Timeout: ${label}`)
}
try {
  session = await OmpRpcSession.open(fixture.cwd)
  const snapshot = await session.toolInteraction({ operation: 'list' })
  assert.equal(snapshot.available, true, JSON.stringify(snapshot))
  const events = []
  session.onPiEvent(event => events.push(event))
  await session.prompt('PTY interactive')
  const execution = await wait(async () => (await session.toolInteraction({ operation: 'list' })).executions.find(item => item.status === 'running'), 'native PTY running')
  const identity = Object.fromEntries(['runtimeId', 'sessionId', 'toolCallId', 'executionId'].map(key => [key, execution[key]]))
  const owner = await session.toolInteraction({ operation: 'claim', ...identity, writerId: 'acceptance-writer' })
  const lease = { writerId: owner.writerId, writerEpoch: owner.writerEpoch }
  await session.toolInteraction({ operation: 'resize', ...identity, ...lease, cols: 101, rows: 37 })
  await wait(async () => (await session.toolInteraction({ operation: 'read', ...identity })).data.includes('PTY_READY'), 'TTY child ready')
  const first = { operation: 'input', ...identity, ...lease, sequence: 1, data: '\x1b[B确认中文' }
  assert.equal((await session.toolInteraction(first)).lastAcceptedSequence, 1)
  assert.equal((await session.toolInteraction(first)).lastAcceptedSequence, 1)
  await assert.rejects(session.toolInteraction({ ...first, data: 'different' }), /different data/)
  const resumed = await session.toolInteraction({ operation: 'claim', ...identity, ...lease })
  assert.equal(resumed.lastAcceptedSequence, 1)
  await session.toolInteraction({ operation: 'input', ...identity, ...lease, sequence: 2, data: '\r' })
  await session.waitForIdle()
  const read = await session.toolInteraction({ operation: 'read', ...identity })
  assert.equal(read.descriptor.status, 'exited')
  assert.equal(read.descriptor.exitCode, 0)
  assert.match(read.data, /"stdinTTY":true/)
  assert.match(read.data, /"stdoutTTY":true/)
  assert.match(read.data, /确认中文/)
  assert.match(read.data, /"arrows":1/)
  assert.equal(fixture.starts().length, 1)
  const result = events.find(event => event.type === 'tool_execution_end' && event.toolCallId === execution.toolCallId)
  assert.ok(result, 'original tool call ended')
  assert.equal(result.result.details.toolInteraction.executionId, execution.executionId)
  assert.ok(fixture.results.some(item => item.toolResult.tool_call_id === execution.toolCallId), 'provider received the same original tool result')
  console.info('PASS real tool PTY: original call, one process, Chinese/Enter/arrows/resize, ACK dedup/resume, original model continuation')
  fixture.save('acceptance.json', { execution, descriptor: read.descriptor, starts: fixture.starts(), toolCallId: execution.toolCallId })
  console.info(`TOOL_INTERACTION_ARTIFACTS ${path.resolve(fixture.root)}`)
} catch (error) {
  console.error(`TOOL_INTERACTION_FAILURE ${fixture.root}`);
  if (session) console.error(JSON.stringify(await session.getState()));
  console.error(JSON.stringify(fixture.results));
  throw error;
} finally {
  await session?.dispose()
  await fixture.close()
}
