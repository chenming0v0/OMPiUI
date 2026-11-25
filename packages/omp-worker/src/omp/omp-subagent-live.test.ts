import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import type { JsonObject } from '@ompiui/protocol'
import { OmpRpcSession } from './omp-session.js'
import type { OmpRpcFrame } from './rpc-client.js'
import { SUBAGENT_OBSERVATION_PREFIX } from './native-subagent-observation.js'

// 以官方帧形状驱动真实 worker 投影；测试只在 CI 运行。
function fixture(t: TestContext) {
  const session = Reflect.construct(OmpRpcSession, []) as OmpRpcSession
  const internal = session as unknown as {
    sessionId: string
    client: unknown
    handleFrame(frame: OmpRpcFrame): void
  }
  internal.sessionId = 'root'
  const commands: JsonObject[] = []
  const frames: JsonObject[] = []
  let roster: JsonObject[] = []
  internal.client = {
    async request(command: JsonObject) {
      commands.push(command)
      return { type: 'response', success: true, command: command.type, data: { subagents: roster } }
    },
    async close() {},
  }
  session.onSubagentFrame(frame => frames.push(frame))
  t.after(() => session.dispose())
  let sequence = 0
  const frame = (value: OmpRpcFrame) => internal.handleFrame(value)
  return {
    session, commands, frames, frame,
    setRoster(value: JsonObject[]) { roster = value },
    async run() { return (await session.listSubagents() as JsonObject[])[0]! },
    observe(value: JsonObject = {}) {
      frame({ type: 'extension_ui_request', method: 'notify', message: SUBAGENT_OBSERVATION_PREFIX + JSON.stringify({
        protocolVersion: 1, rootSessionId: 'root', rootSessionFile: null,
        id: 'child', sessionFile: 'child.jsonl', observationEpoch: 'observer', observationId: 'attachment',
        observationSequence: ++sequence, activityVersion: sequence,
        activity: 'running', pendingAsync: false, eventsSubscribed: true, ...value,
      }) })
    },
  }
}

const owner = { id: 'child', parentToolCallId: 'task-call', sessionFile: 'child.jsonl', agent: 'task', index: 0 }
const tool = { type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read' }

test('official id-only events inherit task ownership and the active observation', async t => {
  const h = fixture(t)
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'started' } })
  h.observe({ eventsSubscribed: false })
  h.frame({ type: 'subagent_event', payload: { id: 'child', event: tool } })
  const event = h.frames.find(frame => frame.kind === 'event')!.payload as JsonObject
  assert.equal(event.parentToolCallId, owner.parentToolCallId)
  assert.equal(event.sessionFile, owner.sessionFile)
  assert.equal(event.activity, 'running')
  assert.equal(event.runId, (await h.run()).runId)
})

test('live session subscription delivers each message boundary once and continues after task completion', async t => {
  const h = fixture(t)
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'started' } })
  h.observe()
  for (const [type, content] of [['message_start', ''], ['message_update', '实时正文'], ['message_end', '实时正文']]) {
    const event = { type, message: { role: 'assistant', content } }
    // 两种回调顺序都应只输出一次；官方 task 监视器和公开订阅会收到同一个事件。
    if (type === 'message_update') h.observe({ event })
    h.frame({ type: 'subagent_event', payload: { id: 'child', event } })
    if (type !== 'message_update') h.observe({ event })
  }
  const events = h.frames.filter(frame => frame.kind === 'event').map(frame => (frame.payload as JsonObject).event as JsonObject)
  assert.deepEqual(events.map(event => event.phase), ['message_start', 'message_update', 'message_end'])
  assert.equal(new Set(events.map(event => event.messageId)).size, 1)
  assert.equal(events.map(event => event.textDelta).join(''), '实时正文')
  h.observe({ activity: 'idle' })
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'completed' } })
  h.observe()
  h.observe({ event: tool })
  assert.equal(((h.frames.at(-1)!.payload as JsonObject).event as JsonObject).toolCallId, 'read-1')
  assert.equal((await h.run()).status, 'running')
  assert.equal((await h.run()).event, undefined)
  assert.ok(h.commands.every(command => command.type === 'get_subagents'))
})

test('observation-only child keeps its run when get_subagents fills in task ownership', async t => {
  const h = fixture(t)
  h.observe()
  h.observe({ event: tool })
  const before = await h.run()
  h.setRoster([{ ...owner, status: 'running' }])
  const after = await h.run()
  assert.equal(after.runId, before.runId)
  assert.equal(after.identityAmbiguous, false)
  assert.equal(after.parentToolCallId, owner.parentToolCallId)
  h.observe({ event: { ...tool, type: 'tool_execution_end' } })
  assert.equal((h.frames.at(-1)!.payload as JsonObject).parentToolCallId, owner.parentToolCallId)
})

