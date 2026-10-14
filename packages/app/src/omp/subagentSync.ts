import {
  isJsonObject,
  jsonByteSize,
  subagentBlockHash,
  type JsonObject,
  type JsonValue,
  type SubagentDataBlock,
  type SubagentSyncPage,
  type SubagentSyncRequest,
} from '@ompiui/protocol'
import { loadSubagentBlocks, saveSubagentBlocks } from './subagentBlockCache'

const BYTE_LIMIT = 8 * 1024 * 1024
const PAGE_BYTE_LIMIT = 256 * 1024
const REQUEST_LIMIT = 64
const MESSAGE_LIMIT = 2000
export type FetchSubagentPage = (cursor: number, signal: AbortSignal, sync?: SubagentSyncRequest) => Promise<JsonValue>

export async function readSyncedSubagentHistory(
  key: string,
  fromByte: number | undefined,
  fetchPage: FetchSubagentPage,
  signal: AbortSignal,
): Promise<JsonValue> {
  const saved = fromByte === undefined ? await loadSubagentBlocks(key) : undefined
  signal.throwIfAborted()
  // 从持久缓存恢复时先检查正文与哈希，损坏的块不参与缓存声明。
  const available = new Map<number, SubagentDataBlock>()
  if (saved && Array.isArray(saved.blocks)) {
    for (const block of saved.blocks) {
      if (Array.isArray(block.messages) && subagentBlockHash(saved.projection, block) === block.hash)
        available.set(block.fromByte, block)
    }
  }
  const validSaved = Boolean(saved?.blocks.length && available.size === saved.blocks.length)
  const resuming = Boolean(validSaved && saved?.hasMore)
  const retainedWindow = Boolean(validSaved && saved!.blocks[0].fromByte > 0)
  let continuing = resuming || retainedWindow
  let windowStart = retainedWindow ? saved!.blocks[0].fromByte : (fromByte ?? 0)
  let cursor = resuming ? saved!.nextByte : windowStart
  // 跨轮刷新从保留窗口建立新快照；只有尚未读完的分页才携带旧快照。
  let snapshot = resuming ? saved!.snapshot : undefined
  let projection = resuming ? saved!.projection : ''
  let blocks = resuming ? [...saved!.blocks] : []
  let downloaded = 0
  let pages = 0
  let restarts = 0
  let hasMore = false
  let reset = false
  let windowed = retainedWindow
  let bytes = blocks.reduce((sum, block) => sum + jsonByteSize(block.messages, BYTE_LIMIT), 0)
  let messageCount = blocks.reduce((sum, block) => sum + block.messages.length, 0)
  const canRequest = () => pages < REQUEST_LIMIT && downloaded <= BYTE_LIMIT - PAGE_BYTE_LIMIT
  do {
    signal.throwIfAborted()
    const knownBlocks = [...available.values()]
      .filter(block => block.fromByte >= cursor)
      .sort((a, b) => a.fromByte - b.fromByte)
      .slice(0, 32)
      .map(({ fromByte, nextByte, hash }) => ({ fromByte, nextByte, hash }))
    let raw: JsonValue
    try {
      pages++
      raw = await fetchPage(cursor, signal, { version: 1, snapshot, knownBlocks })
    } catch (error) {
      if (
        !error || typeof error !== 'object' || !('code' in error) || error.code !== 'SYNC_SNAPSHOT_EXPIRED' ||
        restarts++ >= 2 ||
        !canRequest()
      ) throw error
      // 丢弃快照中的正文，但保留窗口起点和哈希；新快照必须重新验证每个块。
      cursor = blocks[0]?.fromByte ?? windowStart
      windowStart = cursor
      snapshot = undefined
      blocks = []
      bytes = messageCount = 0
      reset = true
      hasMore = true
      continue
    }
    signal.throwIfAborted()
    if (!isJsonObject(raw) || raw.syncVersion !== 1) {
      throw Object.assign(new Error('Subagent sync is unsupported'), {
        code: 'SYNC_UNSUPPORTED',
        legacyPage: raw,
        legacyCursor: cursor,
      })
    }
    const pageBytes = jsonByteSize(raw, PAGE_BYTE_LIMIT)
    if (pageBytes > PAGE_BYTE_LIMIT)
      throw Object.assign(new Error('Subagent sync page exceeds 256 KiB'), { code: 'FILE_TOO_LARGE' })
    // 包括复用引用、封装及重启前已经收到的页；重试不能重新获得一轮预算。
    downloaded += pageBytes
    const page = raw as unknown as SubagentSyncPage
    if (
      !Array.isArray(page.blocks) ||
      typeof page.snapshot !== 'string' ||
      typeof page.projection !== 'string' ||
      !Number.isSafeInteger(page.nextByte) ||
      page.nextByte < 0 ||
      (snapshot && page.snapshot !== snapshot) ||
      (snapshot && page.projection !== projection)
    ) {
      throw new Error('Invalid subagent sync page')
    }
    if (page.reset) {
      blocks = []
      bytes = messageCount = 0
      cursor = page.fromByte
      windowStart = cursor
      continuing = false
      reset = true
      windowed = false
    }
    projection = page.projection
    snapshot = page.snapshot
    const resolved: SubagentDataBlock[] = []
    let position = cursor
    let missing = false
    for (const ref of page.blocks) {
      if (ref.fromByte !== position || !Number.isSafeInteger(ref.nextByte) || ref.nextByte <= position)
        throw new Error('Invalid subagent block range')
      const block = ref.kind === 'data' ? ref : ref.kind === 'reuse' ? available.get(ref.fromByte) : undefined
      if (
        !block ||
        block.nextByte !== ref.nextByte ||
        block.hash !== ref.hash ||
        !Array.isArray(block.messages) ||
        subagentBlockHash(projection, block) !== ref.hash
      ) {
        if (ref.kind === 'data') throw new Error('Subagent block hash mismatch')
        available.delete(ref.fromByte)
        missing = true
        break
      }
      resolved.push(block)
      position = block.nextByte
    }
    if (missing) {
      if (restarts++ >= 2 || !canRequest()) throw new Error('Subagent reuse block unavailable')
      hasMore = true
      continue
    }
    if (page.fromByte !== cursor || position !== page.nextByte || (page.hasMore && page.nextByte <= cursor))
      throw new Error('Transcript cursor did not advance')
    for (const block of resolved) {
      const size = jsonByteSize(block.messages, BYTE_LIMIT)
      blocks.push(block)
      available.set(block.fromByte, block)
      bytes += size
      messageCount += block.messages.length
    }
    cursor = page.nextByte
    hasMore = page.hasMore
    // 续页和保留窗口刷新都淘汰最旧块，以便在原有预算内读到新增尾部。
    if (continuing) {
      while (blocks.length > 1 && (bytes > BYTE_LIMIT || messageCount > MESSAGE_LIMIT)) {
        const removed = blocks.shift()!
        windowed = true
        bytes -= jsonByteSize(removed.messages, BYTE_LIMIT)
        messageCount -= removed.messages.length
      }
    }
  } while (
    hasMore &&
    canRequest() &&
    (continuing || (bytes < BYTE_LIMIT && messageCount < MESSAGE_LIMIT))
  )
  signal.throwIfAborted()
  if (fromByte === undefined)
    await saveSubagentBlocks({
      key,
      projection,
      snapshot: snapshot!,
      blocks,
      nextByte: cursor,
      hasMore,
    })
  signal.throwIfAborted()
  const messages: JsonObject[] = blocks.flatMap(block => block.messages).slice(-MESSAGE_LIMIT)
  return {
    messages,
    fromByte: fromByte ?? 0,
    nextByte: cursor,
    reset,
    hasMore,
    truncated: hasMore || windowed || messageCount > MESSAGE_LIMIT || blocks.some(block => block.previewTruncated),
  }
}
