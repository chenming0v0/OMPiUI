import assert from "node:assert/strict"
import childProcess, { type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { setImmediate as nextTurn } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import { OMP_WORKER_PROTOCOL_VERSION } from "@ompiui/omp-worker"
import type { JsonValue } from "@ompiui/protocol"
import { diagnostics } from "../diagnostics/recorder.ts"
import type { SessionLease } from "./session-lease.ts"
import { RuntimeSupervisor } from "./supervisor.ts"

type WireMessage = {
  kind: string
  id: string
  generation: string
  sessionId?: string
  command?: { type: string }
}

class MemoryChild extends EventEmitter {
  connected = true
  readonly sent: WireMessage[] = []
  readonly callbacks: Array<{ message: WireMessage; done: (error: Error | null) => void }> = []

  send(message: WireMessage, done: (error: Error | null) => void): boolean {
    this.sent.push(message)
    this.callbacks.push({ message, done })
    return false
  }

  complete(message: WireMessage, error: Error | null = null): void {
    const index = this.callbacks.findIndex(entry => entry.message === message)
    assert.notEqual(index, -1, "message must still have an IPC callback")
    this.callbacks.splice(index, 1)[0].done(error)
  }

  reply(message: WireMessage, data?: JsonValue, ok = true): void {
    this.emit("message", {
      kind: "response", id: message.id, generation: message.generation, ok,
      ...(ok ? { data } : { error: { code: "CLOSE_FAILED", message: "runtime is still active" } }),
    })
  }

  request(type: string): WireMessage {
    const message = this.sent.filter(entry => entry.command?.type === type).at(-1)
    assert.ok(message, `missing ${type} request`)
    return message
  }

  kill(): boolean { this.emit("exit", 0, null); return true }
}

function fixture(t: TestContext, options: { ready?: boolean; requestTimeoutMs?: number } = {}) {
  const child = new MemoryChild()
  t.mock.method(childProcess, "fork", () => child as unknown as ChildProcess)
  t.mock.method(childProcess, "spawn", () => { throw new Error("real process spawn forbidden") })
  syncBuiltinESMExports()
  t.mock.method(diagnostics, "record", () => undefined)
  t.mock.method(console, "error", () => undefined)
  t.mock.method(console, "info", () => undefined)
  const held = new Set<string>()
  const releases: string[] = []
  const supervisor = new RuntimeSupervisor({
    workerEntry: new URL("./worker-client-fixture.mjs", import.meta.url),
    worker: { requestTimeoutMs: options.requestTimeoutMs },
    leases: {
      async acquire(file) {
        if (held.has(file)) throw Object.assign(new Error("session busy"), { code: "SESSION_BUSY" })
        held.add(file)
        return {
          async refresh() {},
          release() {
            assert.equal(held.delete(file), true, "lease must settle exactly once")
            releases.push(file)
          },
        } as unknown as SessionLease
      },
      dispose() {},
    },
  })
  const ready = supervisor.getCatalogHandshake().catch(error => error)
  const hello = () => child.emit("message", {
    kind: "hello", generation: "memory", workerProtocolVersion: OMP_WORKER_PROTOCOL_VERSION,
    heartbeatIntervalMs: 60_000,
  })
  if (options.ready !== false) hello()
  const stop = async () => {
    const disposal = supervisor.dispose()
    child.emit("exit", 0, null)
    await disposal
  }
  t.after(async () => {
    try {
      await stop()
      assert.equal(held.size, 0)
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })
  return { child, supervisor, ready, hello, held, releases, stop }
}

test("open aborted before hello releases its lease without waiting for worker readiness", async t => {
  const f = fixture(t, { ready: false })
  const controller = new AbortController()
  const opening = f.supervisor.open(".", "before-ready.jsonl", controller.signal)
  const rejected = assert.rejects(opening, { code: "REQUEST_ABORTED" })
  await nextTurn()
  assert.equal(f.held.has("before-ready.jsonl"), true)
  controller.abort()
  await rejected
  assert.deepEqual(f.releases, ["before-ready.jsonl"])
  assert.deepEqual(f.child.sent, [])
  f.hello()
  await f.ready
  await nextTurn()
  assert.deepEqual(f.child.sent, [])
})

test("queued open abort frees the lease and another attachment succeeds before the blocked callback", async t => {
  const f = fixture(t)
  await f.ready
  const blocking = f.supervisor.catalogCommand("state.get").catch(error => error)
  await nextTurn()
  const controller = new AbortController()
  const opening = f.supervisor.open(".", "queued.jsonl", controller.signal)
  const rejected = assert.rejects(opening, { code: "REQUEST_ABORTED" })
  await nextTurn()
  controller.abort()
  await rejected
  assert.deepEqual(f.releases, ["queued.jsonl"])
  assert.deepEqual(f.child.sent.map(message => message.command?.type), ["state.get"])
  const retry = f.supervisor.open(".", "queued.jsonl")
  await nextTurn()
  assert.equal(f.held.has("queued.jsonl"), true)
  const block = f.child.request("state.get")
  f.child.complete(block)
  f.child.reply(block, { healthy: true })
  await blocking
  const opened = f.child.request("session.open")
  assert.equal(f.child.sent.filter(message => message.command?.type === "session.open").length, 1)
  f.child.complete(opened)
  f.child.reply(opened, { sessionId: "reattached", sessionFile: "queued.jsonl", cwd: "." })
  assert.equal((await retry).getSessionId(), "reattached")
})

test("queued open timeout releases the lease even while the preceding IPC callback never returns", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t, { requestTimeoutMs: 20 })
  await f.ready
  const blocking = f.supervisor.catalogCommand("state.get").catch(error => error)
  await nextTurn()
  const opening = f.supervisor.open(".", "timed-out.jsonl")
  const rejected = assert.rejects(opening, { code: "WORKER_RESULT_UNKNOWN" })
  await nextTurn()
  t.mock.timers.tick(20)
  await rejected
  await blocking
  assert.deepEqual(f.releases, ["timed-out.jsonl"])
  assert.deepEqual(f.child.sent.map(message => message.command?.type), ["state.get"])
  f.child.complete(f.child.request("state.get"))
  assert.equal(f.child.sent.some(message => message.command?.type === "session.open"), false)
})

