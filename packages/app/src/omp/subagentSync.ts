import {
  isJsonObject,
  subagentBlockHash,
  type JsonObject,
  type JsonValue,
  type SubagentDataBlock,
  type SubagentSyncPage,
  type SubagentSyncRequest,
} from '@ompiui/protocol'
import { loadSubagentBlocks, saveSubagentBlocks } from './subagentBlockCache'

const BYTE_LIMIT = 8 * 1024 * 1024
const MESSAGE_LIMIT = 2000
const encoder = new TextEncoder()
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
  let continuing = Boolean(validSaved && saved?.hasMore)
  const retainedWindow = Boolean(validSaved && saved!.blocks[0].fromByte > 0)
  let cursor = continuing ? saved!.nextByte : retainedWindow ? saved!.blocks[0].fromByte : (fromByte ?? 0)
  let snapshot = continuing || retainedWindow ? saved!.snapshot : undefined
  let projection = continuing || retainedWindow ? saved!.projection : ''
  let blocks = continuing ? [...saved!.blocks] : []
  let downloaded = 0
  let pages = 0
  let restarts = 0
  let hasMore = false
  let reset = false
  let windowed = retainedWindow
  let bytes = blocks.reduce((sum, block) => sum + encoder.encode(JSON.stringify(block.messages)).byteLength, 0)
  let messageCount = blocks.reduce((sum, block) => sum + block.messages.length, 0)
  do {
    signal.throwIfAborted()
    const knownBlocks = [...available.values()]
      .filter(block => block.fromByte >= cursor)
      .sort((a, b) => a.fromByte - b.fromByte)
      .slice(0, 32)
      .map(({ fromByte, nextByte, hash }) => ({ fromByte, nextByte, hash }))
    let raw: JsonValue
    try {
      raw = await fetchPage(cursor, signal, { version: 1, snapshot, knownBlocks })
    } catch (error) {
      if ((error as { code?: string }).code !== 'SYNC_SNAPSHOT_EXPIRED' || restarts++ >= 2) throw error
      cursor = fromByte ?? 0
      snapshot = undefined
      blocks = []
      downloaded = bytes = pages = messageCount = 0
      continuing = false
      reset = true
      windowed = false
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
      if (restarts++ >= 2) throw new Error('Subagent reuse block unavailable')
      hasMore = true
      continue
    }
    if (page.fromByte !== cursor || position !== page.nextByte || (page.hasMore && page.nextByte <= cursor))
      throw new Error('Transcript cursor did not advance')
    for (const block of resolved) {
      const size = encoder.encode(JSON.stringify(block.messages)).byteLength
      if (page.blocks.find(ref => ref.fromByte === block.fromByte)?.kind === 'data') downloaded += size
      blocks.push(block)
      available.set(block.fromByte, block)
      bytes += size
      messageCount += block.messages.length
    }
    cursor = page.nextByte
    hasMore = page.hasMore
    pages++
    // 续页允许读取新内容后再淘汰最旧块，避免每次“加载更多”都从头下载。
    if (continuing) {
      while (blocks.length > 1 && (bytes > BYTE_LIMIT || messageCount > MESSAGE_LIMIT)) {
        const removed = blocks.shift()!
        windowed = true
        bytes -= encoder.encode(JSON.stringify(removed.messages)).byteLength
        messageCount -= removed.messages.length
      }
    }
  } while (
    hasMore &&
    downloaded < BYTE_LIMIT &&
    pages < 64 &&
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
