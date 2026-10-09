import { describe, expect, it } from 'vitest'
import { appendSubmittedUserMessages } from './submittedMessages.js'
import type { PiTimelineItem } from '../domain/index.js'

const record = {
  id: 'submitted:one',
  message: { role: 'user', timestamp: 123456, content: [
    { type: 'text', text: '现在发送' }, { type: 'image', data: 'AA==', mimeType: 'image/png' },
  ] },
}

describe('submitted user message projection', () => {
  it('shows accepted text and attachments without changing existing streaming rows', () => {
    const live = { kind: 'assistant_message', entryId: 'live', isStreaming: true } as PiTimelineItem
    const result = appendSubmittedUserMessages([live], [record])
    expect(result[0]).toBe(live)
    expect(result[1]).toMatchObject({ kind: 'user_message', entryId: record.id, blocks: record.message.content })
  })

  it('does not duplicate the native user message during persistence handoff', () => {
    const [native] = appendSubmittedUserMessages([], [record])
    const items = [{ ...native, entryId: 'native' }] as PiTimelineItem[]
    expect(appendSubmittedUserMessages(items, [record])).toBe(items)
    expect(appendSubmittedUserMessages(items, undefined)).toBe(items)
  })
})
