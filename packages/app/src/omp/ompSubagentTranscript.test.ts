import { describe, expect, it } from 'vitest'
import {
  appendTranscriptEvent,
  transcriptItemsFromMessages,
  type OmpSubagentTranscriptItem,
} from './ompSubagentTranscript'
import type { JsonObject } from '@ompiui/protocol'

function feed(events: JsonObject[]): OmpSubagentTranscriptItem[] {
  return events.reduce((items, event) => appendTranscriptEvent(event, items), [] as OmpSubagentTranscriptItem[])
}

describe('subagent message groups', () => {
  it('reassembles streamed patches, replacements and message boundaries without duplicating rows', () => {
    const patch = (offset: number, text: string, phase = 'message_update'): JsonObject => ({
      type: 'message_patch', messageId: 'stream-1', role: 'assistant', phase,
      textOffset: offset, textDelta: text, textTailOffset: 0, textTail: 'Fallback',
    })
    const items = feed([
      patch(0, 'first'),
      patch(5, ' reply'),
      patch(0, 'revised'),
      patch(7, ' final', 'message_end'),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ text: 'revised final', textOffset: 0, streaming: false })
  })

  it('shows a recovery tail when subscribing mid-message and can later accept a full replacement', () => {
    const first: JsonObject = {
      type: 'message_patch', messageId: 'stream-1', role: 'assistant', phase: 'message_update',
      textOffset: 10000, textDelta: 'reply', textTailOffset: 9995, textTail: 'tail reply',
    }
    let items = feed([first])
    expect(items[0]).toMatchObject({ text: 'tail reply', textOffset: 9995 })
    items = appendTranscriptEvent({ ...first, textOffset: 10005, textDelta: ' complete' }, items)
    expect(items[0]).toMatchObject({ text: 'tail reply complete', textOffset: 9995 })
    items = appendTranscriptEvent({ ...first, textOffset: 0, textDelta: 'Full corrected message' }, items)
    expect(items[0]).toMatchObject({ text: 'Full corrected message', textOffset: 0 })
  })

  it('retains thinking-only activity and settles tool badges from compact message patches', () => {
    const items = feed([
      { type: 'message_patch', messageId: 'm1', role: 'assistant', phase: 'message_update',
        textOffset: 0, textDelta: '', thinking: 'Inspecting the implementation' },
      { type: 'message_patch', messageId: 'm1', role: 'assistant', phase: 'message_end',
        textOffset: 0, textDelta: 'Inspecting files', thinking: 'Inspecting the implementation',
        tools: [{ id: 'read-1', name: 'read', title: 'Read file' }] },
      { type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read' },
      { type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read' },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ text: 'Inspecting files', thinking: 'Inspecting the implementation', streaming: false })
    expect(items[1]).toMatchObject({ toolCallId: 'read-1', toolStatus: 'completed' })
  })

  it('updates a chunked user assignment in one row', () => {
    const items = feed([
      { type: 'message_patch', messageId: 'u1', role: 'user', phase: 'message_update', textOffset: 0, textDelta: 'Assignment' },
      { type: 'message_patch', messageId: 'u1', role: 'user', phase: 'message_end', textOffset: 10, textDelta: ' complete' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Assignment complete', streaming: false })
  })

  it('keeps IRC deliveries separate from the reply streaming around them', () => {
    const items = feed([
      { type: 'message_patch', messageId: 'a', role: 'assistant', phase: 'message_update', textOffset: 0, textDelta: 'Working' },
      { type: 'message_patch', messageId: 'irc', role: 'agent', phase: 'message_end', textOffset: 0, textDelta: 'Reviewer: Tests passed' },
      { type: 'message_patch', messageId: 'a', role: 'assistant', phase: 'message_end', textOffset: 7, textDelta: ' done' },
    ])
    expect(items.map(item => [item.kind, item.text])).toEqual([
      ['assistant', 'Working done'], ['agent', 'Reviewer: Tests passed'],
    ])
  })

  it('updates cumulative text and tool snapshots within the same assistant message', () => {
    const items = feed([
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking' }] } },
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking the source' },
            { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
          ],
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking the source' },
            { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
          ],
        },
      },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Checking the source', streaming: false })
    expect(items[1]).toMatchObject({ toolCallId: 'read-1', toolStatus: 'pending', streaming: false })
    expect(items[0].messageId).toBe(items[1].messageId)
  })

  it('shows tool start immediately and updates its badge on completion without duplication', () => {
    const start = feed([
      { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', title: 'Read README.md' },
    ])
    expect(start).toHaveLength(1)
    expect(start[0]).toMatchObject({ toolStatus: 'running', toolTitle: 'Read README.md' })
    const done = appendTranscriptEvent(
      { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', isError: true },
      start,
    )
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ toolStatus: 'error', isError: true, toolTitle: 'Read README.md' })
    expect(done[0].timestamp).toBe(start[0].timestamp)
    expect(done[0].messageId).toBe(start[0].messageId)
  })

  it('keeps simultaneous tools with the same name separate and settles out-of-order results by id', () => {
    const items = feed([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'a', name: 'read', arguments: {} },
            { type: 'toolCall', id: 'b', name: 'read', arguments: {} },
          ],
        },
      },
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read' },
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'read' },
      { type: 'tool_execution_end', toolCallId: 'b', toolName: 'read', isError: true },
      { type: 'tool_execution_end', toolCallId: 'a', toolName: 'read' },
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read' },
    ])
    expect(items.map(item => [item.toolCallId, item.toolStatus])).toEqual([
      ['a', 'completed'],
      ['b', 'error'],
    ])
  })

  it('does not collapse distinct assistant turns which contain only tools', () => {
    const items = feed([
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read' }] } },
      { type: 'tool_execution_end', toolCallId: 'a', toolName: 'read' },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'b', name: 'bash' }] } },
      { type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash' },
    ])
    expect(items).toHaveLength(2)
    expect(items[0].messageId).not.toBe(items[1].messageId)
  })

  it('restores the same grouping from disk and updates tools in place with their results', () => {
    const items = transcriptItemsFromMessages([
      { role: 'user', content: 'Review the source' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Inspecting files' },
          { type: 'toolCall', id: 'a', name: 'read' },
          { type: 'toolCall', id: 'b', name: 'grep' },
        ],
      },
      { role: 'toolResult', toolCallId: 'b', toolName: 'grep', isError: true },
      { role: 'toolResult', toolCallId: 'a', toolName: 'read' },
      { role: 'assistant', content: 'Review complete' },
    ])
    expect(items.map(item => item.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
    expect(new Set(items.slice(1, 4).map(item => item.messageId)).size).toBe(1)
    expect(items[2].toolStatus).toBe('completed')
    expect(items[3].toolStatus).toBe('error')
    expect(items[4].messageId).not.toBe(items[1].messageId)
  })

  it('keeps long final replies intact in both live events and disk history', () => {
    const text = `${'Complete findings. '.repeat(400)}FINAL_CONCLUSION`
    const live = feed([{ type: 'message_end', message: { role: 'assistant', content: text } }])
    const disk = transcriptItemsFromMessages([{ role: 'assistant', content: text }])
    expect(live[0].text).toBe(text)
    expect(disk[0].text).toBe(text)
  })

  it('preserves the assignment while bounding a long live or historical transcript', () => {
    const messages: JsonObject[] = [
      { role: 'user', content: 'Initial assignment' },
      ...Array.from({ length: 230 }, (_, index) => ({ role: 'assistant', content: `Reply ${index}` })),
    ]
    const disk = transcriptItemsFromMessages(messages)
    const live = feed(messages.map(message => ({ type: 'message_end', message })))
    for (const items of [live, disk]) {
      expect(items).toHaveLength(200)
      expect(items[0]).toMatchObject({ kind: 'user', text: 'Initial assignment' })
      expect(items.at(-1)?.text).toBe('Reply 229')
    }
  })
})
