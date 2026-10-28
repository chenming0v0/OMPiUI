import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isJsonObject, type JsonObject } from "@ompiui/protocol"
import { entryContentChunk, entryContentReference } from "./entry-content.js"
import { entriesPageFromEntries, projectEntryAttachments, sessionHeadFromParts } from "./pagination.js"
import { hydrateEntryContent } from "../../../app/src/omp/entryContent.ts"
import { OmpRpcSession } from "../omp/omp-session.js"
import { OmpCatalog } from "../omp/omp-catalog.js"

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

test("a large history entry and live checkpoint share the page budget through read-only content", async () => {
  const entry: JsonObject = { type: "message", id: "one", message: { role: "assistant", content: "x".repeat(3 * 1024 * 1024) } }
  const head = sessionHeadFromParts({ sdkVersion: "test", revision: 1, header: null, leafId: "one", entryCount: 1 })
  const checkpoint = { position: { epoch: "e", sequence: 1 }, liveMessage: {
    id: "live", revision: 1, phase: "streaming" as const, message: { content: "x".repeat(2 * 1024 * 1024) },
  } }
  const page = entriesPageFromEntries(head, [entry], { limit: 100, maxBytes: 4 * 1024 * 1024, checkpoint }, value => value)
  const restored = await hydrateEntryContent(page as never, async (_id, offset, etag) => entryContentChunk(entry, entry, offset, etag))
  assert.deepEqual(restored.items, [entry])
  assert.deepEqual(page.checkpoint?.liveMessage, checkpoint.liveMessage)
  assert.equal(page.checkpoint?.liveMessageOmitted, undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4 * 1024 * 1024)
  assert.ok(checkpoint.liveMessage)
})

test("snapcompact image history hydrates from the same native runtime that produced its reference", async () => {
  const frames = Array.from({ length: 5 }, (_, index) => ({
    mimeType: "image/png", data: Buffer.alloc(73_500 + index * 1_000, index).toString("base64"),
    cols: 196, rows: 71, chars: 12_862, font: "8x13", variant: "bw", lineRepeat: 1, detail: "original",
  }))
  const native: JsonObject = { type: "compaction", id: "snap", parentId: null, timestamp: "2026-10-28",
    method: "snapcompact", summary: "Compressed context", preserveData: { snapcompact: { frames } } }
  const disk: JsonObject = { ...native, preserveData: { snapcompact: { frames: frames.map(frame => ({
    ...frame, data: `blob:sha256:${createHash("sha256").update(Buffer.from(frame.data, "base64")).digest("hex")}`,
  })) } } }
  const session = Object.assign(Reflect.construct(OmpRpcSession, []) as OmpRpcSession, {
    sessionId: "snap-session", entries: [native], leafId: "snap", entriesSeeded: true,
  })
  const page = await session.getBranchPage(undefined, 100, 128 * 1024)
  assert.equal(page.items[0]?.type, "ompiui.entry_ref")
  const ref = page.items[0]?.contentRef
  assert.ok(isJsonObject(ref) && typeof ref.etag === "string")
  const etag = ref.etag
  // The persisted blob form is not the native expanded content, despite having the same entry id.
  assert.throws(() => entryContentChunk(disk, disk, 0, etag), { code: "STALE_REVISION" })
  const hydrated = await hydrateEntryContent(page as never, (id, offset, revision) => session.getEntryContent(id, offset, revision))
  assert.deepEqual(hydrated.items, [native])
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 128 * 1024)
  await assert.rejects(session.getEntryContent("missing"), { code: "NOT_FOUND" })
  Object.assign(session, { entries: [{ ...native, summary: "Actually changed history" }] })
  await assert.rejects(session.getEntryContent("snap", 0, etag), { code: "STALE_REVISION" })
})

test("appending history and evicting encoded content cannot stale an unchanged image entry", async () => {
  const image = { type: "image", mimeType: "image/png", data: Buffer.alloc(75_000, 7).toString("base64") }
  const originalData = image.data
  const entry: JsonObject = { type: "message", id: "image", parentId: null, timestamp: "2026-10-28", message: {
    role: "user", content: [{ type: "text", text: "Historical text\n".repeat(12_000) }, image],
  } }
  const entries: JsonObject[] = [entry]
  const session = Object.assign(Reflect.construct(OmpRpcSession, []) as OmpRpcSession, {
    sessionId: "append-session", entries, leafId: "image", entriesSeeded: true,
  })
  const page = await session.getBranchPage(undefined, 100, 128 * 1024)
  const projected = projectEntryAttachments(entry, session.getHead())
  entries.push({ type: "message", id: "newer", parentId: "image", timestamp: "2026-10-28", message: { role: "assistant", content: "New reply" } })
  Object.assign(session, { leafId: "newer" })
  for (let index = 0; index < 3; index++) {
    const unrelated: JsonObject = { id: `evict-${index}`, content: `Other reader ${index}` }
    entryContentReference(unrelated, unrelated)
  }
  const hydrated = await hydrateEntryContent(page as never, (id, offset, etag) => session.getEntryContent(id, offset, etag))
  assert.deepEqual(hydrated.items, [projected])
  assert.equal(image.data, originalData)
})

test("disk image references hydrate after catalog replacement without modifying official history", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-entry-content-"))
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, data: process.env.OMPIUI_DATA_DIR }
  process.env.PI_CODING_AGENT_DIR = root
  process.env.OMPIUI_DATA_DIR = path.join(root, "webui")
  const project = path.join(root, "sessions", "project")
  mkdirSync(project, { recursive: true })
  const file = path.join(project, "history.jsonl")
  const entry: JsonObject = { type: "message", id: "image", parentId: null, timestamp: "2026-10-28", message: {
    role: "user", content: [{ type: "text", text: "Preserved history\n".repeat(12_000) },
      { type: "image", mimeType: "image/png", data: `blob:sha256:${"a".repeat(64)}` }],
  } }
  writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "disk-session", cwd: root }), JSON.stringify(entry)].join("\n") + "\n")
  const before = readFileSync(file)
  const modified = statSync(file).mtimeMs
  const writer = new OmpCatalog()
  const reader = new OmpCatalog()
  t.after(async () => {
    await writer.dispose()
    await reader.dispose()
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous.agent
    if (previous.data === undefined) delete process.env.OMPIUI_DATA_DIR
    else process.env.OMPIUI_DATA_DIR = previous.data
    rmSync(root, { recursive: true, force: true })
  })
  const preview = await writer.previewSessionById("disk-session", { limit: 100, maxBytes: 128 * 1024 })
  assert.ok(isJsonObject(preview) && isJsonObject(preview.branch))
  const branch = preview.branch
  const hydrated = await hydrateEntryContent(branch as never, async (id, offset, etag) => {
    const chunk = await reader.readSession("disk-session", "entry.get", { entryId: id, offset, etag })
    assert.ok(isJsonObject(chunk))
    return chunk
  })
  const head = sessionHeadFromParts({ sdkVersion: "test", revision: 0, header: { id: "disk-session" }, leafId: "image", entryCount: 2 })
  assert.deepEqual(hydrated.items, [projectEntryAttachments(entry, head)])
  assert.deepEqual(readFileSync(file), before)
  assert.equal(statSync(file).mtimeMs, modified)
})
