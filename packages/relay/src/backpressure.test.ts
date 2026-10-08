import assert from "node:assert/strict"
import { once } from "node:events"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { Duplex } from "node:stream"
import { test, type TestContext } from "node:test"
import { WebSocket } from "ws"
import { generateTunnelKey } from "./config.ts"
import { CONNECTIONS_PER_TUNNEL_MAX, CONTROL_PATH, encodeFrameMessages, serializeRawHead, type ControlFrame } from "./protocol.ts"
import { startRelay } from "./relay.ts"
import { RESPONSE_BUFFER_MAX } from "./response-sink.ts"

// Exercise the real relay/control WebSocket with deterministic Node writable
// backpressure at the public HTTP/upgrade boundary. No OS socket-buffer timing.
class Visitor extends Duplex {
  readonly chunks: Buffer[] = []
  status = 0
  pending?: () => void

  constructor(private readonly slow: boolean) { super({ highWaterMark: 1 }) }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk))
    if (this.slow) this.pending = callback
    else callback()
    this.emit("written")
  }
  writeHead(status: number): void { this.status = status }
  release(): void {
    const callback = this.pending
    this.pending = undefined
    assert.ok(callback, "expected a blocked write")
    callback()
  }
}

async function harness(t: TestContext) {
  const key = generateTunnelKey()
  const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "test", key }] }, log: () => {} })
  t.after(() => relay.close())
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${CONTROL_PATH}?tunnel=test`, {
    headers: { authorization: `Bearer ${key}` },
  })
  t.after(() => ws.terminate())
  const frames: ControlFrame[] = []
  const waiters = new Set<() => void>()
  ws.on("message", (data, isBinary) => {
    if (isBinary) return
    frames.push(JSON.parse(data.toString()) as ControlFrame)
    for (const notify of [...waiters]) notify()
  })
  function take<T extends ControlFrame["type"]>(type: T, connId?: number): Promise<Extract<ControlFrame, { type: T }>> {
    return new Promise(resolve => {
      const check = () => {
        const index = frames.findIndex(frame => frame.type === type && (connId === undefined || ("c" in frame && frame.c === connId)))
        if (index < 0) return
        waiters.delete(check)
        resolve(frames.splice(index, 1)[0] as Extract<ControlFrame, { type: T }>)
      }
      waiters.add(check)
      check()
    })
  }
  await take("ready")
  const send = (frame: ControlFrame) => ws.send(JSON.stringify(frame))
  const body = (c: number, chunk: Buffer) => {
    for (const frame of encodeFrameMessages(c, chunk)) ws.send(frame)
  }
  async function open(kind: "request" | "upgrade", slow = true) {
    const req = new IncomingMessage(new Socket())
    req.url = "/stream"
    req.method = "GET"
    const output = new Visitor(slow)
    output.on("error", () => {})
    t.after(() => { req.socket.destroy(); output.destroy() })
    if (kind === "request") {
      relay.server.emit("request", req, output)
      req.emit("end")
    } else {
      req.headers = { connection: "upgrade", upgrade: "websocket" }
      relay.server.emit("upgrade", req, output, Buffer.alloc(0))
    }
    const frame = await take("open")
    return { output, c: frame.c }
  }
  function head(kind: "request" | "upgrade", c: number) {
    send({ type: "head", c, s: kind === "request" ? 200 : 101, h: {} })
  }
  async function fastRoundtrip() {
    const { output, c } = await open("request", false)
    const done = once(output, "finish")
    head("request", c)
    body(c, Buffer.from("unrelated"))
    send({ type: "end", c })
    await done
    assert.equal(output.status, 200)
    assert.equal(Buffer.concat(output.chunks).toString(), "unrelated")
  }
  return { relay, ws, frames, take, send, body, open, head, fastRoundtrip }
}

test("ended but undrained responses still count toward the per-tunnel connection bound", { timeout: 10_000 }, async t => {
  const h = await harness(t)
  const outputs: Visitor[] = []
  for (let i = 0; i < CONNECTIONS_PER_TUNNEL_MAX; i++) {
    const { output, c } = await h.open("request")
    outputs.push(output)
    h.head("request", c)
    h.body(c, Buffer.from("blocked"))
    h.send({ type: "end", c })
  }
  const req = new IncomingMessage(new Socket())
  req.url = "/overflow"
  const busy = new Visitor(false)
  t.after(() => { req.socket.destroy(); busy.destroy() })
  const done = once(busy, "finish")
  h.relay.server.emit("request", req, busy)
  await done
  assert.equal(busy.status, 503)
  assert.match(Buffer.concat(busy.chunks).toString(), /TUNNEL_BUSY/)

  // Observe the last response's first write before releasing its slot.
  const last = outputs.at(-1)!
  if (!last.pending) await once(last, "written")
  const finished = once(last, "finish")
  last.release()
  await finished
  await h.fastRoundtrip()
})

for (const kind of ["request", "upgrade"] as const) {
  test(`${kind}: a slow consumer overflows alone; shared control and other streams keep running`, { timeout: 10_000 }, async t => {
    const h = await harness(t)
    const { output, c } = await h.open(kind)
    h.head(kind, c)
    h.body(c, Buffer.alloc(64 * 1024))
    await h.fastRoundtrip()
    assert.equal(output.chunks.length, 1)
    assert.equal(output.destroyed, false)
    const stopped = h.take(kind === "request" ? "abort" : "close", c)
    h.body(c, Buffer.alloc(RESPONSE_BUFFER_MAX))
    await stopped
    assert.equal(output.destroyed, true)
    assert.equal(output.listenerCount("drain"), 0)
    h.body(c, Buffer.from("late frame"))
    output.emit("drain")
    await h.fastRoundtrip()
    assert.equal(output.chunks.length, 1)
    assert.deepEqual(h.relay.onlineTunnelIds(), ["test"])
  })

  test(`${kind}: end waits for drain, preserving head/body ordering and disposing listeners`, { timeout: 10_000 }, async t => {
    const h = await harness(t)
    const { output, c } = await h.open(kind)
    h.head(kind, c)
    h.body(c, Buffer.from("first"))
    h.body(c, Buffer.from("second"))
    h.send({ type: "end", c })
    await h.fastRoundtrip()
    assert.equal(output.chunks.length, 1)
    assert.equal(output.writableEnded, false)
    const finished = once(output, "finish")
    const count = kind === "request" ? 2 : 3
    for (let i = 0; i < count; i++) output.release()
    await finished
    const prefix = kind === "request" ? "" : serializeRawHead(101, {}).toString()
    assert.equal(Buffer.concat(output.chunks).toString(), `${prefix}firstsecond`)
    assert.equal(output.listenerCount("drain"), 0)
    assert.equal(h.frames.some(frame => "c" in frame && frame.c === c && (frame.type === "abort" || frame.type === "close")), false)
  })

  test(`${kind}: visitor close, upstream close/fail and control disconnect clean queued responses`, { timeout: 10_000 }, async t => {
    const h = await harness(t)
    for (const cause of ["visitor", "close", "fail", "control"] as const) {
      const { output, c } = await h.open(kind)
      h.head(kind, c)
      h.body(c, Buffer.from("first"))
      h.body(c, Buffer.from("queued"))
      await h.fastRoundtrip()
      assert.equal(output.chunks.length, 1)
      const closed = once(output, "close")
      if (cause === "visitor") output.destroy()
      else if (cause === "control") h.ws.terminate()
      else h.send({ type: cause, c })
      await closed
      if (cause === "visitor") await h.take(kind === "request" ? "abort" : "close", c)
      assert.equal(output.listenerCount("drain"), 0)
      output.emit("drain")
      assert.equal(output.chunks.length, 1)
      if (cause !== "control") await h.fastRoundtrip()
    }
    assert.deepEqual(h.relay.onlineTunnelIds(), [])
  })
}
