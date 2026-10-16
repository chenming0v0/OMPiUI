import assert from "node:assert/strict"
import test from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { MainMessageStream } from "./main-message-stream.js"
import { SubagentMessageStream } from "./subagent-message-stream.js"
import { WorkerIpcSender } from "../worker-ipc-sender.js"
import type { WorkerMessage } from "../ipc.js"

for (const kind of ["main", "subagent"] as const) {
  test(`${kind} snapshot pauses within its 65 fragments and resumes losslessly through real IPC`, () => {
    const delivered: WorkerMessage[] = []
    const callbacks: Array<() => void> = []
    let stream: MainMessageStream | SubagentMessageStream
    const errors: Error[] = []
    const sender = new WorkerIpcSender((message, done) => {
      delivered.push(message)
      callbacks.push(done)
    }, paused => stream.setPaused(paused))
    const emit = (event: JsonObject) => sender.send({
      kind: "event", generation: "test", sessionId: "s", channel: "omp.subagent", event,
    }, error => { if (error) errors.push(error) })
    stream = kind === "main" ? new MainMessageStream(emit) : new SubagentMessageStream(emit, () => false)
    const text = "x".repeat(4096 * 65)
    if (stream instanceof MainMessageStream) {
      stream.push({ type: "message_update", message: {
        role: "assistant", content: Array.from({ length: 65 }, () => ({ type: "text", text: "x" })),
      } })
    } else {
      stream.push({ kind: "event", payload: { id: "child", event: {
        type: "message_end", message: { role: "assistant", content: text },
      } } })
    }
    sender.sendControl({ kind: "response", generation: "test", id: "control", ok: true })
    assert.equal(sender.isPaused, true)
    assert.equal(delivered.length, 1)
    for (let turns = 0; callbacks.length && turns < 1000; turns++) callbacks.shift()!()
    assert.deepEqual(errors, [])
    const events = delivered.flatMap(message => message.kind === "event" ? [message.event] : [])
    assert.equal(events.length, 65)
    if (kind === "subagent") assert.equal(events.map(frame => (frame.payload as JsonObject).event)
      .map(event => (event as JsonObject).textDelta).join(""), text)
    else assert.equal(events.at(-1)?.complete, true)
    assert.equal(sender.isPaused, false)
    assert.ok(delivered.some(message => message.kind === "response" && message.id === "control"))
  })
}
