import { isJsonObject, type JsonObject } from '@ompiui/protocol'
import type { PiBranchPage } from './domain'

type ReadChunk = (entryId: string, offset: number, etag: string) => Promise<JsonObject>

/** 大条目通过只读分片还原，页响应和每个分片仍受原有网络预算限制。 */
export async function hydrateEntryContent(page: PiBranchPage, read: ReadChunk, signal?: AbortSignal): Promise<PiBranchPage> {
  let changed = false
  const items: PiBranchPage['items'] = []
  for (const original of page.items) {
    const item = original as unknown as JsonObject
    if (item.type !== 'ompiui.entry_ref' || !isJsonObject(item.contentRef)) { items.push(original); continue }
    const ref = item.contentRef
    if (typeof item.id !== 'string' || typeof ref.etag !== 'string' ||
      typeof ref.totalChars !== 'number' || !Number.isSafeInteger(ref.totalChars) ||
      ref.totalChars < 1 || ref.totalChars > 64 * 1024 * 1024)
      throw new Error('Invalid entry content reference')
    const chunks: string[] = []
    let offset = 0
    while (offset < ref.totalChars) {
      signal?.throwIfAborted()
      const chunk = await read(item.id, offset, ref.etag)
      signal?.throwIfAborted()
      if (chunk.entryId !== item.id || chunk.etag !== ref.etag || chunk.offset !== offset ||
        chunk.totalChars !== ref.totalChars || typeof chunk.content !== 'string' ||
        typeof chunk.nextOffset !== 'number' || chunk.nextOffset !== offset + chunk.content.length ||
        chunk.nextOffset <= offset || chunk.nextOffset > ref.totalChars)
        throw new Error('Entry content changed or its chunks are incomplete')
      chunks.push(chunk.content)
      offset = chunk.nextOffset
    }
    const restored: unknown = JSON.parse(chunks.join(''))
    if (!isJsonObject(restored) || restored.id !== item.id) throw new Error('Invalid restored entry identity')
    items.push(restored as unknown as PiBranchPage['items'][number])
    changed = true
  }
  return changed ? { ...page, items } : page
}
