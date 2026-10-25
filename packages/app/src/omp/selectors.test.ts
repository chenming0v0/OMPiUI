import { describe, expect, it } from 'vitest'
import type { SessionEntry } from './vendor/pi-coding-agent'
import { getToolExecutionStatus, type PiBranchPage, type PiBashExecutionGroupItem, type PiTimelineItem, type PiAssistantMessageItem } from './domain/index.js'
import { selectPiTimelineItems } from './selectors/index.js'

function bashEntry(id: string, command: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'bashExecution', command, output: 'out', exitCode: 0, timestamp: Date.now() },
  } as SessionEntry
}

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: text },
  } as SessionEntry
}

function page(entries: SessionEntry[]): PiBranchPage {
  return {
    head: {
      sdkVersion: '0.84.0',
      revision: entries.length,
      header: null,
      leafId: entries[entries.length - 1]?.id ?? null,
      entryCount: entries.length,
      epoch: 'epoch-1',
    },
    items: entries,
    beforeCursor: undefined,
    hasMore: false,
  }
}

describe('selectPiTimelineItems bash grouping', () => {
  it('merges consecutive bash executions into one tool group', () => {
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), bashEntry('b2', 'pwd'), bashEntry('b3', 'git status')]))
    expect(items).toHaveLength(1)
    const group = items[0] as PiBashExecutionGroupItem
    expect(group.kind).toBe('bash_execution_group')
    expect(group.entryId).toBe('b1')
    expect(group.items.map(item => item.entryId)).toEqual(['b1', 'b2', 'b3'])
  })

  it('keeps bash groups separate when interrupted by other entries', () => {
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), userEntry('u1', 'hi'), bashEntry('b2', 'pwd')]))
    const groups = items.filter(item => item.kind === 'bash_execution_group') as PiBashExecutionGroupItem[]
    expect(groups).toHaveLength(2)
    expect(groups[0].items.map(item => item.entryId)).toEqual(['b1'])
    expect(groups[1].items.map(item => item.entryId)).toEqual(['b2'])
  })

  it('wraps a single bash execution in a group with stable entryId', () => {
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls')]))
    expect(items).toHaveLength(1)
    const group = items[0] as PiBashExecutionGroupItem
    expect(group.kind).toBe('bash_execution_group')
    expect(group.entryId).toBe('b1')
    expect(group.items).toHaveLength(1)
  })

  it('does not merge bash across compaction entries', () => {
    const compaction = {
      type: 'compaction',
      id: 'c1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      summary: 'sum',
      tokensBefore: 10,
      firstKeptEntryId: 'b1',
    } as unknown as SessionEntry
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), compaction, bashEntry('b2', 'pwd')]))
    const groups = items.filter(item => item.kind === 'bash_execution_group') as PiBashExecutionGroupItem[]
    expect(groups).toHaveLength(2)
  })

  it('preserves relative order with user/assistant entries', () => {
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), userEntry('u1', 'hi')]))
    expect(items.map(item => item.kind)).toEqual(['bash_execution_group', 'user_message'])
    expect((items[0] as PiTimelineItem).entryId).toBe('b1')
  })
})

describe('selectPiTimelineItems OMP extended entries', () => {
  it('maps mode_change to a mode_change item with its mode payload', () => {
    const modeChange = {
      type: 'mode_change',
      id: 'm1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      mode: 'goal',
      data: { goal: { id: 'g1', status: 'active' } },
    } as unknown as SessionEntry
    const items = selectPiTimelineItems(page([modeChange, userEntry('u1', 'hi')]))
    expect(items.map(item => item.kind)).toEqual(['mode_change', 'user_message'])
    const item = items[0] as Extract<PiTimelineItem, { kind: 'mode_change' }>
    expect(item.entryId).toBe('m1')
    expect(item.mode).toBe('goal')
    expect(item.data).toEqual({ goal: { id: 'g1', status: 'active' } })
  })

  it('does not merge bash groups across mode_change entries', () => {
    const modeChange = {
      type: 'mode_change',
      id: 'm1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      mode: 'none',
    } as unknown as SessionEntry
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), modeChange, bashEntry('b2', 'pwd')]))
    const groups = items.filter(item => item.kind === 'bash_execution_group') as PiBashExecutionGroupItem[]
    expect(groups).toHaveLength(2)
  })

  it('skips OMP bookkeeping entries instead of surfacing them as unknown', () => {
    const bookkeeping = (id: string, type: string) => ({
      type,
      id,
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
    }) as unknown as SessionEntry
    const items = selectPiTimelineItems(page([
      bookkeeping('s1', 'service_tier_change'),
      bookkeeping('s2', 'ttsr_injection'),
      bookkeeping('s3', 'credential_pin'),
      bookkeeping('s4', 'reset_boundary'),
      bookkeeping('s5', 'omp.dropped'),
      bookkeeping('s6', 'title_change'),
      userEntry('u1', 'hi'),
    ]))
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('user_message')
  })
})

