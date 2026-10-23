import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { Writable } from "node:stream"
import { setImmediate as nextTurn } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { OmpRpcClient } from "./rpc-client.js"
import { OmpStdinSender } from "./stdin-sender.js"
import { RuntimeBridgeTransport } from "./runtime-bridge.js"

function rpcFixture(t: TestContext, capacity?: { bytes: number; items: number }) {
  const delivered: JsonObject[] = []
  const callbacks: Array<(error?: Error | null) => void> = []
  const stdin = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _encoding, done) {
      delivered.push(JSON.parse(chunk.toString()))
      callbacks.push(done)
    },
  })
  let kills = 0
  const client = Object.create(OmpRpcClient.prototype) as OmpRpcClient
  EventEmitter.call(client)
  Object.assign(client, {
    nextId: 0, pending: new Map(), chunks: new Map(), chunkBytes: 0,
    stderrBuffer: [], exited: false,
    runtimeBridge: new RuntimeBridgeTransport(),
    proc: { stdin, kill() { kills += 1; return true } },
  })
  const internal = client as unknown as {
    stdinSender?: OmpStdinSender
    dispatchFrame(frame: JsonObject): void
    failAllPending(): void
  }
  if (capacity) {
    internal.stdinSender = new OmpStdinSender(stdin, error => assert.fail(error.message), capacity.bytes, capacity.items)
  }
  t.after(() => internal.failAllPending())
  return { client, internal, stdin, delivered, callbacks, kills: () => kills }
}

test("successive stdin timeouts remove unsent commands instead of accumulating or delivering them later", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = rpcFixture(t)
  const requests = [0, 1, 2].map(() => f.client.request({ type: "prompt", message: "x".repeat(64 * 1024) }, 10).catch(error => error))
  t.mock.timers.tick(10)
  const errors = await Promise.all(requests)
  assert.deepEqual(errors.map(error => error.code), ["OMP_TIMEOUT", "OMP_TIMEOUT", "OMP_TIMEOUT"])
  assert.deepEqual(errors.map(error => error.delivery), ["unknown", "unsent", "unsent"])
  const retained = f.stdin.writableLength
  assert.equal(retained, Buffer.byteLength(JSON.stringify(f.delivered[0]) + "\n"))
  for (let round = 0; round < 3; round++) {
    const expired = f.client.request({ type: "prompt", message: "x".repeat(64 * 1024) }, 10).catch(error => error)
    t.mock.timers.tick(10)
    assert.equal((await expired).delivery, "unsent")
    assert.equal(f.stdin.writableLength, retained)
  }
  f.callbacks.shift()!()
  await nextTurn()
  assert.deepEqual(f.delivered.map(command => command.id), ["req_1"])
  const fresh = f.client.request({ type: "get_state" })
  assert.deepEqual(f.delivered.map(command => command.id), ["req_1", "req_7"])
  f.callbacks.shift()!()
  f.internal.dispatchFrame({ type: "response", id: "req_7", command: "get_state", success: true, data: { healthy: true } })
  assert.deepEqual((await fresh).data, { healthy: true })
  assert.equal(f.kills(), 0)
})

test("requests and extension replies share admission and a response does not release an unflushed write", async t => {
  const firstLine = JSON.stringify({ id: "req_1", type: "get_state" }) + "\n"
  const f = rpcFixture(t, { bytes: Buffer.byteLength(firstLine), items: 1 })
  const first = f.client.request({ type: "get_state" })
  f.internal.dispatchFrame({ type: "response", id: "req_1", command: "get_state", success: true })
  await first
  assert.throws(() => f.client.writeExtensionUiResponse({ type: "reply" }), { code: "RATE_LIMITED" })
  await assert.rejects(f.client.request({ type: "get_state" }), { code: "RATE_LIMITED", delivery: "unsent" })
  f.callbacks.shift()!()
  await nextTurn()
  f.client.writeExtensionUiResponse({ type: "reply" })
  assert.deepEqual(f.delivered.map(command => command.type), ["get_state", "reply"])
  f.callbacks.shift()!()
})

test("legacy responses without ids cannot reject a command that is still queued", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = rpcFixture(t)
  const first = f.client.request({ type: "prompt" }, 10).catch(error => error)
  const queued = f.client.request({ type: "prompt" }, 1000)
  const queuedFailure = assert.rejects(queued, { code: "unsupported" })
  t.mock.timers.tick(10)
  assert.equal((await first).delivery, "unknown")
  f.internal.dispatchFrame({ type: "response", command: "prompt", success: false, code: "old-response" })
  f.callbacks.shift()!()
  await nextTurn()
  assert.deepEqual(f.delivered.map(command => command.id), ["req_1", "req_2"])
  f.internal.dispatchFrame({ type: "response", command: "prompt", success: false, code: "unsupported" })
  await queuedFailure
  f.callbacks.shift()!()
})

