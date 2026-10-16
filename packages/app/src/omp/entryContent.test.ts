import { expect, it, vi } from 'vitest'
import type { PiBranchPage } from './domain'
import { hydrateEntryContent } from './entryContent'

it('restores complete native entry identity and content from bounded encoded chunks', async () => {
  const entry = { id: 'native-entry', type: 'message', message: { role: 'assistant', content: '正文\n😀'.repeat(3000) } }
  const content = JSON.stringify(entry)
  const page = { items: [{ id: entry.id, type: 'ompiui.entry_ref', contentRef: { etag: 'etag', totalChars: content.length } }] } as unknown as PiBranchPage
  const read = vi.fn(async (entryId: string, offset: number, etag: string) => ({
    entryId, etag, totalChars: content.length, offset, content: content.slice(offset, offset + 1024),
    nextOffset: Math.min(content.length, offset + 1024),
  }))
  expect((await hydrateEntryContent(page, read)).items).toEqual([entry])
  expect(read.mock.calls.length).toBeGreaterThan(1)
  expect(page.items[0].type).toBe('ompiui.entry_ref')
})

it('stops entry hydration immediately when cancelled after a chunk', async () => {
  const controller = new AbortController()
  const page = { items: [{ id: 'e', type: 'ompiui.entry_ref', contentRef: { etag: 'etag', totalChars: 10 } }] } as unknown as PiBranchPage
  const read = vi.fn(async () => { controller.abort(); return {} })
  await expect(hydrateEntryContent(page, read, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(read).toHaveBeenCalledTimes(1)
})