describe('selectPiTimelineItems live/persisted key handover', () => {
  const assistantEntry = (id: string, text: string) => ({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'm',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  }) as SessionEntry

  function branchWith(checkpoint: PiBranchPage['checkpoint'], client?: PiBranchPage['client']): PiBranchPage {
    const entries = [userEntry('u1', 'hi'), assistantEntry('a1', 'done')]
    return {
      ...page(entries),
      checkpoint,
      client,
    }
  }

  it('does not render the live row once its persisted entry is visible via stableEntryIds', () => {
    // persisted entry a1 is mapped back to live.id as renderKey (branchMerge
    // sets stableEntryIds.a1 = 'live-a1') — rendering the live row too would
    // produce two children with the same key.
    const branch = branchWith(
      {
        position: { epoch: 'epoch-1', sequence: 3 },
        liveMessage: {
          id: 'live-a1',
          revision: 3,
          phase: 'persisting',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'm',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        },
      },
      { stableEntryIds: { a1: 'live-a1' } },
    )
    const items = selectPiTimelineItems(branch)
    // Only the persisted entry renders (no live duplicate).
    expect(items.filter(i => i.kind === 'assistant_message')).toHaveLength(1)
    expect(items.some(i => i.kind === 'assistant_message' && i.entryId === 'live-a1')).toBe(false)
    const persisted = items.find(i => i.kind === 'assistant_message' && i.entryId === 'a1')
    expect(persisted?.renderKey).toBe('live-a1')
  })

  it.each(['streaming', 'persisting'] as const)('renders the %s live row until its entry is visible', phase => {
    const branch = branchWith({
      position: { epoch: 'epoch-1', sequence: 3 },
      liveMessage: {
        id: 'live-a1',
        revision: 3,
        phase,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'm',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      },
    })
    const items = selectPiTimelineItems(branch)
    expect(items.find(i => i.kind === 'assistant_message' && i.entryId === 'live-a1')).toMatchObject({
      blocks: [{ type: 'text', text: 'done' }],
      isStreaming: phase === 'streaming',
    })
  })
})

