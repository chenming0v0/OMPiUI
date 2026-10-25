import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OmpRpcSession } from '../packages/omp-worker/src/omp/omp-session.ts'

// Real official runtime, loopback model and isolated native configuration/history.
const root = mkdtempSync(path.join(tmpdir(), 'ompiui-stop-queue-'))
const agent = path.join(root, 'agent'), cwd = path.join(root, 'workspace')
mkdirSync(agent); mkdirSync(cwd)
process.env.PI_CODING_AGENT_DIR = agent
process.env.OMPIUI_DATA_DIR = path.join(root, 'webui')
for (const key of ['OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_SESSION_DIR', 'PI_CONFIG_FILES']) delete process.env[key]
const streams = []
const waiters = new Set()
const endpoint = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk
  const input = JSON.parse(body), index = streams.length + 1
  streams.push({ response, input, index })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ id: `fixture-${index}`, object: 'chat.completion.chunk', created: 1, model: 'offline', choices: [{index: 0, delta: {role: 'assistant', content: `RUN_${index}`}, finish_reason: null}] })}\n\n`)
  for (const waiter of [...waiters]) waiter()
})
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve))
writeFileSync(path.join(agent, 'models.yml'), `providers:\n  fixture:\n    baseUrl: http://127.0.0.1:${endpoint.address().port}/v1\n    apiKey: sk-fixture\n    api: openai-completions\n    models:\n      - id: offline\n        name: Offline\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 8192\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`)
writeFileSync(path.join(agent, 'config.yml'), 'modelRoles:\n  default: fixture/offline\nasync:\n  enabled: false\ntitle:\n  enabled: false\n')
const waitRequest = count => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { waiters.delete(check); reject(Error(`Waiting for request ${count}; got ${streams.length}`)) }, 10000)
  const check = () => { if(streams.length < count) return; clearTimeout(timer); waiters.delete(check); resolve() }
  waiters.add(check); check()
})
const finish = index => {
  const { response } = streams[index - 1]
  response.write(`data: ${JSON.stringify({ id: `fixture-${index}`, object: 'chat.completion.chunk', created: 1, model: 'offline', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1,total_tokens:2} })}\n\n`)
  response.end('data: [DONE]\n\n')
}
const texts = input => input.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
let session
try {
  session = await OmpRpcSession.open(cwd)
  await session.sendUserMessage('start')
  await waitRequest(1)
  await session.sendUserMessage('queued first', undefined, 'followUp')
  await session.sendUserMessage('queued second', undefined, 'followUp')
  const queued = await session.getState()
  assert.deepEqual(queued.queue.followUp, ['queued first', 'queued second'])
  finish(1)
  await waitRequest(2)
  assert.deepEqual(texts(streams[1].input).filter(text => text.startsWith('queued ')), ['queued first', 'queued second'])

  await session.sendUserMessage('promoted first', undefined, 'followUp')
  await session.sendUserMessage('promoted second', undefined, 'followUp')
  let state = await session.getState()
  await session.sendQueuedMessage('followUp', 0, state.queue.followUpEntries[0].entryId)
  state = await session.getState()
  await session.sendQueuedMessage('followUp', 0, state.queue.followUpEntries[0].entryId)
  state = await session.getState()
  assert.deepEqual(state.queue.steering, ['promoted first', 'promoted second'])
  finish(2)
  await waitRequest(3)
  assert.deepEqual(texts(streams[2].input).filter(text => text.startsWith('promoted ')), ['promoted first', 'promoted second'])
  const page = await session.getEntriesPage(undefined, 100, 1024 * 1024)
  const history = page.items.filter(entry => entry.message?.role === 'user').map(entry => typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  assert.deepEqual(history.filter(text => /^(queued|promoted) /.test(text)), ['queued first', 'queued second', 'promoted first', 'promoted second'])

  await session.sendUserMessage('retained steer', undefined, 'steer')
  await session.sendUserMessage('retained follow-up', undefined, 'followUp')
  const before = await session.getState(), count = streams.length
  await session.abort()
  // Cover the official/GUI 800ms goal continuation window, not just abort ACK.
  await new Promise(resolve => setTimeout(resolve, 1200))
  const after = await session.getState()
  assert.equal(streams.length, count, 'Stop restarted a queued turn')
  assert.equal(after.isStreaming, false)
  assert.deepEqual(after.queue.steeringEntries, before.queue.steeringEntries)
  assert.deepEqual(after.queue.followUpEntries, before.queue.followUpEntries)
  await session.getState(); await session.getEntriesPage(undefined, 100, 1024 * 1024)
  assert.equal(streams.length, count, 'read-only refresh resumed the stopped queue')
  await session.sendUserMessage('explicit resume')
  await waitRequest(count + 1)
  console.log(JSON.stringify({ normalBatch: ['queued first', 'queued second'], promotionOrder: ['promoted first', 'promoted second'], historyComplete: true, stoppedRequests: count, retainedQueueIdentity: true, readonlyRefresh: true, explicitResume: true }))
} finally {
  await session?.dispose()
  for (const {response} of streams) response.destroy()
  endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve))
  rmSync(root, {recursive:true,force:true})
}
