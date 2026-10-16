import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import { setImmediate as nextTurn } from "node:timers/promises"
import test from "node:test"
import { createWorkerCommandScheduler } from "./worker-command-scheduler.js"
import { WorkerIpcSender } from "./worker-ipc-sender.js"
import type { WorkerMessage, WorkerParentMessage } from "./ipc.js"

test("the production message entry cancels queued work and ignores another generation", async () => {
  const delivered: WorkerMessage[] = []
  const executed: string[] = []
  const sender = new WorkerIpcSender((message, done) => { delivered.push(message); done() }, () => {})
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const schedule = createWorkerCommandScheduler(async command => {
    executed.push(String(command.params?.name))
    await gate
    return null
  }, sender, "generation")
  const source = readFileSync(new URL("./entry.ts", import.meta.url), "utf8")
  const start = source.indexOf('process.on("message",')
  const end = source.indexOf('process.on("disconnect",', start)
  assert.ok(start > 0 && end > start)
  let receive!: (message: WorkerParentMessage) => void
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), {
    process: { on(_event: string, handler: typeof receive) { receive = handler } },
    schedule, workerGeneration: "generation",
    sendControl(message: WorkerMessage) { delivered.push(message) },
  })
  receive({ kind: "request", id: "first", generation: "generation", command: { type: "branch.get", params: { name: "first" } } })
  receive({ kind: "request", id: "cancelled", generation: "generation", command: { type: "branch.get", params: { name: "cancelled" } } })
  receive({ kind: "cancel", id: "first", generation: "another" })
  receive({ kind: "cancel", id: "cancelled", generation: "generation" })
  await nextTurn()
  assert.deepEqual(executed, ["first"])
  release()
  await nextTurn()
  await schedule.close(async () => {})
  assert.deepEqual(executed, ["first"])
  assert.deepEqual(delivered.flatMap(message => message.kind === "response" ? [message.id] : []), ["first"])
})
