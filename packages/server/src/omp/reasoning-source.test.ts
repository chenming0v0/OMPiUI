import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isJsonObject, type JsonObject, type ReasoningTranslationIntent } from '@ompiui/protocol'
import { readonlyReasoningSource } from './reasoning-source.ts'

const intent: ReasoningTranslationIntent = { sessionId: 'session', entryId: 'target', blockIndex: 1, readerId: 'reader',
  model: 'provider/translator', budget: 8192, priority: 'reading' }
const entry = (id: string, role: string, content: JsonObject[], parentId: string | null = null): JsonObject => ({
  id, type: 'message', parentId, message: { role, timestamp: 123, content },
})
const page = (items: JsonObject[], extra: JsonObject = {}): JsonObject => ({
  head: { header: { id: 'session' } }, items, hasMore: false, ...extra,
})
const thinking = { type: 'thinking', thinking: 'real reasoning' }
const target = entry('target', 'assistant', [{ type: 'text', text: 'TARGET NOT CONTEXT' }, thinking])

test('only preceding active-branch user/assistant text is supplied; no thinking/tool/future text', async () => {
  const commands: Array<[string, JsonObject | undefined]> = []
  const read = readonlyReasoningSource({ sessionQuery: async (_id, type, params) => {
    commands.push([type, params])
    assert.equal(type, 'branch.get')
    return page([
      entry('user', 'user', [{ type: 'text', text: 'question' }]),
      entry('assistant', 'assistant', [{ type: 'thinking', thinking: 'DO NOT PASS' },
        { type: 'toolCall', id: 'call', name: 'bash', arguments: { text: 'DO NOT PASS' } }, { type: 'text', text: 'prior answer' }]),
      entry('tool', 'toolResult', [{ type: 'text', text: 'DO NOT PASS' }]), target,
      entry('future', 'user', [{ type: 'text', text: 'FUTURE DO NOT PASS' }]),
    ])
  } })
  const source = await read(intent, {}, new AbortController().signal)
  assert.equal(source.source, 'real reasoning')
  assert.deepEqual(source.context, [{ role: 'user', text: 'question' }, { role: 'assistant', text: 'prior answer' }])
  assert.deepEqual(commands[0]![1], { limit: 100, maxBytes: 2 * 1024 * 1024, includeLiveMessage: true })
})

test('latest original live checkpoint is authoritative and omitted payload is unavailable', async () => {
  let omitted = false
  const read = readonlyReasoningSource({ sessionQuery: async () => page([], { checkpoint: omitted
    ? { liveMessageOmitted: true } : { liveMessage: { id: 'live', complete: true, message: target.message } } }) })
  assert.equal((await read({ ...intent, entryId: 'live' }, {}, new AbortController().signal)).source, 'real reasoning')
  omitted = true
  await assert.rejects(read({ ...intent, entryId: 'live' }, {}, new AbortController().signal), { code: 'INVALID_REQUEST' })
})

test('streaming is true only for original live streaming tail thinking without later nonempty content', async () => {
  let phase = 'streaming'
  let later: JsonObject[] = []
  let native = false
  const read = readonlyReasoningSource({ sessionQuery: async () => native ? page([target]) : page([], { checkpoint: {
    liveMessage: { id: 'live', complete: true, phase, message: { role: 'assistant', content: [
      { type: 'text', text: 'before reasoning' }, thinking, ...later,
    ] } },
  } }) })
  const liveIntent = { ...intent, entryId: 'live' }
  assert.equal((await read(liveIntent, {}, new AbortController().signal)).streaming, true)
  later = [{ type: 'text', text: '' }, { type: 'thinking', thinking: '' }]
  assert.equal((await read(liveIntent, {}, new AbortController().signal)).streaming, true)
  for (const block of [{ type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'next thinking' },
    { type: 'toolCall', id: 'call', name: 'bash', arguments: {} }]) {
    later = [block]
    assert.equal((await read(liveIntent, {}, new AbortController().signal)).streaming, false)
  }
  later = []; phase = 'persisting'
  assert.equal((await read(liveIntent, {}, new AbortController().signal)).streaming, false)
  native = true
  assert.equal((await read(intent, {}, new AbortController().signal)).streaming, false)
})

