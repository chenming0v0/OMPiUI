import { describe, expect, it } from 'vitest'
import { appendSubmittedUserMessages, selectSubmittedQueueEntryIds } from './submittedMessages.js'
import type { PiTimelineItem } from '../domain/index.js'

const imageLabel = (count: number) => `${count} image(s)`
const record = {
  id: 'submitted:one',
  message: { role: 'user', timestamp: 123456, content: [
    { type: 'text', text: '现在发送' }, { type: 'image', data: 'AA==', mimeType: 'image/png' },
  ] },
}

describe('submitted user message projection', () => {
  it('restores the shared queue identity and waiting status without local pending state', () => {
    const submitted = { ...record, queueEntryId: 'native-queued', submissionStatus: 'queued' }
    expect([...selectSubmittedQueueEntryIds([submitted])]).toEqual(['native-queued'])
    expect(appendSubmittedUserMessages([], [submitted], imageLabel)).toMatchObject([
      { entryId: submitted.id, submissionStatus: 'queued', timestamp: record.message.timestamp },
    ])
    expect([...selectSubmittedQueueEntryIds([])]).toEqual([])
    expect([...selectSubmittedQueueEntryIds(undefined)]).toEqual([])
  })

  it('uses a localized attachment count instead of empty image thumbnails before persistence', () => {
    const submitted = { ...record, message: { ...record.message, content: [
      { type: 'image', data: '', mimeType: 'image/png', dataOmitted: true },
    ] } }
    const [item] = appendSubmittedUserMessages([], [submitted], imageLabel)
    expect(item).toMatchObject({ blocks: [{ type: 'text', text: '1 image(s)' }] })
    expect(item.kind === 'user_message' && item.message.content).toEqual([{ type: 'text', text: '1 image(s)' }])
  })

  it('shows accepted text and attachments without changing existing streaming rows', () => {
    const live = { kind: 'assistant_message', entryId: 'live', isStreaming: true } as PiTimelineItem
    const result = appendSubmittedUserMessages([live], [record], imageLabel)
    expect(result[0]).toBe(live)
    expect(result[1]).toMatchObject({ kind: 'user_message', entryId: record.id, blocks: record.message.content })
  })

  it('does not duplicate the native user message during persistence handoff', () => {
    const [native] = appendSubmittedUserMessages([], [record], imageLabel)
    const items = [{ ...native, entryId: 'native' }] as PiTimelineItem[]
    expect(appendSubmittedUserMessages(items, [record], imageLabel)).toBe(items)
    expect(appendSubmittedUserMessages(items, undefined, imageLabel)).toBe(items)
  })
})
