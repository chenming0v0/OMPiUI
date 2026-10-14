import assert from "node:assert/strict"
import { setImmediate as nextTurn } from "node:timers/promises"
import test from "node:test"
import type { WorkerMessage, WorkerRequest } from "./ipc.ts"
import { createWorkerCommandScheduler } from "./worker-command-scheduler.ts"
import { WorkerIpcSender } from "./worker-ipc-sender.ts"

function request(id: string, type: string): WorkerRequest {
  return { kind: "request", id, generation: "generation", command: { type } }
}

test("a blocked large response leaves control capacity and does not start another disk read", async () => {
  const delivered: WorkerMessage[] = []
  const callbacks: Array<(error?: Error) => void> = []
  const sender = new WorkerIpcSender((message, done) => {
    delivered.push(message)
    callbacks.push(done)
  }, () => {})
  let finishRead!: (value: string) => void
  const read = new Promise<string>(resolve => { finishRead = resolve })
  const executed: string[] = []
  const schedule = createWorkerCommandScheduler(async command => {
    executed.push(command.type)
    if (command.type === "branch.get") return read
    return null
  }, sender, "generation")

  const first = schedule(request("first", "branch.get"))
  const waiting = schedule(request("waiting", "branch.get"))
  const control = schedule(request("control", "abort"))
  await nextTurn()
  assert.deepEqual(executed, ["branch.get", "abort"])
  assert.equal(delivered[0]?.kind, "response")
  assert.equal((delivered[0] as { id: string }).id, "control")
  callbacks.shift()!()
  await control
  schedule.cancel("waiting")
  await waiting
  assert.deepEqual(executed, ["branch.get", "abort"])

  finishRead("complete")
  await nextTurn()
  assert.equal((delivered[1] as { id: string }).id, "first")
  callbacks.shift()!()
  await first
  await schedule.close(async () => {})
})
