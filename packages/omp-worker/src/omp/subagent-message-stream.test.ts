import assert from "node:assert/strict"
import test from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { SubagentMessageStream } from "./subagent-message-stream.js"

function feed(stream: SubagentMessageStream, id: string, type: string, text: string): void {
  stream.push({ kind: "event", payload: { id, event: { type, message: { role: "assistant", content: text } } } })
}

function inner(frame: JsonObject): JsonObject {
  return (frame.payload as JsonObject).event as JsonObject
}

test("preview patches retain the worker generation and never share counters across reused native ids", () => {
  const frames: JsonObject[] = []
  const stream = new SubagentMessageStream(frame => frames.push(frame))
  for (const runId of ["old", "new"]) {
    stream.push({ kind: "event", payload: { id: "child", runId, parentToolCallId: "owner", event: {
      type: "message_update", message: { role: "assistant", content: "same text" },
    } } })
    stream.push({ kind: "progress", payload: { id: "child", runId, progress: { tokens: 10 } } })
  }
  const patches = frames.filter(frame => frame.kind === "event")
  assert.deepEqual(patches.map(frame => (frame.payload as JsonObject).runId), ["old", "new"])
  assert.notEqual(inner(patches[0]!).messageId, inner(patches[1]!).messageId)
  assert.ok(patches.every(frame => inner(frame).textOffset === 0))
  assert.ok(frames.filter(frame => frame.kind === "progress").every(frame => (frame.payload as JsonObject).progressDelta === false))
})

test("large cumulative snapshots become bounded lossless chunks and retain one message identity", () => {
  const frames: JsonObject[] = []
  const stream = new SubagentMessageStream(frame => frames.push(frame))
  const text = "正文\n😀".repeat(50000)
  feed(stream, "child", "message_start", "")
  feed(stream, "child", "message_update", text)
  feed(stream, "child", "message_end", text + "FINAL")
  let restored = ""
  const ids = new Set<string>()
  for (const frame of frames) {
    const patch = inner(frame)
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 50000)
    assert.equal(patch.textOffset, restored.length)
    restored += String(patch.textDelta)
    ids.add(String(patch.messageId))
  }
  assert.equal(restored, text + "FINAL")
  assert.equal(ids.size, 1)
  assert.equal(inner(frames.at(-1)!).phase, "message_end")
})

test("growing messages send only new text while keeping a bounded recovery tail", () => {
  const frames: JsonObject[] = []
  const stream = new SubagentMessageStream(frame => frames.push(frame))
  let text = ""
  for (let index = 0; index < 100; index++) {
    text += "x".repeat(1000)
    feed(stream, "child", "message_update", text)
  }
  const deltaBytes = frames.reduce((sum, frame) => sum + String(inner(frame).textDelta).length, 0)
  assert.equal(deltaBytes, text.length)
  assert.ok(frames.every(frame => String(inner(frame).textTail).length <= 2048))
  assert.ok(JSON.stringify(frames).length < 400000, "wire volume must not grow with cumulative snapshots")
})

test("text deltas do not repeat unchanged tools or thinking, while final recovery remains complete", () => {
  const frames: JsonObject[] = []
  const stream = new SubagentMessageStream(frame => frames.push(frame), () => true)
  const tools = Array.from({ length: 6 }, (_, index) => ({
    type: "toolCall", id: `tool-${index}`, name: "read", arguments: { path: "x".repeat(400) },
  }))
  const push = (type: string, text: string) => stream.push({ kind: "event", payload: { id: "a", event: {
    type, message: { role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking: "plan" }, ...tools] },
  } } })
  for (let index = 1; index <= 30; index++) push("message_update", "x".repeat(index * 300))
  assert.equal(frames.filter(frame => inner(frame).tools !== undefined).length, 1)
  assert.equal(frames.filter(frame => inner(frame).thinking !== undefined).length, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(frames)) < 20000)
  push("message_update", "x".repeat(9000))
  assert.equal(frames.length, 30)
  tools.push({ type: "toolCall", id: "new", name: "read", arguments: { path: "changed" } })
  push("message_update", "x".repeat(9000))
  assert.equal((inner(frames.at(-1)!).tools as unknown[]).length, 7)
  push("message_end", "x".repeat(9000))
  assert.equal((inner(frames.at(-1)!).tools as unknown[]).length, 7)
  assert.equal(inner(frames.at(-1)!).thinking, "plan")
})

test("message revisions replace text and concurrent children never share state", () => {
  const frames: JsonObject[] = []
  const stream = new SubagentMessageStream(frame => frames.push(frame))
  feed(stream, "a", "message_update", "first")
  feed(stream, "b", "message_update", "other")
  feed(stream, "a", "message_update", "replacement")
  assert.equal(inner(frames[2]!).textOffset, 0)
  assert.equal(inner(frames[2]!).messageId, inner(frames[0]!).messageId)
  assert.notEqual(inner(frames[1]!).messageId, inner(frames[0]!).messageId)
  feed(stream, "a", "message_end", "replacement")
  feed(stream, "a", "message_update", "next turn")
  assert.notEqual(inner(frames[4]!).messageId, inner(frames[0]!).messageId)
})

test("a new message boundary gets its own identity even when a provider reuses response ids", () => {
  const frames: JsonObject[] = []
  const stream = new SubagentMessageStream(frame => frames.push(frame))
  const message = (type: string, text: string) => stream.push({ kind: "event", payload: {
    id: "a", event: { type, messageId: "reused-provider-id", message: { role: "assistant", content: text } },
  } })
  message("message_start", "")
  message("message_update", "first")
  stream.push({ kind: "lifecycle", payload: { id: "a", sessionFile: "child.jsonl" } })
  message("message_end", "first reply")
  message("message_start", "")
  message("message_end", "second reply")
  assert.equal(inner(frames[0]!).messageId, inner(frames[3]!).messageId)
  assert.notEqual(inner(frames[0]!).messageId, inner(frames[4]!).messageId)
  assert.equal(inner(frames[3]!).textOffset, 5, "metadata-only lifecycle frames must not reset the stream")
})

test("large IRC deliveries are chunked without resetting the assistant streaming around them", () => {
  const frames: JsonObject[] = []
  const stream = new SubagentMessageStream(frame => frames.push(frame))
  feed(stream, "a", "message_update", "working")
  stream.push({ kind: "event", payload: { id: "a", event: {
    type: "irc_message", message: { role: "agent", content: "Reviewer: " + "report".repeat(10000) },
  } } })
  feed(stream, "a", "message_end", "working done")
  assert.equal(inner(frames.at(-1)!).messageId, inner(frames[0]!).messageId)
  assert.equal(inner(frames.at(-1)!).textOffset, 7)
  assert.ok(frames.slice(1, -1).every(frame => JSON.stringify(frame).length < 15000))
})

test("a failed empty final snapshot does not erase the partial reply already received", () => {
  const frames: JsonObject[] = []
  const stream = new SubagentMessageStream(frame => frames.push(frame))
  feed(stream, "a", "message_update", "Partial findings")
  stream.push({ kind: "event", payload: { id: "a", event: {
    type: "message_end", message: { role: "assistant", content: [], stopReason: "error" },
  } } })
  assert.equal(inner(frames[1]!).textOffset, "Partial findings".length)
  assert.equal(inner(frames[1]!).textDelta, "")
  assert.equal(inner(frames[1]!).phase, "message_end")
})