test("stdin callback errors fail active and queued requests with different delivery guarantees", async t => {
  const f = rpcFixture(t)
  const active = f.client.request({ type: "prompt" }).catch(error => error)
  const queued = f.client.request({ type: "prompt" }).catch(error => error)
  f.callbacks.shift()!(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))
  const errors = await Promise.all([active, queued])
  assert.deepEqual(errors.map(error => error.delivery), ["unknown", "unsent"])
  assert.deepEqual(errors.map(error => error.code), ["EPIPE", "EPIPE"])
  assert.equal(f.kills(), 1)
  assert.equal(f.stdin.destroyed, true)
  await assert.rejects(f.client.request({ type: "get_state" }), { delivery: "unsent" })
  assert.deepEqual(f.delivered.map(command => command.id), ["req_1"])
})

class ControlledStdin extends EventEmitter {
  readonly lines: string[] = []
  readonly callbacks: Array<(error?: Error | null) => void> = []
  destroyed = false
  writableEnded = false
  write(line: string, _encoding: string, done: (error?: Error | null) => void): boolean {
    this.lines.push(line)
    this.callbacks.push(done)
    return false
  }
  end(): void { this.writableEnded = true }
  destroy(): void { this.destroyed = true; this.emit("close") }
}

test("stdin capacity is held until both callback and drain, in either event order", () => {
  for (const firstEvent of ["callback", "drain"]) {
    const stdin = new ControlledStdin()
    const completed: boolean[] = []
    const sender = new OmpStdinSender(stdin as unknown as Writable, error => assert.fail(error.message), 8, 2)
    const sent = sender.write("正文\n", (_error, wrote) => completed.push(wrote))
    const queued = sender.write("\n", (_error, wrote) => completed.push(wrote))
    const callback = stdin.callbacks.shift()!
    if (firstEvent === "callback") callback()
    else stdin.emit("drain")
    assert.equal(sent.cancel(), false)
    assert.equal(queued.sent, false)
    assert.throws(() => sender.write("x", () => undefined), { code: "RATE_LIMITED" })
    assert.deepEqual(stdin.lines, ["正文\n"])
    if (firstEvent === "callback") stdin.emit("drain")
    else callback()
    assert.deepEqual(completed, [true])
    assert.deepEqual(stdin.lines, ["正文\n", "\n"])
    callback()
    assert.throws(() => sender.write("12345678", () => undefined), { code: "RATE_LIMITED" })
    stdin.callbacks.shift()!()
    stdin.emit("drain")
    sender.write("12345678", (_error, wrote) => completed.push(wrote))
    assert.deepEqual(stdin.lines, ["正文\n", "\n", "12345678"])
    sender.close(new Error("fixture exit"))
  }
})

test("stdin item capacity and queued cancellation recover without depending on a blocked callback", () => {
  const stdin = new ControlledStdin()
  const sender = new OmpStdinSender(stdin as unknown as Writable, error => assert.fail(error.message), 100, 2)
  const completed: boolean[] = []
  sender.write("first", (_error, sent) => completed.push(sent))
  const queued = sender.write("cancelled", (_error, sent) => completed.push(sent))
  assert.throws(() => sender.write("overflow", () => undefined), { code: "RATE_LIMITED" })
  assert.equal(queued.cancel(), true)
  assert.equal(queued.cancel(), false)
  assert.deepEqual(completed, [false])
  sender.write("replacement", (_error, sent) => completed.push(sent))
  stdin.callbacks.shift()!()
  stdin.emit("drain")
  assert.deepEqual(stdin.lines, ["first", "replacement"])
  sender.close(new Error("fixture exit"))
  stdin.callbacks.shift()!()
  assert.deepEqual(completed, [false, true, true])
})

test("graceful stdin end flushes admitted commands but exit cancels the queue exactly once", () => {
  const stdin = new ControlledStdin()
  const sender = new OmpStdinSender(stdin as unknown as Writable, error => assert.fail(error.message))
  const failures: Array<{ error?: Error; sent: boolean }> = []
  sender.write("first", (error, sent) => failures.push({ error, sent }))
  sender.write("second", (error, sent) => failures.push({ error, sent }))
  sender.end()
  assert.equal(stdin.writableEnded, false)
  assert.throws(() => sender.write("after-end", () => undefined), { code: "OMP_STDIN_CLOSED" })
  stdin.callbacks.shift()!()
  stdin.emit("drain")
  assert.deepEqual(stdin.lines, ["first", "second"])
  stdin.callbacks.shift()!()
  stdin.emit("drain")
  assert.equal(stdin.writableEnded, true)
  assert.deepEqual(failures, [{ error: undefined, sent: true }, { error: undefined, sent: true }])
  sender.close(new Error("fixture exit"))

  const blocked = new ControlledStdin()
  const stopped = new OmpStdinSender(blocked as unknown as Writable, error => assert.fail(error.message))
  const results: Array<{ error?: Error; sent: boolean }> = []
  stopped.write("active", (error, sent) => results.push({ error, sent }))
  stopped.write("unsent", (error, sent) => results.push({ error, sent }))
  const error = new Error("process exited")
  stopped.close(error)
  stopped.close(error)
  blocked.callbacks.shift()!()
  blocked.emit("drain")
  assert.deepEqual(results, [{ error, sent: true }, { error, sent: false }])
  assert.deepEqual(blocked.lines, ["active"])
})