describe('tool execution history', () => {
  it.each([undefined, 'not-a-time'])('restores a persisted started call without inventing timing for %s', startedAt => {
    const call = { type: 'toolCall' as const, id: 'started-without-time', name: 'bash', arguments: {} }
    const assistant = { type: 'message', id: 'assistant', parentId: null, timestamp: new Date(100).toISOString(), message: { role: 'assistant', content: [call], timestamp: 100 } } as SessionEntry
    const start = { type: 'custom', id: 'start', parentId: 'assistant', timestamp: new Date(200).toISOString(), customType: 'tool_execution_start', data: { toolCallId: call.id, startedAt } } as SessionEntry
    const item = selectPiTimelineItems(page([assistant, start]))[0] as PiAssistantMessageItem
    expect(getToolExecutionStatus({ ...item.toolExecutions?.[call.id], call })).toBe('running')
    expect(item.toolExecutions?.[call.id].startedAt).toBeUndefined()
  })

  it('restores only the started call in a four-tool batch and gives persisted results precedence', () => {
    const timestamp = Date.parse('2026-10-21T16:57:18Z')
    const blocks = ['bash', 'todo', 'read', 'write'].map(name => ({ type: 'toolCall' as const, id: `${name}-call`, name, arguments: {} }))
    const assistant = {
      type: 'message', id: 'batch', parentId: null, timestamp: new Date(timestamp - 10_000).toISOString(),
      message: { role: 'assistant', content: blocks, timestamp: timestamp - 10_000 },
    } as SessionEntry
    const start: SessionEntry = { type: 'custom', id: 'bash-start', parentId: assistant.id,
      timestamp: new Date(timestamp + 100).toISOString(), customType: 'tool_execution_start',
      data: { toolCallId: 'bash-call', startedAt: new Date(timestamp).toISOString() } }
    const restored = selectPiTimelineItems(page([assistant, start]))[0] as PiAssistantMessageItem
    const executions = blocks.map(call => ({ ...restored.toolExecutions?.[call.id], call, result: restored.toolResults[call.id] }))
    expect(executions.map(getToolExecutionStatus)).toEqual(['running', 'pending', 'pending', 'pending'])
    expect(executions.map(execution => execution.startedAt)).toEqual([timestamp, undefined, undefined, undefined])
    if (assistant.type !== 'message' || assistant.message.role !== 'assistant') throw new Error('Expected assistant fixture')
    const liveBranch = page([start])
    liveBranch.checkpoint = { position: { epoch: 'events', sequence: 2 },
      liveMessage: { id: 'live-batch', revision: 1, phase: 'persisting', message: assistant.message } }
    const liveItem = selectPiTimelineItems(liveBranch)[0] as PiAssistantMessageItem
    expect(blocks.map(call => getToolExecutionStatus({ ...liveItem.toolExecutions?.[call.id], call }))).toEqual(['running', 'pending', 'pending', 'pending'])
    const result = { type: 'message', id: 'bash-result', parentId: start.id, timestamp: new Date(timestamp + 2_000).toISOString(),
      message: { role: 'toolResult', toolCallId: 'bash-call', toolName: 'bash', content: [{ type: 'text', text: 'finished' }], isError: true, timestamp: timestamp + 2_000 },
    } as SessionEntry
    const settledBranch = page([assistant, start, result])
    settledBranch.client = { toolExecutions: { 'bash-call': { startedAt: timestamp - 1_000, isRunning: true } } }
    const settled = selectPiTimelineItems(settledBranch)[0] as PiAssistantMessageItem
    expect(getToolExecutionStatus({ ...settled.toolExecutions?.['bash-call'], call: blocks[0], result: settled.toolResults['bash-call'] })).toBe('error')
    expect(settled.toolExecutions?.['bash-call'].startedAt).toBe(timestamp)
    const old = selectPiTimelineItems(page([assistant]))[0] as PiAssistantMessageItem
    expect(blocks.map(call => getToolExecutionStatus({ ...old.toolExecutions?.[call.id], call }))).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('renders an orphan result at a pagination boundary and removes its fallback once the owner is loaded', () => {
    const result = { type: 'message', id: 'orphan-result', parentId: 'missing-owner', timestamp: '2026-10-22T00:00:00Z', message: { role: 'toolResult', toolCallId: 'call-orphan', toolName: 'read', content: [{ type: 'text', text: 'Permission denied' }], isError: true, timestamp: 1 } } as SessionEntry
    const orphan = selectPiTimelineItems(page([result]))[0]
    expect(orphan).toMatchObject({ kind: 'tool_result', execution: { argumentsUnknown: true, call: { id: 'call-orphan', name: 'read' }, result: { isError: true, content: [{ text: 'Permission denied' }] } } })
    const owner: SessionEntry = {
      type: 'message', id: 'owner', parentId: null, timestamp: '2026-10-22T00:00:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-orphan', name: 'read', arguments: { path: 'private.txt' } }],
        api: 'anthropic-messages', provider: 'anthropic', model: 'm',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse', timestamp: 1,
      },
    }
    const hydrated = selectPiTimelineItems(page([owner, result]))
    expect(hydrated.map(item => item.kind)).toEqual(['assistant_message'])
    expect(hydrated[0]).toMatchObject({ toolResults: { 'call-orphan': { isError: true } } })
    // Results keep their native payload through window eviction and reread.
    expect(selectPiTimelineItems(page([result]))[0]).toEqual(orphan)
    if (owner.type !== 'message' || owner.message.role !== 'assistant') throw new Error('Expected assistant')
    const livePage = page([result])
    livePage.checkpoint = { position: { epoch: 'events', sequence: 1 }, liveMessage: { id: 'live-owner', revision: 1, phase: 'persisting', message: owner.message } }
    // A stable mapping can outlive its entry in the bounded history window.
    livePage.client = { stableEntryIds: { [owner.id]: 'live-owner' } }
    const liveItems = selectPiTimelineItems(livePage)
    expect(liveItems).toHaveLength(1)
    expect(liveItems[0]).toMatchObject({ kind: 'assistant_message', entryId: 'live-owner', toolResults: { 'call-orphan': { isError: true } } })
    const persistedItems = selectPiTimelineItems({ ...livePage, items: [owner, result] })
    expect(persistedItems).toHaveLength(1)
    expect(persistedItems[0]).toMatchObject({ entryId: owner.id, toolResults: { 'call-orphan': { isError: true } } })
  })

  it('deduplicates orphan results at their latest native position before a later owner arrives', () => {
    const call = { type: 'toolCall' as const, id: 'repeated-call', name: 'unknown-tool', arguments: { target: 'actual' } }
    const first = { type: 'message', id: 'first-result', parentId: null, timestamp: new Date(1).toISOString(), message: { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'first' }], isError: false, timestamp: 1 } } as SessionEntry
    const latest = { ...first, id: 'latest-result', timestamp: new Date(3).toISOString(), message: { ...first.message, content: [{ type: 'text', text: '  Permission denied\n' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }], isError: true, timestamp: 3 } } as SessionEntry
    const owner = { type: 'message', id: 'later-owner', parentId: null, timestamp: new Date(4).toISOString(), message: { role: 'assistant', content: [call], timestamp: 4 } } as SessionEntry
    const separator = userEntry('separator', 'between results')
    const orphanItems = selectPiTimelineItems(page([first, separator, latest]))
    expect(orphanItems.map(item => item.entryId)).toEqual(['separator', 'latest-result'])
    expect(orphanItems[1]).toMatchObject({ execution: { result: latest.message } })
    const merged = selectPiTimelineItems(page([first, separator, latest, owner]))
    expect(merged.map(item => item.kind)).toEqual(['user_message', 'assistant_message'])
    expect(merged[1]).toMatchObject({ toolResults: { [call.id]: latest.message } })
    // Backfilling an earlier orphan must not overwrite a newer owned result.
    const ownedLatest = selectPiTimelineItems(page([first, owner, latest]))
    expect(ownedLatest).toHaveLength(1)
    expect(ownedLatest[0]).toMatchObject({ toolResults: { [call.id]: latest.message } })
  })
})

