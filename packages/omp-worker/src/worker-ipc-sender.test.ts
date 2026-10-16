import assert from "node:assert/strict"
import test from "node:test"
import type { WorkerMessage } from "./ipc.js"
import { WorkerIpcSender } from "./worker-ipc-sender.js"

test("normal count exhaustion preserves bounded control and heartbeat slots", () => {
  const sent: WorkerMessage[] = []
  const callbacks: (() => void)[] = []
  const sender = new WorkerIpcSender((message, done) => {
    sent.push(message)
    callbacks.push(done)
  }, () => {}, 2)
  const response = (id: string): WorkerMessage => ({ kind: "response", id, generation: "test", ok: true })
  for (let index = 0; index < 4; index++) sender.send(response(String(index)))
  assert.throws(() => sender.send(response("excess")), { code: "RATE_LIMITED" })
  sender.sendControl(response("control"))
  sender.send({ kind: "heartbeat", generation: "test", timestamp: 1 })
  assert.throws(() => sender.sendControl(response("excess-control")), { code: "RATE_LIMITED" })
  while (callbacks.length) callbacks.shift()!()
  assert.equal(sent.length, 6)
  assert.equal(sent[1]?.kind, "heartbeat")
  assert.equal(sent[2]?.kind === "response" && sent[2].id, "control")
})

test("IPC waits for flush, pauses producers, prioritizes heartbeats and preserves final replies", () => {
  const sent: WorkerMessage[] = []
  const callbacks: (() => void)[] = []
  const paused: boolean[] = []
  const sender = new WorkerIpcSender((message, done) => {
    sent.push(message)
    callbacks.push(done)
  }, value => paused.push(value), 4)
  const response = (id: string): WorkerMessage => ({ kind: "response", id, generation: "test", ok: true })
  for (let index = 0; index < 6; index++) sender.send(response(String(index)))
  sender.send({ kind: "heartbeat", generation: "test", timestamp: 1 })
  sender.send({ kind: "heartbeat", generation: "test", timestamp: 2 })
  let finished = false
  sender.send(response("final"), () => { finished = true })
  assert.equal(sent.length, 1)
  assert.deepEqual(paused, [true])
  while (callbacks.length) callbacks.shift()!()
  assert.equal(sent.length, 8)
  assert.equal(sent[1]?.kind, "heartbeat")
  assert.deepEqual(sent.filter(message => message.kind === "response").map(message => message.id), ["0", "1", "2", "3", "4", "5", "final"])
  assert.deepEqual(paused, [true, false])
  assert.equal(finished, true)
})
