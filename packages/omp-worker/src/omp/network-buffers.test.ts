import assert from "node:assert/strict"
import test from "node:test"
import { splitUtf8Text, type JsonObject } from "@ompiui/protocol"
import { WorkerIpcSender } from "../worker-ipc-sender.js"
import type { WorkerMessage } from "../ipc.js"
import { EventSnapshotBuffer } from "./event-snapshot-buffer.js"
import { imageAttachmentFromEntry, projectEntryAttachments, sessionHeadFromParts } from "../runtime/pagination.js"

test("UTF-8 chunks stay within their byte budget and round-trip mixed text", () => {
  const text = "正文😀\\\n".repeat(20000)
  const chunks = splitUtf8Text(text, 32 * 1024)
  assert.equal(chunks.join(""), text)
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 32 * 1024))
  assert.ok(chunks.every(chunk => Buffer.from(chunk).toString("utf8") === chunk))
})

test("IPC byte backpressure counts in-flight bytes and resumes after flush", () => {
  const callbacks: Array<(error?: Error) => void> = []
  const pauses: boolean[] = []
  const sender = new WorkerIpcSender((_message, done) => callbacks.push(done), value => pauses.push(value), 100, 512)
  sender.send({ kind: "event", event: { text: "x".repeat(220) } } as unknown as WorkerMessage)
  assert.deepEqual(pauses, [true])
  callbacks.shift()!()
  assert.deepEqual(pauses, [true, false])
})

test("snapshot buffers coalesce large values and preserve subsequent event ordering", () => {
  const emitted: JsonObject[] = []
  const buffer = new EventSnapshotBuffer<JsonObject>(event => emitted.push(event))
  buffer.push("a", "snapshot", { text: "x".repeat(600000) })
  buffer.push("b", "snapshot", { text: "y".repeat(600000) })
  assert.equal(emitted.length, 0)
  buffer.push("a", "snapshot", { id: "update" })
  buffer.push("a", undefined, { id: "end" })
  assert.deepEqual(emitted.map(event => event.id), ["update", "end"])
  buffer.flush()
  assert.equal(emitted.length, 3)
  assert.equal(emitted[2]!.text, "y".repeat(600000))
})

test("attachments are delivered in lossless bounded base64 pages", () => {
  const data = Buffer.alloc(900000, 7).toString("base64")
  const entry = { message: { content: [{ type: "image", mimeType: "image/png", data }] } }
  let offset = 0
  let restored = ""
  for (;;) {
    const page = imageAttachmentFromEntry(entry, 0, offset)
    assert.ok(String(page.data).length <= 256 * 1024)
    restored += page.data
    if (!page.hasMore) break
    offset = Number(page.nextOffset)
  }
  assert.equal(restored, data)
  assert.throws(() => imageAttachmentFromEntry(entry, 0, 1), { code: "INVALID_REQUEST" })
})

test("projected images bind session, epoch and bytes without mutating native history", () => {
  const image = { type: "image", mimeType: "image/png", data: `blob:sha256:${"a".repeat(64)}` }
  const entry: JsonObject = { id: "native-entry", message: { content: [image], details: [{ nested: [image] }] } }
  const head = sessionHeadFromParts({ sdkVersion: "18.12.6", revision: 0, header: { id: "native-session" }, leafId: "native-entry", entryCount: 1 })
  const projected = projectEntryAttachments(entry, head)
  const message = projected.message as JsonObject
  const content = message.content as JsonObject[]
  assert.deepEqual(content[0]?.attachment, { sessionId: "native-session", entryId: "native-entry", blockIndex: 0, source: "content", epoch: head.epoch, etag: `"${"a".repeat(64)}"` })
  assert.equal(content[0]?.data, "")
  assert.equal(image.data, `blob:sha256:${"a".repeat(64)}`)
  assert.match(JSON.stringify(message.details), /"source":"details"/)
  assert.throws(() => imageAttachmentFromEntry(entry, 0, 0, "invalid" as "content"), { code: "INVALID_REQUEST" })
})