describe('selectPiTimelineItems execution-only fallback rows', () => {
  const read = { type: 'toolCall' as const, id: 'old-read', name: 'read', arguments: { path: 'a.ts' } }
  const result = { role: 'toolResult' as const, toolCallId: read.id, toolName: 'read', content: [{ type: 'text' as const, text: 'ok' }], isError: false, timestamp: 600 }
  const user: SessionEntry = { type: 'message', id: 'u', parentId: null, timestamp: new Date(1_000).toISOString(), message: { role: 'user', content: 'go', timestamp: 1_000 } } as SessionEntry
  const final: SessionEntry = { type: 'message', id: 'a', parentId: 'u', timestamp: new Date(2_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 2_000 } } as SessionEntry

  it('does not append completed calls whose owner slid out of the loaded window', () => {
    const branch = { ...page([user, final]), hasMore: true }
    branch.client = { toolExecutions: { [read.id]: { call: read, startedAt: 500, completedAt: 600, isRunning: false, result } } }
    expect(selectPiTimelineItems(branch).map(item => item.kind)).toEqual(['user_message', 'assistant_message'])
  })

  it('still shows a call that started after the newest loaded entry', () => {
    const branch = page([user, final])
    branch.client = { toolExecutions: { fresh: { call: { ...read, id: 'fresh' }, startedAt: 3_000, isRunning: true } } }
    expect(selectPiTimelineItems(branch).map(item => item.kind)).toEqual(['user_message', 'assistant_message', 'tool_result'])
  })
})
