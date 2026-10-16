import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { WorkerIpcSender } from "./worker-ipc-sender.js"
import { boundedWorkerEvent } from "./worker-event-budget.js"
import type { WorkerMessage } from "./ipc.js"

test("an oversized event crosses the production send boundary as an omission without terminating its runtime", () => {
  const delivered: WorkerMessage[] = []
  const sender = new WorkerIpcSender((message, done) => { delivered.push(message); done() }, () => {})
  const source = readFileSync(new URL("./entry.ts", import.meta.url), "utf8")
  const start = source.indexOf("function send(message:")
  const end = source.indexOf("\nfunction sendControl(", start)
  let crashes = 0
  const context = {
    ipcSender: sender, boundedWorkerEvent, failedOutputSessions: new Set(),
    process: { connected: true }, failWorkerIpc: () => { crashes++ },
    closeRuntime: () => { crashes++; return Promise.resolve() }, workerGeneration: "g", console,
  }
  const send = runInNewContext(stripTypeScriptTypes(`${source.slice(start, end)}\nsend`), context) as (message: WorkerMessage) => void
  const event: WorkerMessage = { kind: "event", generation: "g", sessionId: "s", channel: "pi.event",
    meta: { epoch: "e", sequence: 1 }, event: { type: "tool_execution_end", result: "x".repeat(9 * 1024 * 1024) } }
  send(event)
  send({ kind: "event", generation: "g", sessionId: "s", channel: "session.head", head: { revision: 2 } })
  assert.equal(crashes, 0)
  assert.equal(delivered.length, 2)
  assert.equal(delivered[0]!.kind, "event")
  const omitted = delivered[0] as Extract<WorkerMessage, { channel: "payload.omitted" }>
  assert.equal(omitted.channel, "payload.omitted")
  assert.equal(omitted.event.channel, "pi.event")
  assert.ok(Number(omitted.event.originalBytes) > sender.responseByteLimit)
  assert.ok(Buffer.byteLength(JSON.stringify(omitted)) < 1024)
  assert.equal("result" in omitted.event, false)
  assert.equal((delivered[1] as { channel: string }).channel, "session.head")
})
