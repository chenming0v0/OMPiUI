import { afterEach, expect, it } from 'vitest'
import { MainMessageStream } from '../../omp-worker/src/omp/main-message-stream'
import { buildVisibleTimelineEntries } from '../src/features/chat/chatAreaVisibility'
import type { PiBranchPage } from '../src/omp/domain/index.js'
import { piEventStream } from '../src/omp/eventStream'
import { buildPiLiveItems } from '../src/omp/selectors/index.js'
import { piBranchStore } from '../src/omp/state/index.js'

const sessionId = 'main-message-round-trip'

afterEach(() => {
  piEventStream.disconnectAll()
  piBranchStore.clear(sessionId)
})

it('renders every real worker frame while restoring text, thinking and tool arguments losslessly', () => {
  piBranchStore.setData(sessionId, {
    head: { sdkVersion: 'test', revision: 1, header: null, leafId: null, entryCount: 0, epoch: 'history' },
    items: [],
    hasMore: false,
  } as PiBranchPage)
  let sequence = 0
  const stream = new MainMessageStream((event, live) => {
    ;(piEventStream as unknown as { handlePiEvent(id: string, payload: unknown): void }).handlePiEvent(sessionId, {
      event,
      meta: { epoch: 'events', sequence: ++sequence, liveMessage: live },
    })
    const page = piBranchStore.getData(sessionId)!
    expect(() => buildVisibleTimelineEntries(buildPiLiveItems(page))).not.toThrow()
    const message = page.checkpoint?.liveMessage?.message
    if (message?.role === 'assistant') {
      expect(Array.from(message.content).every(block => block && typeof block.type === 'string')).toBe(true)
    }
  })
  const text = 'Working '.repeat(5000)
  const code = 'const value = 1;\n'.repeat(4000)
  const initial = [
    { type: 'thinking', thinking: 'Checking the implementation' },
    { type: 'text', text },
    { type: 'toolCall', id: 'status', name: 'status', arguments: {} },
    { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'test.ts', content: code } },
  ]
  stream.push({ type: 'message_update', message: { role: 'assistant', content: initial } }, { id: 'reply', revision: 1 })
  expect(piBranchStore.getData(sessionId)?.checkpoint?.liveMessage?.message.content).toEqual(initial)
  const updated = [
    initial[0],
    { type: 'text', text: text + 'Complete' },
    initial[2],
    { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'test.ts', content: code + '// done' } },
  ]
  stream.push({ type: 'message_update', message: { role: 'assistant', content: updated } }, { id: 'reply', revision: 2 })
  expect(piBranchStore.getData(sessionId)?.checkpoint?.liveMessage?.message.content).toEqual(updated)
  expect(piBranchStore.getData(sessionId)?.checkpoint?.liveMessage?.complete).toBe(true)
  expect(sequence).toBeGreaterThan(10)
})
