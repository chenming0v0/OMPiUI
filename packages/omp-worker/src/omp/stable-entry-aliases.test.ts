import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JsonObject } from '@ompiui/protocol'
import { StableEntryAliases } from './stable-entry-aliases.js'

const message: JsonObject = { role: 'assistant', timestamp: 1770000000000, content: [
  { type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'answer' },
  { type: 'toolCall', id: 'unique-call', name: 'bash', arguments: { command: 'pwd' } },
] }
const entry = (id: string, value = message): JsonObject => ({ id, type: 'message', message: value })

test('authoritative new assistant entry correlates exact timestamp/content/toolCall ID', () => {
  const aliases = new StableEntryAliases()
  aliases.completed('session', 'live', message, ['old'])
  aliases.observe('session', [entry('old'), entry('native')])
  assert.deepEqual(aliases.snapshot('session'), { native: 'live' })
  assert.deepEqual(aliases.snapshot('other-session'), {}, 'aliases cannot cross real session identity')
})

test('known history, mismatched timestamp/content/toolCall and user messages cannot alias', () => {
  const aliases = new StableEntryAliases()
  aliases.completed('session', 'live', message, ['old'])
  aliases.observe('session', [entry('old'), entry('timestamp', { ...message, timestamp: 1 }),
    entry('content', { ...message, content: [{ type: 'thinking', thinking: 'changed' }] }),
    entry('tool', { ...message, content: [...(message.content as JsonObject[]).slice(0, 2), { type: 'toolCall', id: 'wrong', name: 'bash', arguments: { command: 'pwd' } }] }),
    entry('user', { ...message, role: 'user' }),
  ])
  assert.deepEqual(aliases.snapshot('session'), {})
  aliases.observe('session', [entry('native')])
  assert.deepEqual(aliases.snapshot('session'), { native: 'live' })
})

test('ambiguous matches are rejected permanently, not chosen when later pages omit one', () => {
  const aliases = new StableEntryAliases()
  aliases.completed('session', 'live', message, [])
  aliases.observe('session', [entry('one'), entry('two')])
  aliases.observe('session', [entry('one')])
  assert.deepEqual(aliases.snapshot('session'), {})
})

test('native aliases are bounded and can be discovered after a delayed native handoff', () => {
  const aliases = new StableEntryAliases()
  aliases.completed('session', 'live', message, [])
  aliases.observe('session', [])
  aliases.observe('session', [entry('native')])
  assert.deepEqual(aliases.snapshot('session'), { native: 'live' })
  for (let index = 0; index < 600; index++) {
    const value = { ...message, timestamp: index }
    aliases.completed('session', `live${index}`, value, [])
    aliases.observe('session', [entry(`native${index}`, value)])
  }
  assert.equal(Object.keys(aliases.snapshot('session')).length, 512)
})
