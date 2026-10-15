import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildVisibleTimelineEntries } from '../features/chat/chatAreaVisibility'
import * as controllers from './controllers/index.js'
import type { PiBranchPage } from './domain/index.js'
import { piEventStream } from './eventStream'
import { buildPiLiveItems } from './selectors/index.js'
import { piBranchStore } from './state/index.js'

const sessionId = 'main-message-patches'
const internal = piEventStream as unknown as {
  handlePiEvent(id: string, payload: unknown): void
  flushPendingLiveMessage(id: string): void
}

function branch(): PiBranchPage {
  return {
    head: { sdkVersion: 'test', revision: 1, header: null, leafId: null, entryCount: 0, epoch: 'history' },
    items: [],
    hasMore: false,
  } as PiBranchPage
}

function emit(event: Record<string, unknown>, revision = 1) {
  internal.handlePiEvent(sessionId, {
    event,
    meta: { epoch: 'events', sequence: revision, liveMessage: { id: 'live-reply', revision } },
  })
}

function patch(index: number, block: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'message_patch',
    metadata: { role: 'assistant', timestamp: 1 },
    index,
    block,
    blockCount: 3,
    ...extra,
  }
}

function content() {
  const message = piBranchStore.getData(sessionId)?.checkpoint?.liveMessage?.message
  return message?.role === 'assistant' ? message.content : []
}

function expectRenderable() {
  expect(() => buildVisibleTimelineEntries(buildPiLiveItems(piBranchStore.getData(sessionId)!))).not.toThrow()
  expect(Array.from(content()).every(block => block && typeof block.type === 'string')).toBe(true)
}

describe('main message patch rendering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(controllers, 'refreshPiBranch').mockResolvedValue()
    piBranchStore.setData(sessionId, branch())
  })

  afterEach(() => {
    piEventStream.disconnectAll()
    piBranchStore.clear(sessionId)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps every intermediate multi-block frame dense and renderable', () => {
    emit(patch(0, { type: 'text' }, { field: 'text', offset: 0, delta: 'Working' }))
    expectRenderable()
    expect(content()).toEqual([{ type: 'text', text: 'Working' }])

    emit(patch(1, { type: 'thinking' }, { field: 'thinking', offset: 0, delta: 'Checking' }))
    expectRenderable()
    emit(patch(2, { type: 'toolCall', id: 'read', name: 'read' }, {
      field: 'arguments', argument: 'path', argumentKeys: ['path'], offset: 0, delta: 'src/',
    }))
    expectRenderable()
    emit(patch(2, { type: 'toolCall', id: 'read', name: 'read' }, {
      field: 'arguments', argument: 'path', argumentKeys: ['path'], offset: 4, delta: 'index.ts', complete: true,
    }))
    expectRenderable()
    expect(content()).toEqual([
      { type: 'text', text: 'Working' },
      { type: 'thinking', thinking: 'Checking' },
      { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'src/index.ts' } },
    ])
    expect(controllers.refreshPiBranch).not.toHaveBeenCalled()
  })

  it('recovers a missing block prefix without publishing a sparse message', () => {
    emit({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'Previous' }] } })
    const previous = piBranchStore.getData(sessionId)?.checkpoint
    emit(patch(2, { type: 'text' }, { field: 'text', offset: 0, delta: 'Tail' }), 2)
    expect(piBranchStore.getData(sessionId)?.checkpoint).toBe(previous)
    expect(controllers.refreshPiBranch).toHaveBeenCalledOnce()
    expectRenderable()
  })

  it('also recovers missing text offsets without losing the visible prefix', () => {
    emit(patch(0, { type: 'text' }, { field: 'text', offset: 0, delta: 'Start', blockCount: 1, complete: true }))
    emit(patch(0, { type: 'text' }, { field: 'text', offset: 20, delta: 'Tail', blockCount: 1 }), 2)
    expect(content()).toEqual([{ type: 'text', text: 'Start' }])
    expect(controllers.refreshPiBranch).toHaveBeenCalledOnce()
    expectRenderable()
  })

  it('still trims removed blocks and ignores repeated completed revisions', () => {
    emit({ type: 'message_start', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Old' }, { type: 'thinking', thinking: 'Old reasoning' }],
    } })
    emit(patch(0, { type: 'text' }, { field: 'text', offset: 0, delta: 'New', blockCount: 1, complete: true }), 2)
    emit(patch(0, { type: 'text' }, { field: 'text', offset: 0, delta: 'Duplicate', blockCount: 1, complete: true }), 2)
    expect(content()).toEqual([{ type: 'text', text: 'New' }])
    expectRenderable()
  })

  it('assembles replay patches before branch hydration without caching holes', () => {
    piBranchStore.clear(sessionId)
    emit(patch(0, { type: 'text' }, { field: 'text', offset: 0, delta: 'Restored' }))
    emit(patch(1, { type: 'thinking' }, { field: 'thinking', offset: 0, delta: 'Checking' }))
    emit(patch(2, { type: 'toolCall', id: 'status', name: 'status', arguments: {} }, { complete: true }))
    piBranchStore.setData(sessionId, branch())
    internal.flushPendingLiveMessage(sessionId)
    expectRenderable()
    expect(content()).toHaveLength(3)
    expect(content()[2]).toMatchObject({ id: 'status', arguments: {} })
  })
})