test('new task ownership accepts native terminal progress without a synthetic native runId', async t => {
  const h = fixture(t)
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'started' } })
  const before = await h.run()
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, parentToolCallId: 'next-task', status: 'started' } })
  h.frame({ type: 'subagent_progress', payload: { ...owner, parentToolCallId: 'next-task', progress: { id: 'child', status: 'completed', tokens: 42 } } })
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, parentToolCallId: 'next-task', status: 'completed' } })
  h.frame({ type: 'subagent_progress', payload: { ...owner, progress: { id: 'child', status: 'failed', tokens: 999 } } })
  const after = await h.run()
  assert.notEqual(after.runId, before.runId)
  assert.equal(after.identityAmbiguous, false)
  assert.equal(after.status, 'completed')
  assert.equal((after.progress as JsonObject).tokens, 42)
})

test('same-owner follow-up keeps running progress and accepts completion after observed idle', async t => {
  const h = fixture(t)
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'started' } })
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'started' } })
  h.frame({ type: 'subagent_progress', payload: { ...owner, progress: { id: 'child', status: 'running', tokens: 3 } } })
  assert.equal((await h.run()).status, 'running')
  h.observe()
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'completed' } })
  assert.equal((await h.run()).status, 'running')
  assert.equal(h.frames.filter(frame => frame.kind === 'unassigned').length, 1)
  h.observe({ activity: 'idle' })
  h.frame({ type: 'subagent_progress', payload: { ...owner, progress: { id: 'child', status: 'completed', tokens: 12 } } })
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'completed' } })
  const finished = await h.run()
  assert.equal(finished.status, 'completed')
  assert.equal(finished.identityAmbiguous, false)
  assert.equal((finished.progress as JsonObject).tokens, 12)
})

test('private messages reject wrong roots and retired attachments, then restore RPC fallback on detach', async t => {
  const h = fixture(t)
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'started' } })
  h.observe()
  h.observe({ event: tool, rootSessionId: 'foreign' })
  h.observe({ event: tool, rootSessionFile: 'foreign.jsonl' })
  h.observe({ event: tool, sessionFile: 'foreign-child.jsonl', observationId: 'foreign' })
  h.observe({ event: tool, observationSequence: 1 })
  assert.equal(h.frames.filter(frame => frame.kind === 'event').length, 0)
  h.observe({ event: tool })
  assert.equal(h.frames.filter(frame => frame.kind === 'event').length, 1)
  h.observe({ observationId: 'replacement' })
  h.observe({ event: { ...tool, toolCallId: 'stale' } })
  assert.equal(h.frames.filter(frame => frame.kind === 'event').length, 1)
  h.observe({ observationId: 'replacement', activity: 'unavailable', eventsSubscribed: false })
  h.frame({ type: 'subagent_event', payload: { id: 'child', event: { ...tool, toolCallId: 'fallback' } } })
  assert.equal(((h.frames.at(-1)!.payload as JsonObject).event as JsonObject).toolCallId, 'fallback')
  assert.equal((await h.run()).observationId, 'replacement')
})

test('a new transcript releases the old event source and rejects buffered messages from retired attachments', t => {
  const h = fixture(t)
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, status: 'started' } })
  h.observe()
  h.session.setOutputPaused(true)
  h.observe({ event: tool })
  h.observe({ observationId: 'replacement' })
  h.session.setOutputPaused(false)
  assert.equal(h.frames.filter(frame => frame.kind === 'event').length, 0)
  h.frame({ type: 'subagent_lifecycle', payload: { ...owner, sessionFile: 'replacement.jsonl', status: 'started' } })
  h.frame({ type: 'subagent_event', payload: { id: 'child', event: { ...tool, toolCallId: 'new-file' } } })
  assert.equal(((h.frames.at(-1)!.payload as JsonObject).event as JsonObject).toolCallId, 'new-file')
  assert.equal((h.frames.at(-1)!.payload as JsonObject).sessionFile, 'replacement.jsonl')
})

test('subagent id resolves observation-only history through the existing read-only native preview', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ompiui-live-subagent-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  const childDir = path.join(root, 'sessions', 'project', 'parent')
  mkdirSync(childDir, { recursive: true })
  const file = path.join(childDir, 'child.jsonl')
  const body = [
    { type: 'session', version: 3, id: 'child-session', cwd: '/project' },
    { type: 'message', id: 'm1', message: { role: 'assistant', content: '原生子会话正文' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
  writeFileSync(file, body)
  const h = fixture(t)
  h.observe({ sessionFile: file })
  const result = await h.session.getSubagentMessages({ subagentId: 'child', sync: { version: 1, knownBlocks: [] } }) as JsonObject
  assert.equal(result.syncVersion, 1)
  assert.ok(JSON.stringify(result.blocks).includes('原生子会话正文'))
  assert.deepEqual(h.commands, [])
  assert.equal(readFileSync(file, 'utf8'), body)
})