test("sent open abort and later send error retain the lease until the orphan runtime confirms close", async t => {
  const f = fixture(t)
  await f.ready
  const controller = new AbortController()
  const opening = f.supervisor.open(".", "sent.jsonl", controller.signal)
  const rejected = assert.rejects(opening, { code: "REQUEST_ABORTED", leaseHeld: true })
  await nextTurn()
  const opened = f.child.request("session.open")
  controller.abort()
  await rejected
  f.child.complete(opened, new Error("IPC callback failed after handoff"))
  assert.deepEqual(f.releases, [])
  await assert.rejects(f.supervisor.open(".", "sent.jsonl"), { code: "SESSION_BUSY" })
  f.child.reply(opened, { sessionId: "orphan", sessionFile: "sent.jsonl", cwd: "." })
  await nextTurn()
  const close = f.child.request("session.close")
  assert.equal(close.sessionId, "orphan")
  assert.deepEqual(f.releases, [])
  f.child.complete(close)
  f.child.reply(close)
  await nextTurn()
  assert.deepEqual(f.releases, ["sent.jsonl"])
  assert.equal(f.child.sent.some(message => message.kind === "cancel"), false)
})

test("an open send error before cancellation also preserves ownership until a definitive late failure", async t => {
  const f = fixture(t)
  await f.ready
  const opening = f.supervisor.open(".", "send-error.jsonl")
  const rejected = assert.rejects(opening, { code: "WORKER_RESULT_UNKNOWN", leaseHeld: true })
  await nextTurn()
  const opened = f.child.request("session.open")
  f.child.complete(opened, new Error("delivery unknown"))
  await rejected
  assert.deepEqual(f.releases, [])
  f.child.reply(opened, undefined, false)
  await nextTurn()
  assert.deepEqual(f.releases, ["send-error.jsonl"])
  assert.equal(f.child.sent.some(message => message.command?.type === "session.close"), false)
})

