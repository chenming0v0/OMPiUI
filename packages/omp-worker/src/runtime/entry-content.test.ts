import assert from "node:assert/strict"
import test from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { entryContentChunk } from "./entry-content.js"
import { entriesPageFromEntries, sessionHeadFromParts } from "./pagination.js"
import { hydrateEntryContent } from "../../../app/src/omp/entryContent.ts"

for (const text of ["x".repeat(5 * 1024 * 1024), "\u0001".repeat(700_000)]) {
  test(`oversized ${text.length} character entry roundtrips through bounded read-only chunks`, async () => {
    const entry: JsonObject = {
      type: "message", id: "big", parentId: "earlier", timestamp: "2026-10-15",
      message: { role: "assistant", content: text },
    }
    const head = sessionHeadFromParts({ sdkVersion: "test", revision: 1, header: { id: "s" }, leafId: "big", entryCount: 2 })
    const entries = [{ type: "model_change", id: "earlier", parentId: null }, entry] as JsonObject[]
    const page = entriesPageFromEntries(head, entries, { limit: 100, maxBytes: 128 * 1024 }, value => value)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 128 * 1024)
    assert.equal(page.items[0]?.type, "ompiui.entry_ref")
    let chunks = 0
    const diskEntry = { message: entry.message, timestamp: entry.timestamp, parentId: entry.parentId, id: entry.id, type: entry.type }
    const hydrated = await hydrateEntryContent(page as never, async (id, offset, etag) => {
      assert.equal(id, entry.id)
      // 模拟另一个只读 reader 的属性顺序不同，引用仍必须有效。
      const result = entryContentChunk(diskEntry, diskEntry, offset, etag)
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4 * 1024 * 1024)
      chunks++
      return result
    })
    assert.deepEqual(hydrated.items, [entry])
    assert.ok(chunks > 1)
    const previous = entriesPageFromEntries(head, entries, {
      limit: 100, maxBytes: 128 * 1024, cursor: page.beforeCursor,
    }, value => value)
    assert.equal(previous.items[0]?.id, "earlier")
    assert.equal(previous.hasMore, false)
    assert.equal((entry.message as JsonObject).content, text)
  })
}

test("a native ten-child aggregate larger than the requested page keeps its owner and newer completion", async () => {
  const owner: JsonObject = { type: "message", id: "owner", parentId: null,
    message: { role: "assistant", content: [{ type: "toolCall", id: "ten-task", name: "task", arguments: {} }] } }
  const result: JsonObject = { type: "message", id: "result", parentId: "owner",
    message: { role: "toolResult", toolCallId: "ten-task", toolName: "task", isError: false,
      content: [{ type: "text", text: "Native child transcript\n".repeat(6500) }] } }
  const completion: JsonObject = { type: "message", id: "done", parentId: "result",
    message: { role: "assistant", content: [{ type: "text", text: "All native children completed" }] } }
  const entries = [owner, result, completion]
  const head = sessionHeadFromParts({ sdkVersion: "test", revision: 1, header: null, leafId: "done", entryCount: 3 })
  const page = entriesPageFromEntries(head, entries, { limit: 100, maxBytes: 128 * 1024 }, value => value)
  assert.deepEqual(page.items.map(item => item.id), ["owner", "result", "done"])
  assert.equal(page.items[1]?.type, "ompiui.entry_ref")
  assert.equal(page.hasMore, false)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 128 * 1024)
  const restored = await hydrateEntryContent(page as never, async (id, offset, etag) => {
    assert.equal(id, "result")
    return entryContentChunk(result, result, offset, etag)
  })
  assert.deepEqual(restored.items, entries)
})

test("checkpoint and first entry share the budget by omitting live, not by rejecting readable history", () => {
  const entry: JsonObject = { type: "message", id: "one", message: { role: "assistant", content: "x".repeat(3 * 1024 * 1024) } }
  const head = sessionHeadFromParts({ sdkVersion: "test", revision: 1, header: null, leafId: "one", entryCount: 1 })
  const checkpoint = { position: { epoch: "e", sequence: 1 }, liveMessage: {
    id: "live", revision: 1, phase: "streaming" as const, message: { content: "x".repeat(2 * 1024 * 1024) },
  } }
  const page = entriesPageFromEntries(head, [entry], { limit: 100, maxBytes: 4 * 1024 * 1024, checkpoint }, value => value)
  assert.deepEqual(page.items, [entry])
  assert.equal(page.checkpoint?.liveMessageOmitted, true)
  assert.equal(page.checkpoint?.liveMessage, undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4 * 1024 * 1024)
  assert.ok(checkpoint.liveMessage)
})
