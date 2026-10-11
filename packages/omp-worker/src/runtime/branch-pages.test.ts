import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { EntriesPage, JsonObject, SessionHead } from "@ompiui/protocol"
import { BranchPageReader } from "./branch-pages.js"

const options = { limit: 100, maxBytes: 2 * 1024 * 1024 }
const entry = (id: string, text = id) => ({ id, message: { role: "toolResult", content: [{ type: "text", text }] } })
function head(entries: { id: string }[]): SessionHead {
  return { sdkVersion: "test", revision: entries.length, header: null, leafId: entries.at(-1)?.id ?? null,
    entryCount: entries.length, epoch: `history:${entries.length}` }
}
const identity = (entry: JsonObject) => entry
const sync = (page: EntriesPage) => ({ syncCursor: page.syncCursor, beforeId: page.items[0]?.id as string | undefined })

describe("incremental branch pages", () => {
  it("returns only appended entries, including empty deltas on repeated refreshes", () => {
    const reader = new BranchPageReader<ReturnType<typeof entry>>()
    const entries = [entry("a"), entry("b")]
    const full = reader.read(head(entries), entries, options, identity)
    entries.push(entry("c"))
    const delta = reader.read(head(entries), entries, { ...options, ...sync(full) }, identity)
    assert.equal(delta.deltaFrom, full.syncCursor)
    assert.deepEqual(delta.items.map(item => item.id), ["c"])
    const unchanged = reader.read(head(entries), entries, { ...options, syncCursor: delta.syncCursor, beforeId: "a" }, identity)
    assert.deepEqual(unchanged.items, [])
    assert.equal(unchanged.syncCursor, delta.syncCursor)
    assert.equal(unchanged.hasMore, false)
  })

  it("refreshes the oldest visible cursor when appending changes the history epoch", () => {
    const reader = new BranchPageReader<ReturnType<typeof entry>>()
    const entries = [entry("a"), entry("b"), entry("c"), entry("d")]
    const full = reader.read(head(entries), entries, { ...options, limit: 2 }, identity)
    const older = reader.read(head(entries), entries, { ...options, cursor: full.beforeCursor, limit: 1 }, identity)
    assert.equal(older.items[0]?.id, "b")
    entries.push(entry("e"))
    const delta = reader.read(head(entries), entries, { ...options, syncCursor: full.syncCursor, beforeId: "b" }, identity)
    assert.equal(delta.hasMore, true)
    const oldest = reader.read(head(entries), entries, { ...options, cursor: delta.beforeCursor }, identity)
    assert.deepEqual(oldest.items.map(item => item.id), ["a"])
    assert.equal(oldest.hasMore, false)
    assert.equal(oldest.syncCursor, undefined)
  })

  it("falls back on branch navigation, rewritten entries, restart, or an invalid baseline", () => {
    const entries = [entry("a"), entry("b"), entry("c")]
    for (const change of [
      (items: typeof entries) => items.slice(0, 2),
      (items: typeof entries) => [items[0]!, items[1]!, entry("fork")],
      (items: typeof entries) => items.map(item => ({ ...item })),
    ]) {
      const reader = new BranchPageReader<ReturnType<typeof entry>>()
      const full = reader.read(head(entries), entries, options, identity)
      const changed = change(entries)
      const result = reader.read(head(changed), changed, { ...options, ...sync(full) }, identity)
      assert.equal(result.deltaFrom, undefined)
      assert.deepEqual(result.items, changed)
    }
    const reader = new BranchPageReader<ReturnType<typeof entry>>()
    const full = reader.read(head(entries), entries, options, identity)
    for (const syncRequest of [{ syncCursor: "old-process", beforeId: "a" }, { syncCursor: full.syncCursor, beforeId: "missing" }]) {
      assert.equal(reader.read(head(entries), entries, { ...options, ...syncRequest }, identity).deltaFrom, undefined)
    }
  })

  it("keeps recent baselines for two clients and falls back after bounded eviction", () => {
    const reader = new BranchPageReader<ReturnType<typeof entry>>()
    const entries = [entry("a")]
    const first = reader.read(head(entries), entries, options, identity)
    entries.push(entry("b"))
    const second = reader.read(head(entries), entries, options, identity)
    entries.push(entry("c"))
    assert.deepEqual(reader.read(head(entries), entries, { ...options, ...sync(first) }, identity).items.map(item => item.id), ["b", "c"])
    assert.deepEqual(reader.read(head(entries), entries, { ...options, ...sync(second) }, identity).items.map(item => item.id), ["c"])
    for (let i = 0; i < 5; i++) {
      entries.push(entry(`new-${i}`))
      reader.read(head(entries), entries, options, identity)
    }
    assert.equal(reader.read(head(entries), entries, { ...options, ...sync(first) }, identity).deltaFrom, undefined)
  })

  it("uses a bounded full page if the append exceeds the entry or byte budget", () => {
    const reader = new BranchPageReader<ReturnType<typeof entry>>()
    const entries = [entry("a")]
    const full = reader.read(head(entries), entries, options, identity)
    entries.push(entry("b", "x".repeat(2000)), entry("c", "y".repeat(2000)))
    for (const limits of [{ limit: 1, maxBytes: 10000 }, { limit: 100, maxBytes: 3000 }]) {
      const page = reader.read(head(entries), entries, { ...limits, ...sync(full) }, identity)
      assert.equal(page.deltaFrom, undefined)
      assert.deepEqual(page.items.map(item => item.id), ["c"])
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= limits.maxBytes)
    }
  })

  it("supports the first append to an empty branch and still sends fresh live checkpoints", () => {
    const reader = new BranchPageReader<ReturnType<typeof entry>>()
    const entries: ReturnType<typeof entry>[] = []
    const full = reader.read(head(entries), entries, options, identity)
    entries.push(entry("a"))
    const checkpoint = { position: { epoch: "events", sequence: 10 }, liveMessage: {
      id: "live", revision: 10, phase: "streaming" as const, message: { role: "assistant", content: "thinking" },
    } }
    const delta = reader.read(head(entries), entries, { ...options, ...sync(full), checkpoint }, identity)
    assert.equal(delta.deltaFrom, full.syncCursor)
    assert.deepEqual(delta.items, entries)
    assert.deepEqual(delta.checkpoint, checkpoint)
  })
})