test("late close timeout keeps the lease until a successful late close response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t, { requestTimeoutMs: 20 })
  await f.ready
  const controller = new AbortController()
  const opening = f.supervisor.open(".", "slow-close.jsonl", controller.signal)
  const rejected = assert.rejects(opening, { code: "REQUEST_ABORTED" })
  await nextTurn()
  const opened = f.child.request("session.open")
  controller.abort()
  await rejected
  f.child.complete(opened)
  f.child.reply(opened, { sessionId: "slow-close", sessionFile: "slow-close.jsonl", cwd: "." })
  await nextTurn()
  const close = f.child.request("session.close")
  t.mock.timers.tick(20)
  await nextTurn()
  assert.deepEqual(f.releases, [])
  await assert.rejects(f.supervisor.open(".", "slow-close.jsonl"), { code: "SESSION_BUSY" })
  f.child.complete(close)
  f.child.reply(close)
  await nextTurn()
  assert.deepEqual(f.releases, ["slow-close.jsonl"])
})

test("failed orphan cleanup holds the lease until worker exit, not merely close rejection", async t => {
  const f = fixture(t)
  await f.ready
  const controller = new AbortController()
  const opening = f.supervisor.open(".", "failed-close.jsonl", controller.signal)
  const rejected = assert.rejects(opening, { code: "REQUEST_ABORTED" })
  await nextTurn()
  const opened = f.child.request("session.open")
  controller.abort()
  await rejected
  f.child.complete(opened)
  f.child.reply(opened, { sessionId: "failed-close", sessionFile: "failed-close.jsonl", cwd: "." })
  await nextTurn()
  const close = f.child.request("session.close")
  f.child.complete(close)
  f.child.reply(close, undefined, false)
  await nextTurn()
  assert.deepEqual(f.releases, [])
  await f.stop()
  assert.deepEqual(f.releases, ["failed-close.jsonl"])
})

test("worker exit settles a sent abandoned open without requiring a response or send callback", async t => {
  const f = fixture(t)
  await f.ready
  const controller = new AbortController()
  const opening = f.supervisor.open(".", "exit.jsonl", controller.signal)
  const rejected = assert.rejects(opening, { code: "REQUEST_ABORTED" })
  await nextTurn()
  const opened = f.child.request("session.open")
  controller.abort()
  await rejected
  assert.deepEqual(f.releases, [])
  await f.stop()
  f.child.complete(opened, new Error("late transport error"))
  assert.deepEqual(f.releases, ["exit.jsonl"])
})

test("ordinary cancelled requests notify the worker without replaying the command", async t => {
  const f = fixture(t)
  await f.ready
  const controller = new AbortController()
  const command = f.supervisor.catalogCommand("state.get", undefined, { signal: controller.signal })
  const rejected = assert.rejects(command, { code: "REQUEST_ABORTED" })
  await nextTurn()
  const request = f.child.request("state.get")
  controller.abort()
  await rejected
  f.child.complete(request)
  assert.deepEqual(f.child.sent.map(message => message.kind), ["request", "cancel"])
  assert.equal(f.child.sent[1].id, request.id)
  assert.equal(f.child.sent[1].generation, request.generation)
  f.child.complete(f.child.sent[1])
  f.child.reply(request, { late: true })
  assert.equal(f.child.sent.filter(message => message.command?.type === "state.get").length, 1)
})

test("pre-hello cancellation releases command bodies instead of retaining them in ready callbacks", {
  skip: typeof global.gc !== "function",
}, async t => {
  const f = fixture(t, { ready: false })
  const bodies: Array<WeakRef<object>> = []
  for (let index = 0; index < 12; index++) {
    let params: { cwd: string; patch: { text: string } } | undefined = {
      cwd: ".", patch: { text: `${index}:${"x".repeat(512 * 1024)}` },
    }
    bodies.push(new WeakRef(params))
    const controller = new AbortController()
    const pending = f.supervisor.catalogCommand("settings.patch", params, { signal: controller.signal })
    params = undefined
    const rejected = assert.rejects(pending, { code: "REQUEST_ABORTED" })
    controller.abort()
    await rejected
  }
  for (let cycle = 0; cycle < 3; cycle++) { await nextTurn(); global.gc!() }
  assert.ok(bodies.every(body => body.deref() === undefined), "cancelled payload objects must be collectable before hello")
  assert.deepEqual(f.child.sent, [])
  f.hello()
  await f.ready
  await nextTurn()
  assert.deepEqual(f.child.sent, [])
})
