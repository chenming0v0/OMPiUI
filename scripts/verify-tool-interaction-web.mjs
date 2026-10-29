import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'

// Attaches only to the explicitly started isolated preview fixture on port 8798.
const root = process.argv[2]
if (!root || !root.includes('transition-acceptance')) throw new Error('Pass the isolated preview fixture root')
const base = 'http://127.0.0.1:8798', token = 'isolated-tool-interaction'
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function command(type, params, sessionId) {
  const response = await fetch(`${base}/api/v1/pi/${sessionId ? `sessions/${sessionId}/commands` : 'commands'}/${type}`, { method: 'POST', headers, body: JSON.stringify(params) })
  const result = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(result))
  return result.data ?? result
}
async function wait(check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(50) }
  throw new Error(`Timeout: ${label}`)
}
async function socket(descriptor, cursor) {
  const response = await fetch(`${base}/api/v1/sessions/${descriptor.sessionId}/tool-interactions/${descriptor.executionId}/stream-ticket`, {
    method: 'POST', headers, body: JSON.stringify({ runtimeId: descriptor.runtimeId, toolCallId: descriptor.toolCallId }),
  })
  assert.equal(response.status, 200)
  const { ticket } = await response.json()
  const url = `ws://127.0.0.1:8798/api/v1/sessions/${descriptor.sessionId}/tool-interactions/${descriptor.executionId}/stream?ticket=${ticket}${cursor === undefined ? '' : `&cursor=${cursor}`}`
  const ws = new WebSocket(url, { origin: base })
  const frames = []
  let outputCursor = cursor, output = ''
  ws.on('message', data => {
    const frame = JSON.parse(String(data)); frames.push(frame)
    if (frame.type === 'output') {
      output += frame.data; outputCursor = frame.cursor
      ws.send(JSON.stringify({ type: 'output_ack', cursor: frame.cursor }))
    }
  })
  await wait(() => frames.find(frame => frame.type === 'hello'), 'stream hello')
  return { ws, frames, send: frame => ws.send(JSON.stringify(frame)), get cursor() { return outputCursor }, get output() { return output } }
}
const cwd = `${root}/workspace`
const opened = await command('session.open', { cwd })
const sessionId = opened.sessionId
assert.ok(sessionId, JSON.stringify(opened))
async function run(mode) {
  const before = new Set((await command('toolInteraction', { operation: 'list' }, sessionId)).executions.map(item => item.executionId))
  await command('prompt', { text: `PTY ${mode}` }, sessionId)
  return await wait(async () => (await command('toolInteraction', { operation: 'list' }, sessionId)).executions.find(item => !before.has(item.executionId) && (item.status === 'running' || (mode === 'nonzero' && item.status === 'exited'))), `${mode} execution`)
}
const first = await run('interactive')
const firstSocket = await socket(first)
firstSocket.send({ type: 'claim', writerId: 'web-test-writer' })
const owner = await wait(() => firstSocket.frames.find(frame => frame.type === 'lease'), 'writer lease')
await wait(() => firstSocket.output.includes('PTY_READY'), 'real TTY output')
firstSocket.send({ type: 'input', sequence: 1, data: '\x1b[B确认中文' })
await wait(() => firstSocket.frames.find(frame => frame.type === 'input_ack'), 'execution-side ACK')
const cursor = firstSocket.cursor
firstSocket.ws.terminate()
const resumed = await socket(first, cursor)
resumed.send({ type: 'claim', writerId: owner.lease.writerId, writerEpoch: owner.lease.writerEpoch })
assert.equal((await wait(() => resumed.frames.find(frame => frame.type === 'lease'), 'resumed lease')).lease.lastAcceptedSequence, 1)
resumed.send({ type: 'input', sequence: 1, data: '\x1b[B确认中文' })
await wait(() => resumed.frames.find(frame => frame.type === 'input_ack'), 'deduplicated ACK')
resumed.send({ type: 'input', sequence: 2, data: '\r' })
const exit = await wait(() => resumed.frames.find(frame => frame.type === 'exit'), 'exit tail')
assert.equal(exit.descriptor.exitCode, 0)
assert.match(resumed.output, /"arrows":1/)
console.info('PASS WebSocket ticket/auth + same-process ACK resume/dedup + original exit tail')
await wait(async () => (await command('state.get', {}, sessionId)).isSettled, 'model continued')
for (const mode of ['nonzero', 'timeout', 'cancel']) {
  const descriptor = await run(mode)
  const view = await socket(descriptor)
  if (mode === 'cancel') {
    view.send({ type: 'claim', writerId: 'cancel-writer' })
    await wait(() => view.frames.find(frame => frame.type === 'lease'), 'cancel lease')
    view.send({ type: 'cancel' })
  }
  const result = await wait(() => view.frames.find(frame => frame.type === 'exit'), `${mode} exit`)
  if (mode === 'nonzero') assert.equal(result.descriptor.exitCode, 7)
  if (mode === 'timeout') assert.equal(result.descriptor.timedOut, true)
  if (mode === 'cancel') assert.equal(result.descriptor.cancelled, true)
  await wait(async () => (await command('state.get', {}, sessionId)).isSettled, `${mode} settled`)
  console.info(`PASS WebSocket ${mode}: original execution terminal result`)
}
const starts = readFileSync(`${root}/starts.jsonl`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
assert.equal(new Set(starts.map(item => item.nonce)).size, starts.length)
console.info('PASS no duplicated command starts; preview fixture only, no account or active user session')
