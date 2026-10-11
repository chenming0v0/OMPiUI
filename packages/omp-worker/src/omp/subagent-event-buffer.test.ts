import assert from "node:assert/strict"
import test from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { SubagentEventBuffer } from "./subagent-event-buffer.js"

test("ten concurrent subagents coalesce cumulative frames and preserve every boundary and final result", () => {
  const events: JsonObject[] = []
  const buffer = new SubagentEventBuffer(event => events.push(event))
  try {
    for (let index = 0; index < 10; index++) {
      buffer.push("lifecycle", { id: `child-${index}`, parentToolCallId: "task-call", index, status: "started" })
    }
    for (let token = 0; token < 10_000; token++) {
      for (let index = 0; index < 10; index++) {
        const id = `child-${index}`
        buffer.push("event", { id, event: { type: "message_update", message: { role: "assistant", content: `Token ${token}` } } })
        buffer.push("progress", { index, parentToolCallId: "task-call", progress: { id, tokens: token, status: "running" } })
      }
    }
    assert.equal(events.length, 10, "200000 updates must not create 200000 queued IPC messages")
    for (let index = 0; index < 10; index++) {
      const id = `child-${index}`
      buffer.push("event", { id, event: { type: "message_end", message: { role: "assistant", content: `Final ${index}` } } })
      buffer.push("lifecycle", { id, status: "completed" })
    }
    assert.equal(events.length, 50)
    for (let index = 0; index < 10; index++) {
      const run = events.filter(event => (event.payload as JsonObject).id === `child-${index}`)
      assert.deepEqual(run.map(event => event.kind), ["lifecycle", "event", "progress", "event", "lifecycle"])
      assert.equal(((run[2]!.payload as JsonObject).progress as JsonObject).tokens, 9999)
      assert.equal((((run[3]!.payload as JsonObject).event as JsonObject).message as JsonObject).content, `Final ${index}`)
    }
  } finally {
    buffer.dispose()
  }
})

test("live cumulative updates flush on a timer without waiting for message_end", async () => {
  const events: JsonObject[] = []
  const buffer = new SubagentEventBuffer(event => events.push(event), 10)
  try {
    buffer.push("event", { id: "live", event: { type: "message_update", message: { role: "assistant", content: "working" } } })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(events.length, 1)
  } finally {
    buffer.dispose()
  }
})
