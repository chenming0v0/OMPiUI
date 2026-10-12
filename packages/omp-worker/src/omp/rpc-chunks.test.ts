import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { OmpRpcClient } from "./rpc-client.js"

type Harness = {
  chunks: Map<string, { timer: NodeJS.Timeout; receivedBytes: number }>
  chunkBytes: number
  stderrBuffer: string[]
  handleChunk(frame: object): void
  failAllPending(): void
  on(event: string, listener: (frame: { text: string }) => void): void
}

function harness(): Harness {
  const client = Object.create(OmpRpcClient.prototype)
  EventEmitter.call(client)
  return Object.assign(client, { chunks: new Map(), chunkBytes: 0, pending: new Map(), stderrBuffer: [] })
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
  assert.equal(rpc.chunkBytes, 32)
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
