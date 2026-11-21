import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subagentBlockHash, type SubagentDataBlock, type SubagentSyncRequest } from '@ompiui/protocol'
import { readSyncedSubagentHistory } from './subagentSync'
import { clearSubagentBlockMemory, saveSubagentBlocks, type CachedSubagentHistory } from './subagentBlockCache'

const projection = 'subagent-preview-v1:thinking-off'
const records = new Map<string, unknown>()
const writes: string[] = []

// 独立保留数据库记录，清空模块内存后复现页面刷新时的持久恢复。
function memoryDatabase() {
  return {
    open: () => {
      const request = {
        result: {
          transaction: () => {
            let pending = 0
            const enqueue = (read: () => void) => {
              pending++
              queueMicrotask(() => {
                read()
                if (--pending === 0) tx.oncomplete?.()
              })
            }
            const tx = {
              oncomplete: null as (() => void) | null,
              objectStore: (store: string) => ({
                get: (key: string) => {
                  const read = { result: undefined as unknown, onsuccess: null as (() => void) | null }
                  enqueue(() => {
                    read.result = structuredClone(records.get(`${store}:${key}`))
                    read.onsuccess?.()
                  })
                  return read
                },
                getAll: () => {
                  const read = { result: [] as unknown[], onsuccess: null as (() => void) | null }
                  enqueue(() => {
                    read.result = [...records]
                      .filter(([key]) => key.startsWith(`${store}:`))
                      .map(([, value]) => structuredClone(value))
                    read.onsuccess?.()
                  })
                  return read
                },
                put: (value: unknown, key: string) => {
                  writes.push(`${store}:${key}`)
                  records.set(`${store}:${key}`, structuredClone(value))
                },
                delete: (key: string) => {
                  writes.push(`${store}:${key}`)
                  records.delete(`${store}:${key}`)
                },
              }),
            }
            return tx
          },
        },
        onsuccess: null as (() => void) | null,
      }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
  }
}

function block(text: string, fromByte = 0, nextByte = 100): SubagentDataBlock {
  const body = { fromByte, nextByte, messages: [{ role: 'assistant', content: text }], previewTruncated: false }
  return { ...body, kind: 'data', hash: subagentBlockHash(projection, body) }
}

function response(blocks: SubagentDataBlock[], sync?: SubagentSyncRequest, snapshot = 'snapshot') {
  return {
    syncVersion: 1,
    snapshot,
    projection,
    fromByte: blocks[0]?.fromByte ?? 0,
    nextByte: blocks.at(-1)?.nextByte ?? 0,
    hasMore: false,
    reset: false,
    blocks: blocks.map(block =>
      sync?.knownBlocks.some(ref => ref.hash === block.hash)
        ? {
            kind: 'reuse',
            fromByte: block.fromByte,
            nextByte: block.nextByte,
            hash: block.hash,
            previewTruncated: false,
          }
        : block,
    ),
  }
}

describe('persistent conditional child history', () => {
  beforeEach(() => {
    clearSubagentBlockMemory()
    records.clear()
    writes.length = 0
    vi.stubGlobal('indexedDB', memoryDatabase())
  })
  afterEach(() => {
    clearSubagentBlockMemory()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('restores bodies after reload without rewriting unchanged complete histories', async () => {
    const body = block('cached history')
    let wire = ''
    let version = 0
    const fetch = vi.fn(async (_cursor, _signal, sync) => {
      const page = response([body], sync, `snapshot-${++version}`)
      wire = JSON.stringify(page)
      return page
    })
    const signal = new AbortController().signal
    await readSyncedSubagentHistory('server/child', undefined, fetch, signal)
    expect(writes.splice(0)).toEqual(['histories:server/child', 'metadata:server/child'])
    await readSyncedSubagentHistory('server/child', undefined, fetch, signal)
    clearSubagentBlockMemory()
    const result = await readSyncedSubagentHistory('server/child', undefined, fetch, signal)
    expect(result).toMatchObject({ messages: [{ content: 'cached history' }] })
    expect(wire).not.toContain('cached history')
    expect(fetch.mock.calls[2][2]).toMatchObject({
      snapshot: undefined,
      knownBlocks: [{ fromByte: 0, nextByte: 100, hash: body.hash }],
    })
    expect(writes).toEqual([])
  })

  it('saves a changed continuation snapshot and clears the checkpoint on completion', async () => {
    const body = block('cached history')
    const checkpoint: CachedSubagentHistory = {
      key: 'child', projection, blocks: [body], nextByte: 100, hasMore: true, snapshot: 'old',
    }
    await saveSubagentBlocks(checkpoint)
    writes.length = 0
    await saveSubagentBlocks({ ...checkpoint, snapshot: 'current' }, true)
    expect(writes.splice(0)).toEqual(['histories:child', 'metadata:child'])
    clearSubagentBlockMemory()

    const fetch = vi.fn(async (_cursor, _signal, _sync) => ({
      ...response([], undefined, 'current'), fromByte: 100, nextByte: 100,
    }))
    const signal = new AbortController().signal
    expect(await readSyncedSubagentHistory('child', undefined, fetch, signal)).toMatchObject({
      messages: body.messages, nextByte: 100, hasMore: false,
    })
    expect(fetch).toHaveBeenCalledWith(100, signal, { version: 1, snapshot: 'current', knownBlocks: [] })
    expect(writes).toEqual(['histories:child', 'metadata:child'])
    expect(records.get('histories:child')).toMatchObject({ nextByte: 100, hasMore: false })
  })

  it('keeps eviction ordered by recent use without writing on an unchanged refresh', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => ++now)
    const fetch = vi.fn(async (_cursor, _signal, sync) => response([block('history')], sync))
    const signal = new AbortController().signal
    const read = (key: string) => readSyncedSubagentHistory(key, undefined, fetch, signal)
    for (let index = 0; index < 64; index++) await read(`child-${index}`)
    writes.length = 0

    await read('child-0')
    expect(writes).toEqual([])
    await read('child-64')
    expect(writes).toEqual(['histories:child-1', 'metadata:child-1', 'histories:child-64', 'metadata:child-64'])
    expect(records.size).toBe(128)
    expect(records.has('histories:child-0')).toBe(true)
  })

  it('does not persist an explicit cursor read', async () => {
    const fetch = vi.fn(async () => response([block('tail', 100, 200)]))
    expect(await readSyncedSubagentHistory('child', 100, fetch, new AbortController().signal)).toMatchObject({
      messages: [{ content: 'tail' }], fromByte: 100, nextByte: 200,
    })
    expect(writes).toEqual([])
  })

  it('combines reused blocks with new data and removes stale replaced messages', async () => {
    const first = block('old')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response([first]))
      .mockImplementationOnce(async (_cursor, _signal, sync) =>
        response([first, block('added', 100, 200)], sync, 'appended'),
      )
      .mockResolvedValueOnce(response([block('replacement')], undefined, 'replaced'))
    const signal = new AbortController().signal
    await readSyncedSubagentHistory('child', undefined, fetch, signal)
    expect(await readSyncedSubagentHistory('child', undefined, fetch, signal)).toMatchObject({
      messages: [{ content: 'old' }, { content: 'added' }],
    })
    expect(await readSyncedSubagentHistory('child', undefined, fetch, signal)).toMatchObject({
      messages: [{ content: 'replacement' }],
    })
  })

  it('drops corrupted stored bodies from knownBlocks instead of accepting a hash alone', async () => {
    const body = block('original')
    const fetch = vi.fn(async (_cursor, _signal, sync) => response([body], sync))
    const signal = new AbortController().signal
    await readSyncedSubagentHistory('child', undefined, fetch, signal)
    clearSubagentBlockMemory()
    const stored = records.get('histories:child') as { blocks: SubagentDataBlock[] }
    stored.blocks[0].messages[0].content = 'damaged'
    writes.length = 0
    expect(await readSyncedSubagentHistory('child', undefined, fetch, signal)).toMatchObject({
      messages: [{ content: 'original' }],
    })
    expect(fetch.mock.calls[1][2].knownBlocks).toEqual([])
    expect(writes).toEqual(['histories:child', 'metadata:child'])
    expect(records.get('histories:child')).toMatchObject({ blocks: [body] })
  })

  it('retries a missing reuse block without declaring it again', async () => {
    const body = block('recovered')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ...response([body]),
        blocks: [
          {
            kind: 'reuse',
            fromByte: 0,
            nextByte: 100,
            hash: body.hash,
            previewTruncated: false,
          },
        ],
      })
      .mockResolvedValueOnce(response([body]))
    expect(await readSyncedSubagentHistory('missing', undefined, fetch, new AbortController().signal)).toMatchObject({
      messages: [{ content: 'recovered' }],
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][2].knownBlocks).toEqual([])
  })

  it('keeps different server and credential namespaces separate', async () => {
    const body = block('private')
    const fetch = vi.fn(async (_cursor, _signal, sync) => response([body], sync))
    const signal = new AbortController().signal
    await readSyncedSubagentHistory('server-a/user-a/child', undefined, fetch, signal)
    await readSyncedSubagentHistory('server-b/user-b/child', undefined, fetch, signal)
    expect(fetch.mock.calls[1][2].knownBlocks).toEqual([])
  })

  it('restarts an expired snapshot while reusing bodies already validated in earlier pages', async () => {
    const first = block('first')
    const next = block('next', 100, 200)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ...response([first]), hasMore: true })
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'SYNC_SNAPSHOT_EXPIRED' }))
      .mockImplementationOnce(async (_cursor, _signal, sync) => response([first, next], sync, 'fresh'))
    expect(await readSyncedSubagentHistory('changing', undefined, fetch, new AbortController().signal)).toMatchObject({
      messages: [{ content: 'first' }, { content: 'next' }],
      reset: true,
    })
    expect(fetch.mock.calls.map(call => call[0])).toEqual([0, 100, 0])
    expect(fetch.mock.calls[2][2].knownBlocks).toContainEqual({
      fromByte: 0,
      nextByte: 100,
      hash: first.hash,
    })
  })

  it('loads more from the saved cursor rather than downloading the first window again', async () => {
    const first = {
      ...block(''),
      messages: Array.from({ length: 2000 }, () => ({ role: 'assistant', content: 'old' })),
    }
    first.hash = subagentBlockHash(projection, first)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ...response([first]), hasMore: true })
      .mockResolvedValueOnce(response([block('newest', 100, 200)]))
      .mockImplementationOnce(async (_cursor, _signal, sync) => response([block('newest', 100, 200)], sync))
    const signal = new AbortController().signal
    await readSyncedSubagentHistory('large', undefined, fetch, signal)
    const result = await readSyncedSubagentHistory('large', undefined, fetch, signal)
    expect(fetch.mock.calls.map(call => call[0])).toEqual([0, 100])
    expect(result).toMatchObject({ messages: [{ content: 'newest' }], truncated: true })
    clearSubagentBlockMemory()
    expect(await readSyncedSubagentHistory('large', undefined, fetch, signal)).toMatchObject({
      messages: [{ content: 'newest' }],
      truncated: true,
    })
    expect(fetch.mock.calls.map(call => call[0])).toEqual([0, 100, 100])
  })

  it.each([
    { boundary: 'requests', payloadBytes: 32, expireAt: 32 },
    { boundary: 'bytes', payloadBytes: 250000, expireAt: 15 },
  ])('keeps the total $boundary budget across a snapshot restart', async ({ boundary, payloadBytes, expireAt }) => {
    let requests = 0
    let receivedBytes = 0
    let generation = 0
    const fetch = async (cursor: number) => {
      if (++requests === expireAt) {
        generation++
        throw Object.assign(new Error('changed'), { code: 'SYNC_SNAPSHOT_EXPIRED' })
      }
      const body = block(`${generation}:` + 'x'.repeat(payloadBytes), cursor, cursor + 100)
      const page = { ...response([body], undefined, `snapshot-${generation}`), hasMore: true }
      receivedBytes += new TextEncoder().encode(JSON.stringify(page)).byteLength
      return page
    }
    const result = await readSyncedSubagentHistory('bounded', undefined, fetch, new AbortController().signal)
    expect(result).toMatchObject({ reset: true, hasMore: true })
    expect(requests).toBeLessThanOrEqual(64)
    expect(receivedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    if (boundary === 'requests') expect(requests).toBe(64)
  })

  it('rejects a corrupt network body', async () => {
    const damaged = block('original')
    damaged.messages[0].content = 'corrupt'
    await expect(
      readSyncedSubagentHistory(
        'damaged',
        undefined,
        vi.fn().mockResolvedValue(response([damaged])),
        new AbortController().signal,
      ),
    ).rejects.toThrow('hash mismatch')
  })
})
