import assert from "node:assert/strict"
import { setImmediate as nextTurn } from "node:timers/promises"
import { describe, it } from "node:test"
import type { WorkerMessage, WorkerRequest } from "./ipc.js"
import { createWorkerCommandScheduler } from "./worker-command-scheduler.js"
import { WorkerIpcSender } from "./worker-ipc-sender.js"

function request(id: string, type: string): WorkerRequest {
  return { kind: "request", id, generation: "generation", command: { type } }
}

function harness(execute: (type: string) => Promise<unknown>) {
  const delivered: WorkerMessage[] = []
  const sender = new WorkerIpcSender((message, done) => { delivered.push(message); done() }, () => {})
  const schedule = createWorkerCommandScheduler(async command => await execute(command.type) as never, sender, "generation")
  return { delivered, schedule }
}

describe("worker command scheduler error boundary", () => {
  it("returns the real message and a meaningful code instead of INTERNAL", async () => {
    const { delivered, schedule } = harness(async () => {
      throw Object.assign(new Error("Managed runtime operation timed out: submitUserMessage; result unknown"), { code: "OMP_TIMEOUT" })
    })
    await schedule(request("first", "sendUserMessage"))
    await nextTurn()
    const response = delivered[0] as Extract<WorkerMessage, { kind: "response" }>
    assert.equal(response.kind, "response")
    assert.equal(response.ok, false)
    assert.equal(response.ok === false && response.error.code, "WORKER_RESULT_UNKNOWN")
    assert.match(response.ok === false ? response.error.message : "", /submitUserMessage/)
    assert.match(response.ok === false ? response.error.message : "", /OMP_TIMEOUT/)
    await schedule.close(async () => {})
  })

  it("keeps serving other commands after one request fails", async () => {
    const executed: string[] = []
    const { delivered, schedule } = harness(async type => {
      executed.push(type)
      if (type === "sendUserMessage") throw Object.assign(new Error("not admitted"), { code: "SUBMISSION_NOT_ADMITTED" })
      return { ok: true }
    })
    await schedule(request("fails", "sendUserMessage"))
    await schedule(request("works", "setModel"))
    await nextTurn()
    assert.deepEqual(executed, ["sendUserMessage", "setModel"])
    const failed = delivered[0] as Extract<WorkerMessage, { kind: "response" }>
    const succeeded = delivered[1] as Extract<WorkerMessage, { kind: "response" }>
    assert.equal(failed.ok, false)
    assert.equal(failed.ok === false && failed.error.code, "SESSION_BUSY")
    assert.deepEqual(succeeded, { kind: "response", id: "works", generation: "generation", ok: true, data: { ok: true } })
    await schedule.close(async () => {})
  })
})
