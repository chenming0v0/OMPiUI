import { describe, expect, it } from 'vitest'
import type { SessionEntry } from './vendor/pi-coding-agent'
import type { PiBranchPage, PiLiveMessage } from './domain/index.js'
import { mergeLatestBranchPage } from './branchMerge.js'
import { selectPiTimelineItems } from './selectors/index.js'
import { getToolExecutionStatus } from './domain/index.js'

function entry(id: string): SessionEntry {
  return { type: 'model_change', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', provider: 'p', modelId: id } as SessionEntry
}

function messageEntry(id: string, role: 'user' | 'assistant', text: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: role === 'user'
      ? { role, content: text }
      : { role, content: [{ type: 'text', text }] },
  } as SessionEntry
}

function page(ids: string[], overrides?: Partial<PiBranchPage>): PiBranchPage {
  return {
    head: {
      sdkVersion: '0.81.1',
      revision: ids.length,
      header: null,
      leafId: ids[ids.length - 1] ?? null,
      entryCount: ids.length,
      epoch: 'epoch-1',
    },
    items: ids.map(entry),
    beforeCursor: ids.length > 0 ? `cursor-before-${ids[0]}` : undefined,
    hasMore: false,
    ...overrides,
  }
}

describe('mergeLatestBranchPage', () => {
  it('takes latest when no current data', () => {
    const latest = page(['a', 'b'])
    expect(mergeLatestBranchPage(null, latest)).toBe(latest)
  })

  it('takes latest wholesale on epoch change', () => {
    const current = page(['a', 'b'], { hasMore: true, beforeCursor: 'old-cursor' })
    const latest = page(['x', 'y'], { head: { ...current.head, epoch: 'epoch-2' } })
    expect(mergeLatestBranchPage(current, latest)).toBe(latest)
  })

  it('replaces items when no pagination history exists', () => {
    const current = page(['a', 'b'])
    const latest = page(['a', 'b', 'c'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged.items.map(i => i.id)).toEqual(['a', 'b', 'c'])
    expect(merged).toBe(latest)
  })

  it('prepends older paginated items and keeps local cursor', () => {
    // User paged back: local holds [old1, old2, a, b]; latest page is [a, b, c]
    const current = page(['old1', 'old2', 'a', 'b'], { hasMore: true, beforeCursor: 'cursor-at-old1' })
    const latest = page(['a', 'b', 'c'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged.items.map(i => i.id)).toEqual(['old1', 'old2', 'a', 'b', 'c'])
    expect(merged.beforeCursor).toBe('cursor-at-old1')
    expect(merged.hasMore).toBe(true)
  })

  it('keeps items that fell out of the latest page window', () => {
    // Latest page only holds the most recent 2; local first item scrolled out
    const current = page(['a', 'b', 'c'])
    const latest = page(['b', 'c', 'd'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged.items.map(i => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps paged history while merging newly arrived latest items', () => {
    const current = page(['old', 'a', 'b'], {
      hasMore: true,
      beforeCursor: 'cursor-at-old',
      client: { historyWindowed: true },
    })
    const latest = page(['a', 'b', 'c'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged.items.map(i => i.id)).toEqual(['old', 'a', 'b', 'c'])
    expect(merged.client?.historyWindowed).toBe(true)
    expect(merged.beforeCursor).toBe('cursor-at-old')
  })

  it('keeps windowed history and render identities when a matching delta contains no new entries', () => {
    const current = page(['old', 'a', 'b'], {
      syncCursor: 'base',
      hasMore: true,
      beforeCursor: 'cursor-at-old',
      client: { historyWindowed: true, stableEntryIds: { b: 'live-b' } },
    })
    const latest = page([], {
      head: current.head,
      syncCursor: 'base',
      deltaFrom: 'base',
      hasMore: true,
      beforeCursor: 'renewed-old',
      checkpoint: { position: { epoch: 'events', sequence: 2 } },
    })

    const merged = mergeLatestBranchPage(current, latest)

    expect(merged.items).toEqual(current.items)
    expect(merged.client).toEqual(current.client)
    expect(merged.beforeCursor).toBe('renewed-old')
    expect(merged.hasMore).toBe(true)
    expect(merged.checkpoint).toBe(latest.checkpoint)
    expect(merged.deltaFrom).toBeUndefined()
  })

  it('appends a matching delta to windowed history without requiring the local leaf in the delta', () => {
    const current = page(['old', 'a', 'b'], {
      syncCursor: 'base',
      hasMore: true,
      client: { historyWindowed: true },
    })
    const latest = page(['c'], {
      head: { ...current.head, epoch: 'epoch-2' },
      syncCursor: 'next',
      deltaFrom: 'base',
      beforeCursor: 'renewed-old',
      hasMore: true,
    })

    const merged = mergeLatestBranchPage(current, latest)

    expect(merged.items.map(item => item.id)).toEqual(['old', 'a', 'b', 'c'])
    expect(merged.client?.historyWindowed).toBe(true)
    expect(merged.head).toBe(latest.head)
    expect(merged.syncCursor).toBe('next')
    expect(merged.beforeCursor).toBe('renewed-old')
    expect(merged.deltaFrom).toBeUndefined()
  })

  it('ignores a mismatched delta while browsing windowed history', () => {
    const current = page(['old', 'a', 'b'], {
      syncCursor: 'base',
      client: { historyWindowed: true },
    })
    const latest = page([], { syncCursor: 'next', deltaFrom: 'different-baseline' })

    expect(mergeLatestBranchPage(current, latest)).toBe(current)
  })

  it('still replaces windowed history when a full snapshot moves to another branch', () => {
    const current = page(['old', 'a', 'b'], {
      syncCursor: 'base',
      hasMore: true,
      client: { historyWindowed: true },
    })
    const latest = page(['a', 'fork'], { syncCursor: 'next' })

    expect(mergeLatestBranchPage(current, latest)).toBe(latest)
  })

  it('drops local history when branch structure changed (no overlap)', () => {
    const current = page(['a', 'b', 'c'], { hasMore: true, beforeCursor: 'old-cursor' })
    const latest = page(['x', 'y', 'z'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged).toBe(latest)
  })

  it('replaces wholesale when the local leaf is gone (tree navigation shrank the branch)', () => {
    // Navigate from d back to b: old branch [a,b,c,d] overlaps but its tail
    // must not survive as phantom entries.
    const current = page(['a', 'b', 'c', 'd'], { hasMore: true, beforeCursor: 'cursor-at-a' })
    const latest = page(['a', 'b'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged).toBe(latest)
    expect(merged.items.map(i => i.id)).toEqual(['a', 'b'])
    expect(merged.hasMore).toBe(false)
  })

  it('keeps a live checkpoint until its persisted entry appears', () => {
    const liveMessage = {
      id: 'live-user',
      revision: 2,
      phase: 'streaming' as const,
      message: { role: 'user', content: 'hello' },
    } as PiLiveMessage
    const current = page(['a'], { checkpoint: { position: { epoch: 'epoch-1', sequence: 2 }, liveMessage } })
    const latest = page(['a'])

    const merged = mergeLatestBranchPage(current, latest)

    expect(merged.checkpoint?.liveMessage?.id).toBe('live-user')
  })

  it('maps a persisted message back to its live render key', () => {
    const liveMessage = {
      id: 'live-assistant',
      revision: 2,
      phase: 'persisting' as const,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    } as PiLiveMessage
    const current = page(['user'], { checkpoint: { position: { epoch: 'epoch-1', sequence: 2 }, liveMessage } })
    const latest = page(['user', 'assistant'])
    latest.items[1] = messageEntry('assistant', 'assistant', 'done')

    const merged = mergeLatestBranchPage(current, latest)

    expect(merged.client?.stableEntryIds).toEqual({ assistant: 'live-assistant' })
    expect(selectPiTimelineItems(merged).find(item => item.entryId === 'assistant')?.renderKey).toBe('live-assistant')
  })

  it('hands a partial tool call over to its persisted owner even when the arguments differ', () => {
    const liveMessage = {
      id: 'live-write', revision: 2, phase: 'streaming',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'write-call', name: 'write', arguments: {} }],
      },
    } as PiLiveMessage
    const current = page(['user'], {
      checkpoint: { position: { epoch: 'events', sequence: 10 }, liveMessage },
    })
    const latest = page(['user', 'assistant', 'result'], {
      checkpoint: { position: { epoch: 'events', sequence: 8 } },
    })
    latest.items[1] = {
      type: 'message', id: 'assistant', parentId: 'user', timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'write-call', name: 'write', arguments: { path: 'output.txt', content: 'done' } }],
        api: 'openai-responses', provider: 'openai', model: 'test', timestamp: 0, stopReason: 'toolUse',
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    } as SessionEntry
    latest.items[2] = {
      type: 'message', id: 'result', parentId: 'assistant', timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'toolResult', toolCallId: 'write-call', toolName: 'write',
        content: [{ type: 'text', text: 'written' }], isError: false,
      },
    } as SessionEntry

    const merged = mergeLatestBranchPage(current, latest)
    const assistants = selectPiTimelineItems(merged).filter(item => item.kind === 'assistant_message')

    expect(merged.client?.stableEntryIds).toEqual({ assistant: 'live-write' })
    expect(assistants).toHaveLength(1)
    expect(assistants[0].toolResults['write-call']).toMatchObject({ isError: false })
    expect(merged.checkpoint?.liveMessage).toBeUndefined()
  })

  it('uses the persisted entry identity when the final text differs from the live text', () => {
    const liveMessage = {
      id: 'assistant', revision: 2, phase: 'persisting',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    } as PiLiveMessage
    const current = page(['user'], {
      checkpoint: { position: { epoch: 'events', sequence: 10 }, liveMessage },
    })
    const latest = page(['user', 'assistant'])
    latest.items[1] = messageEntry('assistant', 'assistant', 'final')

    const merged = mergeLatestBranchPage(current, latest)

    expect(selectPiTimelineItems(merged).filter(item => item.kind === 'assistant_message')).toHaveLength(1)
    expect(merged.client?.stableEntryIds).toEqual({ assistant: 'assistant' })
    expect(merged.checkpoint?.liveMessage).toBeUndefined()
  })

  it.each([10, 12])('clears an unmatched live tool when the authoritative snapshot reaches sequence %i', sequence => {
    const current = page(['user'], {
      checkpoint: {
        position: { epoch: 'events', sequence: 10 },
        liveMessage: {
          id: 'discarded-message', revision: 2, phase: 'streaming',
          message: { role: 'assistant', content: [{ type: 'toolCall', id: 'discarded-write', name: 'write', arguments: {} }] },
        } as PiLiveMessage,
      },
    })
    const latest = page(['user'], { checkpoint: { position: { epoch: 'events', sequence } } })

    const merged = mergeLatestBranchPage(current, latest)

    expect(merged.checkpoint).toBe(latest.checkpoint)
    expect(selectPiTimelineItems(merged).filter(item => item.kind === 'assistant_message')).toHaveLength(0)
  })

  it('keeps newer live thinking when an older snapshot has no live message', () => {
    const current = page(['user'], {
      checkpoint: {
        position: { epoch: 'events', sequence: 12 },
        liveMessage: {
          id: 'new-thinking', revision: 1, phase: 'streaming',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Still working' }] },
        } as PiLiveMessage,
      },
    })
    const latest = page(['user'], { checkpoint: { position: { epoch: 'events', sequence: 10 } } })

    expect(mergeLatestBranchPage(current, latest).checkpoint).toBe(current.checkpoint)
  })

  it('takes a newer remote live checkpoint instead of freezing local thinking', () => {
    const current = page(['a'], {
      checkpoint: {
        position: { epoch: 'events', sequence: 2 },
        liveMessage: { id: 'thinking', revision: 2, phase: 'streaming', message: { role: 'assistant', content: [{ type: 'text', text: 'older' }] } } as PiLiveMessage,
      },
    })
    const latest = page(['a'], {
      checkpoint: {
        position: { epoch: 'events', sequence: 4 },
        liveMessage: { id: 'thinking', revision: 4, phase: 'streaming', message: { role: 'assistant', content: [{ type: 'text', text: 'newer' }] } } as PiLiveMessage,
      },
    })
    expect(mergeLatestBranchPage(current, latest).checkpoint).toBe(latest.checkpoint)
  })

  it('does not retain local thinking after the runtime event epoch changes', () => {
    const current = page(['a'], {
      checkpoint: {
        position: { epoch: 'old-runtime', sequence: 20 },
        liveMessage: { id: 'thinking', revision: 20, phase: 'streaming', message: { role: 'assistant', content: [{ type: 'text', text: 'old runtime' }] } } as PiLiveMessage,
      },
    })
    const latest = page(['a'], { checkpoint: { position: { epoch: 'new-runtime', sequence: 1 } } })
    expect(mergeLatestBranchPage(current, latest).checkpoint).toBe(latest.checkpoint)
  })
  it.each([
    { persistedStart: false, localStart: undefined },
    { persistedStart: false, localStart: 900 },
    { persistedStart: true, localStart: 900 },
  ])('retains known orphan arguments while settling stale live evidence (%j)', ({ persistedStart, localStart }) => {
    const call = { type: 'toolCall' as const, id: 'orphan-call', name: 'read', arguments: { path: 'src/main.ts' } }
    const result = { role: 'toolResult' as const, toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text' as const, text: 'export const value = 742' }], isError: false, timestamp: 1_000 }
    const resultEntry: SessionEntry = { type: 'message', id: 'orphan-result', parentId: null,
      timestamp: new Date(1_000).toISOString(), message: result }
    const startEntry: SessionEntry = { type: 'custom', customType: 'tool_execution_start', id: 'orphan-start', parentId: null,
      timestamp: new Date(900).toISOString(), data: { toolCallId: call.id, startedAt: 900 } }
    const current = page(['a'], { client: { toolExecutions: { [call.id]: {
      call, startedAt: localStart, isRunning: true, error: 'stale failure', completedAt: 800, endedAt: 800,
    } } } })
    const latest = page(['a'], { items: [entry('a'), ...(persistedStart ? [startEntry] : []), resultEntry] })
    const merged = mergeLatestBranchPage(current, latest)
    const orphan = selectPiTimelineItems(merged).find(item => item.kind === 'tool_result')
    expect(orphan?.kind).toBe('tool_result')
    if (orphan?.kind !== 'tool_result') throw new Error('Missing orphan result')
    expect(orphan.execution.argumentsUnknown).toBe(false)
    expect(orphan.execution.call.arguments).toEqual({ path: 'src/main.ts' })
    expect(orphan.execution.error).toBeUndefined()
    expect(orphan.execution.completedAt).toBeUndefined()
    expect(orphan.execution.endedAt).toBeUndefined()
    expect(orphan.execution.startedAt).toBe(persistedStart ? 900 : localStart)
    expect(getToolExecutionStatus(orphan.execution)).toBe('completed')
  })

  it('drops prior runtime live tool evidence on event epoch changes', () => {
    const current = page(['a'], { checkpoint: { position: { epoch: 'old-runtime', sequence: 20 } },
      client: { toolExecutions: { bash: { startedAt: 10_000, isRunning: true } } } })
    const latest = page(['a'], { checkpoint: { position: { epoch: 'new-runtime', sequence: 1 } } })
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged.client?.toolExecutions?.bash).toBeUndefined()
  })
})
