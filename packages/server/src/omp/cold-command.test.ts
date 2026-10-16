import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EventHub } from "../event-hub.ts"
import { SessionHost } from "./session-host.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import type { WorkerSession } from "./worker-client.ts"
import type { SubmittedCommand } from "./session-executor.ts"

function fixture(t: TestContext) {
  const previous = process.env.OMPIUI_DRIVER
  process.env.OMPIUI_DRIVER = "mock"
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const executed: string[] = []
  const file = join(tmpdir(), `cold-command-${randomUUID()}.jsonl`)
  let opens = 0
  const worker = {
    async command(type: string) { executed.push(type); return {} },
    getSessionId: () => "cold", getCwd: () => ".", getSessionFile: () => file,
    onEvent: () => () => {}, onCrash: () => () => {}, onClose: () => () => {},
    async dispose() {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    async catalogCommand(type: string) {
      assert.equal(type, "session.listAll")
      await gate
      return [{ id: "cold", cwd: ".", path: file }]
    },
    async open() { opens++; return worker },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  t.after(async () => {
    release()
    await host.dispose()
    if (previous === undefined) delete process.env.OMPIUI_DRIVER
    else process.env.OMPIUI_DRIVER = previous
  })
  return { host, release, executed, opens: () => opens,
    usage: () => host as unknown as { pendingAttachBytes: number; pendingAttachCommands: number } }
}

test("a cancelled cold command never submits after shared attachment, while another consumer succeeds", async t => {
  const f = fixture(t)
  const controller = new AbortController()
  const cancelled = Promise.resolve(f.host.executeSessionCommand("cold", "prompt", { text: "cancel" }, "cancel", { signal: controller.signal }))
  const surviving = Promise.resolve(f.host.executeSessionCommand("cold", "prompt", { text: "continue" }, "continue"))
  controller.abort()
  await assert.rejects(cancelled, { code: "REQUEST_ABORTED" })
  assert.equal(f.host.getCommand("cancel"), undefined)
  f.release()
  const accepted = await surviving as SubmittedCommand
  await accepted.promise
  assert.equal(f.opens(), 1)
  assert.equal(f.executed.filter(type => type === "prompt").length, 1)
  assert.equal(f.host.getCommand("cancel"), undefined)
  assert.equal(f.usage().pendingAttachBytes, 0)
  assert.equal(f.usage().pendingAttachCommands, 0)
})

test("cold command bytes reject before attachment and refund immediately after cancellation", async t => {
  const f = fixture(t)
  const text = "x".repeat(8 * 1024 * 1024)
  const controllers = Array.from({ length: 3 }, () => new AbortController())
  const waiting = controllers.map((controller, index) => {
    const request = Promise.resolve(f.host.executeSessionCommand("cold", "prompt", { text }, `pending-${index}`, { signal: controller.signal }))
    return assert.rejects(request, { code: "REQUEST_ABORTED" })
  })
  assert.throws(() => f.host.executeSessionCommand("cold", "prompt", { text }, "over-capacity"), { code: "RATE_LIMITED" })
  assert.equal(f.opens(), 0)
  controllers.forEach(controller => controller.abort())
  await Promise.all(waiting)
  assert.equal(f.usage().pendingAttachBytes, 0)
  assert.equal(f.usage().pendingAttachCommands, 0)
  f.release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.executed.filter(type => type === "prompt").length, 0)
})
