import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { OmpRpcClient } from "./rpc-client.js"
import { RuntimeBridgeTransport } from "./runtime-bridge.js"

type Harness = {
  chunks: Map<string, { timer: NodeJS.Timeout; receivedBytes: number }>
  chunkBytes: number
  stderrBuffer: string[]
  handleStdoutLine(line: string): void
  handleChunk(frame: object): void
  failAllPending(): void
  setOutputPaused(paused: boolean): void
  on(event: "frame", listener: (frame: { text: string }) => void): void
  on(event: "protocolError", listener: (message: string, originalType?: string) => void): void
}

function harness(): Harness {
  const client = Object.create(OmpRpcClient.prototype)
  EventEmitter.call(client)
  return Object.assign(client, {
    chunks: new Map(), chunkBytes: 0, pending: new Map(), stderrBuffer: [],
    runtimeBridge: new RuntimeBridgeTransport(),
    stdoutReader: { setPaused() {} },
  })
}

function chunk(id: string, index: number, count: number, byteLength: number, data: Buffer) {
  return { type: "rpc_chunk", chunkId: id, index, count, byteLength, data: data.toString("base64") }
}

test("RPC chunks reassemble out of order across UTF-8 boundaries without corrupting text", () => {
  const rpc = harness()
  const bytes = Buffer.from(JSON.stringify({ type: "message", text: "正文😀" }))
  let result = ""
  rpc.on("frame", frame => { result = frame.text })
  const cut = bytes.indexOf(Buffer.from("😀")) + 1
  rpc.handleChunk(chunk("ok", 1, 2, bytes.length, bytes.subarray(cut)))
  rpc.handleChunk(chunk("ok", 0, 2, bytes.length, bytes.subarray(0, cut)))
  assert.equal(result, "正文😀")
  assert.equal(rpc.chunkBytes, 0)
  assert.equal(rpc.chunks.size, 0)
})

test("RPC streaming parser preserves official large frames without allocating a concat buffer", () => {
  const rpc = harness()
  const text = "x".repeat(9 * 1024 * 1024)
  const bytes = Buffer.from(JSON.stringify({ type: "message", text }))
  const step = 256 * 1024
  const count = Math.ceil(bytes.length / step)
  let length = 0
  rpc.on("frame", frame => { length = frame.text.length })
  for (let index = 0; index < count; index++) {
    rpc.handleChunk(chunk("large", index, count, bytes.length, bytes.subarray(index * step, (index + 1) * step)))
  }
  assert.equal(length, text.length)
  assert.equal(rpc.chunkBytes, 0)
})

test("RPC chunks reject zero lengths and excessive fragment counts", () => {
  const rpc = harness()
  rpc.handleChunk(chunk("zero", 0, 1, 0, Buffer.from("x")))
  rpc.handleChunk(chunk("count", 0, 4097, 8192, Buffer.from("x")))
  assert.equal(rpc.chunks.size, 0)
})

test("RPC chunk entry limit and process cleanup release every retained byte", () => {
  const rpc = harness()
  for (let id = 0; id < 33; id++) rpc.handleChunk(chunk(String(id), 0, 2, 2, Buffer.from("x")))
  assert.equal(rpc.chunks.size, 32)
  assert.equal(rpc.chunkBytes, 32 + Array.from({ length: 32 }, (_, id) => String(id).length).reduce((a, b) => a + b, 0))
  rpc.failAllPending()
  assert.equal(rpc.chunks.size, 0)
  assert.equal(rpc.chunkBytes, 0)
})

test("RPC total byte budget refuses another fragment before retaining it", () => {
  const rpc = harness()
  rpc.chunkBytes = 64 * 1024 * 1024
  rpc.handleChunk(chunk("over-budget", 0, 2, 2, Buffer.from("x")))
  assert.equal(rpc.chunks.size, 0)
  assert.match(rpc.stderrBuffer.join(""), /buffer limit/)
})

