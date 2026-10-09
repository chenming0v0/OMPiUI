import assert from "node:assert/strict"
import { test } from "node:test"
import { SessionHost } from "../omp/session-host.ts"
import { EventHub } from "../event-hub.ts"
import type { RuntimeSupervisor } from "../omp/supervisor.ts"
import { diagnostics, type DiagnosticFields } from "./recorder.ts"
import { traceWorkerRequest } from "./worker-request.ts"

test("runtime reaping records the busy decision and the actual closing reason", async t => {
  const records: Array<{ event: string; fields: DiagnosticFields }> = []
  t.mock.method(diagnostics, "record", (event: string, fields: DiagnosticFields = {}) => { records.push({ event, fields }) })
  let streaming = true
  const commands: string[] = []
  const worker = {
    command: async (type: string) => {
      commands.push(type)
      return { isStreaming: streaming, isIdle: !streaming, pendingMessageCount: 0 }
    },
    getSessionId: () => "s1", getSessionFile: () => undefined, getCwd: () => ".",
    onEvent: () => () => {}, onCrash: () => () => {}, onClose: () => () => {},
    dispose: async () => { commands.push("dispose") },
  }
  const supervisor = { onEvent: () => () => {}, open: async () => worker } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  t.after(() => host.dispose())
  await host.openSession(".")
  const internal = host as unknown as { lastAccess: Map<string, number>; reapIdleRuntimes: () => Promise<void> }
  internal.lastAccess.set("s1", 0)
  await internal.reapIdleRuntimes()
  assert.equal(records.find(record => record.event === "session.reaper.kept")?.fields.reason, "runtime_busy")
  assert.equal(commands.includes("abort"), false)
  streaming = false
  internal.lastAccess.set("s1", 0)
  await internal.reapIdleRuntimes()
  assert.equal(records.find(record => record.event === "session.close.requested")?.fields.reason, "idle_ttl")
  assert.equal(records.find(record => record.event === "session.close.completed")?.fields.reason, "idle_ttl")
  assert.ok(commands.includes("abort"))
  assert.ok(commands.includes("dispose"))
})

test("request tracing separates caller cancellation from agent abort and excludes error text", t => {
  const records: Array<{ event: string; fields: DiagnosticFields; level?: string }> = []
  t.mock.method(diagnostics, "record", (event: string, fields: DiagnosticFields = {}, level?: string) => {
    records.push({ event, fields, level })
  })
  traceWorkerRequest({ sessionId: "s1", requestId: "r1", command: "state.get" })
    .failed(Object.assign(new Error("PRIVATE ERROR"), { code: "REQUEST_ABORTED" }))
  traceWorkerRequest({ sessionId: "s1", requestId: "r2", command: "abort" }).completed({})
  assert.equal(records.find(record => record.event === "worker.request.failed")?.fields.reason, "caller_cancelled_request_not_agent_abort")
  const abort = records.find(record => record.event === "worker.request.started" && record.fields.command === "abort")!
  assert.equal(abort.level, "info")
  assert.equal(abort.fields.requestId, "r2")
  assert.ok(!JSON.stringify(records).includes("PRIVATE ERROR"))
})