test('persisting live/native handoff keeps target and recent context identical', async () => {
  let persisted = false
  const read = readonlyReasoningSource({ sessionQuery: async () => page([
    entry('user', 'user', [{ type: 'text', text: 'question' }]), target,
  ], { stableEntryIds: { target: 'live' }, ...(persisted ? {} : { checkpoint: {
    liveMessage: { id: 'live', complete: true, message: target.message },
  } }) }) })
  const live = await read({ ...intent, entryId: 'live' }, {}, new AbortController().signal)
  persisted = true
  const native = await read(intent, { target: 'live' }, new AbortController().signal)
  assert.equal(live.logicalEntryId, 'live'); assert.equal(native.logicalEntryId, 'live')
  assert.deepEqual(live.context, native.context)
  assert.deepEqual(live.context, [{ role: 'user', text: 'question' }])
})

test('active branch pagination and entry hydration are readonly and etag-bound', async () => {
  const serialized = JSON.stringify(target)
  const commands: Array<[string, JsonObject | undefined]> = []
  const read = readonlyReasoningSource({ sessionQuery: async (_id, type, params) => {
    commands.push([type, params])
    if (type === 'branch.get') return params?.cursor === 'older'
      ? page([entry('user', 'user', [{ type: 'text', text: 'question' }]), { type: 'ompiui.entry_ref', id: 'target' }])
      : page([entry('future', 'user', [{ type: 'text', text: 'not preceding' }])], { hasMore: true, beforeCursor: 'older' })
    assert.equal(type, 'entry.get')
    const offset = Number(params?.offset)
    const nextOffset = Math.min(serialized.length, offset + 32)
    if (offset > 0) assert.equal(params?.etag, 'fixed')
    return { entryId: 'target', content: serialized.slice(offset, nextOffset), offset, nextOffset, etag: 'fixed', hasMore: nextOffset < serialized.length }
  } })
  const source = await read(intent, {}, new AbortController().signal)
  assert.equal(source.source, 'real reasoning')
  assert.deepEqual(source.context, [{ role: 'user', text: 'question' }])
  assert.ok(commands.every(([type]) => type === 'branch.get' || type === 'entry.get'))
})

test('blockIndex must identify original thinking; wrong session and off-branch IDs cannot be source', async () => {
  let wrongSession = false
  const read = readonlyReasoningSource({ sessionQuery: async () => page([target], wrongSession ? { head: { header: { id: 'other' } } } : {}) })
  for (const patch of [{ blockIndex: 0 }, { blockIndex: 2 }, { entryId: 'render-key' }, { entryId: '/tmp/session.jsonl' }]) {
    await assert.rejects(read({ ...intent, ...patch }, {}, new AbortController().signal), { code: 'INVALID_REQUEST' })
  }
  wrongSession = true
  await assert.rejects(read(intent, {}, new AbortController().signal), { code: 'INVALID_REQUEST' })
})

test('stale hydration and non-original projected live messages fail without fallback to browser', async () => {
  const read = readonlyReasoningSource({ sessionQuery: async (_id, type) => {
    if (type === 'branch.get') return page([{ type: 'ompiui.entry_ref', id: 'target' }])
    throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
  } })
  await assert.rejects(read(intent, {}, new AbortController().signal), { code: 'STALE_REVISION' })
  const projected = readonlyReasoningSource({ sessionQuery: async () => page([], { checkpoint: { liveMessage: {
    id: 'live', complete: false, message: target.message,
  } } }) })
  await assert.rejects(projected({ ...intent, entryId: 'live' }, {}, new AbortController().signal), { code: 'INVALID_REQUEST' })
  assert.ok(isJsonObject(target.message))
})
