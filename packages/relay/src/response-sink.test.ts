import assert from "node:assert/strict"
import { once } from "node:events"
import { Writable } from "node:stream"
import { test } from "node:test"
import { RESPONSE_BUFFER_MAX, RESPONSE_QUEUE_MAX, ResponseSink } from "./response-sink.ts"

class SlowWritable extends Writable {
  readonly chunks: Buffer[] = []
  release: () => void = () => assert.fail("no pending write")

  constructor() { super({ highWaterMark: 1 }) }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk))
    this.release = callback
  }
}

test("response sink waits for each drain and sends end after queued bytes in order", async () => {
  const output = new SlowWritable()
  let finished = 0
  const sink = new ResponseSink(output, () => assert.fail("unexpected abort"), () => finished++)
  sink.write(Buffer.from("first"))
  const second = Buffer.from("second")
  sink.write(second)
  second.fill(0) // queued frames must not retain mutable/shared WS storage
  sink.write(Buffer.from("third"))
  sink.end()
  sink.write(Buffer.from("after end"))
  assert.deepEqual(output.chunks.map(String), ["first"])
  assert.equal(output.writableEnded, false)
  output.release()
  assert.deepEqual(output.chunks.map(String), ["first", "second"])
  assert.equal(output.writableEnded, false)
  output.release()
  assert.deepEqual(output.chunks.map(String), ["first", "second", "third"])
  assert.equal(output.writableEnded, false)
  const done = once(output, "finish")
  output.release()
  await done
  assert.equal(finished, 1)
  assert.equal(output.listenerCount("drain"), 0)
})

test("response sink caps writable plus queued bytes and terminates only its output", () => {
  const output = new SlowWritable()
  let aborted = 0
  const sink = new ResponseSink(output, () => aborted++, () => assert.fail("unexpected finish"))
  const chunk = Buffer.alloc(64 * 1024)
  for (let bytes = 0; bytes < RESPONSE_BUFFER_MAX; bytes += chunk.length) sink.write(chunk)
  assert.equal(aborted, 0)
  assert.equal(output.writableLength, chunk.length)
  assert.equal(output.chunks.length, 1)
  sink.write(Buffer.from("overflow"))
  assert.equal(aborted, 1)
  assert.equal(output.destroyed, true)
  assert.equal(output.listenerCount("drain"), 0)
  output.emit("drain")
  sink.write(chunk)
  sink.end()
  assert.equal(output.chunks.length, 1)
  assert.equal(aborted, 1)
})

test("tiny response frames cannot create an unbounded number of queued objects", () => {
  const output = new SlowWritable()
  let aborted = 0
  const sink = new ResponseSink(output, () => aborted++, () => {})
  sink.write(Buffer.from("first"))
  for (let i = 0; i < RESPONSE_QUEUE_MAX; i++) sink.write(Buffer.from("x"))
  for (let i = 0; i < RESPONSE_QUEUE_MAX; i++) sink.write(Buffer.alloc(0))
  assert.equal(aborted, 0)
  sink.write(Buffer.from("x"))
  assert.equal(aborted, 1)
  assert.equal(output.destroyed, true)
})

for (const event of ["close", "error", "dispose"] as const) {
  test(`response sink releases queued data and drain listeners on ${event}`, () => {
    const output = new SlowWritable()
    let aborted = 0
    const sink = new ResponseSink(output, () => aborted++, () => {})
    sink.write(Buffer.from("first"))
    sink.write(Buffer.from("queued"))
    if (event === "dispose") sink.dispose()
    else output.emit(event)
    assert.equal(output.listenerCount("drain"), 0)
    output.emit("drain")
    sink.end()
    assert.equal(output.chunks.length, 1)
    assert.equal(aborted, event === "dispose" ? 0 : 1)
    output.destroy()
  })
}