test("RPC duplicate and invalid UTF-8 sequences release their byte accounting", () => {
  const rpc = harness()
  const part = chunk("duplicate", 0, 2, 2, Buffer.from("x"))
  rpc.handleChunk(part)
  rpc.handleChunk(part)
  rpc.handleChunk(chunk("utf8", 0, 1, 1, Buffer.from([0xff])))
  assert.equal(rpc.chunkBytes, 0)
  assert.equal(rpc.chunks.size, 0)
  assert.match(rpc.stderrBuffer.join(""), /duplicate/)
  assert.match(rpc.stderrBuffer.join(""), /UTF-8/)
})

test("RPC chunks bound identifiers, count their bytes and reject nested envelopes", () => {
  const rpc = harness()
  rpc.handleChunk(chunk("x".repeat(131072), 0, 2, 2, Buffer.from("x")))
  assert.equal(rpc.chunkBytes, 0)
  assert.equal(rpc.chunks.size, 0)
  assert.ok(rpc.stderrBuffer.join("").length < 512)
  const nested = Buffer.from(JSON.stringify(chunk("nested", 0, 2, 2, Buffer.from("x"))))
  rpc.handleChunk(chunk("outer", 0, 1, nested.length, nested))
  assert.equal(rpc.chunkBytes, 0)
  assert.equal(rpc.chunks.size, 0)
  assert.match(rpc.stderrBuffer.join(""), /nested/)
})

test("local IPC pauses suspend chunk expiry but preserve the remaining timeout", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] })
  const rpc = harness()
  const bytes = Buffer.from(JSON.stringify({ type: "message", text: "complete" }))
  let received = ""
  rpc.on("frame", frame => { received = frame.text })
  rpc.handleChunk(chunk("paused", 0, 2, bytes.length, bytes.subarray(0, 5)))
  t.mock.timers.tick(20_000)
  rpc.setOutputPaused(true)
  t.mock.timers.tick(60_000)
  assert.equal(rpc.chunks.size, 1)
  rpc.setOutputPaused(false)
  t.mock.timers.tick(9_999)
  rpc.handleChunk(chunk("paused", 1, 2, bytes.length, bytes.subarray(5)))
  assert.equal(received, "complete")
  assert.equal(rpc.chunkBytes, 0)
  rpc.handleChunk(chunk("expires", 0, 2, 2, Buffer.from("x")))
  t.mock.timers.tick(20_000)
  rpc.setOutputPaused(true)
  t.mock.timers.tick(60_000)
  rpc.setOutputPaused(false)
  t.mock.timers.tick(10_001)
  assert.equal(rpc.chunks.size, 0)
  assert.equal(rpc.chunkBytes, 0)
  assert.match(rpc.stderrBuffer.join(""), /timed out/)
})

test("local protocol errors surface as events while the runtime is alive, not only the stderr tail (#367)", () => {
  const rpc = harness()
  const errors: string[] = []
  rpc.on("protocolError", (message: string) => errors.push(message))
  rpc.handleChunk(chunk("mismatch", 0, 1, 10, Buffer.from("x")))
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /length mismatch/)
  assert.match(rpc.stderrBuffer.join(""), /length mismatch/)
})

test("rejected initial chunks and malformed stdout deliver errors without retaining bytes", () => {
  const rpc = harness()
  const errors: Array<{ message: string; originalType?: string }> = []
  rpc.on("protocolError", (message, originalType) => errors.push({ message, originalType }))
  rpc.handleChunk(chunk("length", 0, 1, 0, Buffer.from("x")))
  rpc.handleChunk(chunk("count", 0, 4097, 8192, Buffer.from("x")))
  rpc.handleChunk(chunk("index", 2, 2, 2, Buffer.from("x")))
  rpc.handleStdoutLine("not JSON")
  rpc.handleStdoutLine("{}")
  assert.equal(errors.length, 5)
  assert.deepEqual(errors.slice(0, 3).map(error => error.originalType), ["rpc_chunk", "rpc_chunk", "rpc_chunk"])
  assert.equal(rpc.chunkBytes, 0)
  assert.equal(rpc.chunks.size, 0)
  let continued = ""
  rpc.on("frame", frame => { continued = frame.text })
  rpc.handleStdoutLine(JSON.stringify({ type: "notice", text: "continued" }))
  assert.equal(continued, "continued")
})
