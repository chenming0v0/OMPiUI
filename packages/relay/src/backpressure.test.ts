import assert from "node:assert/strict"
import { once } from "node:events"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { Duplex } from "node:stream"
import { test, type TestContext } from "node:test"
import { WebSocket, WebSocketServer } from "ws"
import { generateTunnelKey } from "./config.ts"
import { BACKPRESSURE_HIGH_WATER, CONNECTIONS_PER_TUNNEL_MAX, CONTROL_PATH, FRAME_PAYLOAD_MAX, decodeFrameMessage, encodeFrameMessages, serializeRawHead, type ControlFrame } from "./protocol.ts"
import { startRelay } from "./relay.ts"
import { RESPONSE_BUFFER_MAX } from "./response-sink.ts"
import { DataRateLimit } from "./data-rate-limit.ts"

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

async function harness(t: TestContext, connectionIdleTimeoutMs?: number) {
  const key = generateTunnelKey()
  const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "test", key }] }, log: () => {}, connectionIdleTimeoutMs })
  t.after(() => relay.close())
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${CONTROL_PATH}?tunnel=test`, {
    headers: { authorization: `Bearer ${key}` },
  })
  t.after(() => ws.terminate())
  const frames: ControlFrame[] = []
  const received: Array<ControlFrame | { type: "body"; c: number; payload: Buffer }> = []
  const waiters = new Set<() => void>()
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = decodeFrameMessage(data as Buffer)
      assert.ok(frame)
      received.push({ type: "body", c: frame.connId, payload: frame.payload })
    } else {
      const frame = JSON.parse(data.toString()) as ControlFrame
      frames.push(frame)
      received.push(frame)
    }
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
  async function takeBody(c: number, bytes: number): Promise<Buffer> {
    while (true) {
      const parts = received.flatMap(frame => frame.type === "body" && frame.c === c ? [frame.payload] : [])
      if (parts.reduce((total, part) => total + part.length, 0) >= bytes) return Buffer.concat(parts)
      await once(ws, "message")
    }
  }
  await take("ready")
  const send = (frame: ControlFrame) => ws.send(JSON.stringify(frame))
  const body = (c: number, chunk: Buffer) => {
    for (const frame of encodeFrameMessages(c, chunk)) ws.send(frame)
  }
  function begin(kind: "request" | "upgrade", slow = true, source?: string, initialHead = Buffer.alloc(0)) {
    const req = new IncomingMessage(new Socket())
    if (source) Object.defineProperty(req.socket, "remoteAddress", { value: source })
    req.url = "/stream"
    req.method = "GET"
    const output = new Visitor(slow)
    output.on("error", () => {})
    t.after(() => { req.socket.destroy(); output.destroy() })
    if (kind === "request") {
      relay.server.emit("request", req, output)
    } else {
      req.headers = { connection: "upgrade", upgrade: "websocket" }
      relay.server.emit("upgrade", req, output, initialHead)
    }
    return { req, output }
  }
  async function open(kind: "request" | "upgrade", slow = true, source?: string) {
    const { req, output } = begin(kind, slow, source)
    if (kind === "request") req.emit("end")
    const frame = await take("open")
    return { req, output, c: frame.c }
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
  return { relay, ws, frames, received, take, takeBody, send, body, begin, open, head, fastRoundtrip }
}

async function pressureHarness(t: TestContext) {
  let control: WebSocket | undefined
  const handleUpgrade = WebSocketServer.prototype.handleUpgrade
  const capture = t.mock.method(WebSocketServer.prototype, "handleUpgrade", function (
    this: WebSocketServer, ...args: Parameters<WebSocketServer["handleUpgrade"]>
  ) {
    const [req, socket, head, callback] = args
    handleUpgrade.call(this, req, socket, head, (ws, request) => {
      control = ws
      callback(ws, request)
    })
  })
  const h = await harness(t).finally(() => capture.mock.restore())
  assert.ok(control)
  let bufferedAmount = 0
  Object.defineProperty(control, "bufferedAmount", { configurable: true, get: () => bufferedAmount })
  t.after(() => { Reflect.deleteProperty(control!, "bufferedAmount") })
  return { ...h, setBufferedAmount(value: number) { bufferedAmount = value } }
}

for (const kind of ["request", "upgrade"] as const) {
  test(`${kind}: open precedes streamed head/body at either side of the control high-water mark`, { timeout: 10_000 }, async t => {
    const h = await pressureHarness(t)
    for (const delta of [-1, 0, 1]) {
      for (const size of [1, 32 * 1024, FRAME_PAYLOAD_MAX + 1]) {
        const before = h.received.length
        h.setBufferedAmount(BACKPRESSURE_HIGH_WATER + delta)
        if (delta > 0) t.mock.timers.enable({ apis: ["setTimeout"] })
        const initialHead = kind === "upgrade" ? Buffer.alloc(size, 0x41) : Buffer.alloc(0)
        const payload = Buffer.alloc(size, 0x42)
        const { req, output } = h.begin(kind, false, undefined, initialHead)
        const source = kind === "request" ? req : output
        source.push(payload)
        if (kind === "request") {
          req.complete = true
          source.push(null)
        }
        const opened = h.take("open")
        if (delta > 0) {
          t.mock.timers.tick(30)
          const pong = once(h.ws, "pong")
          h.ws.ping()
          await pong
          assert.equal(source.isPaused(), true)
          assert.deepEqual(h.received.slice(before), [])
        } else await opened
        h.setBufferedAmount(0)
        if (delta > 0) {
          t.mock.timers.tick(25)
          t.mock.timers.reset()
        }
        const { c } = await opened
        assert.deepEqual(await h.takeBody(c, initialHead.length + payload.length), Buffer.concat([initialHead, payload]))
        if (kind === "request") await h.take("reqEnd", c)
        const sequence = h.received.slice(before).filter(frame => "c" in frame && frame.c === c)
        assert.equal(sequence[0]!.type, "open")
        for (const frame of sequence) if (frame.type === "body") assert.ok(frame.payload.length <= FRAME_PAYLOAD_MAX)
        if (kind === "request") assert.equal(sequence.at(-1)!.type, "reqEnd")
        const finished = once(output, "finish")
        h.head(kind, c)
        h.body(c, Buffer.from("accepted"))
        h.send({ type: "end", c })
        await finished
      }
    }
  })

  test(`${kind}: cancelling a queued open releases its source and never creates a ghost connection`, { timeout: 10_000 }, async t => {
    const h = await pressureHarness(t)
    h.setBufferedAmount(BACKPRESSURE_HIGH_WATER + 1)
    const { req, output } = h.begin(kind, false, undefined, Buffer.alloc(FRAME_PAYLOAD_MAX + 1))
    const source = kind === "request" ? req : output
    source.push(Buffer.from("cancelled body"))
    const closed = once(output, "close")
    source.destroy()
    await closed
    assert.equal(h.relay.tunnelStatus()[0]!.connections, 0)
    assert.equal(source.listenerCount("data"), 0)
    assert.equal(output.listenerCount("drain"), 0)
    h.setBufferedAmount(0)
    await h.fastRoundtrip()
    assert.deepEqual(h.received.map(frame => frame.type), ["ready", "open", "reqEnd"])
  })
}

test("a queued open does not stall an already-open upload or response", { timeout: 10_000 }, async t => {
  const h = await pressureHarness(t)
  const active = h.begin("request", false)
  const { c } = await h.take("open")
  h.setBufferedAmount(BACKPRESSURE_HIGH_WATER + 1)
  const waiting = h.begin("upgrade", false, undefined, Buffer.from("new head"))
  active.req.push(Buffer.from("existing upload"))
  assert.equal((await h.takeBody(c, 15)).toString(), "existing upload")
  assert.equal(h.received.filter(frame => frame.type === "open").length, 1)
  const finished = once(active.output, "finish")
  h.head("request", c)
  h.body(c, Buffer.from("existing response"))
  h.send({ type: "end", c })
  await finished
  assert.equal(Buffer.concat(active.output.chunks).toString(), "existing response")
  h.setBufferedAmount(0)
  const next = await h.take("open")
  assert.equal((await h.takeBody(next.c, 8)).toString(), "new head")
  const nextFinished = once(waiting.output, "finish")
  h.head("upgrade", next.c)
  h.send({ type: "end", c: next.c })
  await nextFinished
})

test("an ended response stops further upload while retaining its response drain", { timeout: 10_000 }, async t => {
  const h = await harness(t)
  const { req, output } = h.begin("request", true)
  const { c } = await h.take("open")
  h.head("request", c)
  h.body(c, Buffer.from("complete response"))
  h.send({ type: "end", c })
  if (!output.pending) await once(output, "written")
  // 另一请求的回执作为屏障，确保前一条 end 已经被 relay 消费。
  await h.fastRoundtrip()
  const before = h.received.filter(frame => frame.type === "body" && frame.c === c).length
  req.emit("data", Buffer.alloc(256 * 1024))
  req.emit("end")
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.received.filter(frame => frame.type === "body" && frame.c === c).length, before)
  assert.equal(h.received.some(frame => frame.type === "reqEnd" && frame.c === c), false)
  assert.equal(output.destroyed, false)
  const finished = once(output, "finish")
  while (output.pending) output.release()
  await finished
  assert.equal(Buffer.concat(output.chunks).toString(), "complete response")
})

test("fragmented tunnel messages are rejected before complete-message accounting", { timeout: 10_000 }, async t => {
  const h = await harness(t)
  const { c } = await h.open("request", false)
  h.head("request", c)
  const frame = Buffer.alloc(64)
  frame.writeUInt32BE(c)
  const closed = once(h.ws, "close")
  h.ws.send(frame.subarray(0, 16), { binary: true, fin: false })
  h.ws.send(frame.subarray(16), { binary: true, fin: true })
  const [code] = await closed
  assert.equal(code, 1008)
})

test("ended but undrained responses still count toward the per-tunnel connection bound", { timeout: 10_000 }, async t => {
  const h = await harness(t)
  const outputs: Visitor[] = []
  for (let i = 0; i < CONNECTIONS_PER_TUNNEL_MAX; i++) {
    const { output, c } = await h.open("request", true, `10.0.0.${i % 2}`)
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

test("idle connection slots are reclaimed without disconnecting the tunnel", { timeout: 10_000 }, async t => {
  const h = await harness(t, 100)
  const { output, c } = await h.open("request")
  const aborted = h.take("abort", c)
  await aborted
  assert.equal(output.destroyed, true)
  assert.equal(h.relay.tunnelStatus()[0]!.connections, 0)
  await h.fastRoundtrip()
})

test("healthy low-traffic upgrades survive progress windows while stalled HTTP still expires", { timeout: 10_000 }, async t => {
  const intervals: Array<() => void> = []
  const setInterval = globalThis.setInterval
  const capture = t.mock.method(globalThis, "setInterval", (callback: () => void, delay?: number) => {
    intervals.push(callback)
    return setInterval(callback, delay)
  })
  const h = await harness(t).finally(() => capture.mock.restore())
  // 首先创建 relay 心跳，再在控制连接建立时创建虚拟连接扫描。
  const scan = intervals.at(-1)!
  assert.ok(intervals.length >= 2)
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  const { output, c } = await h.open("upgrade", false)
  h.head("upgrade", c)
  for (let window = 0; window < 3; window++) {
    now += 60_001
    h.body(c, Buffer.from("p"))
    await h.fastRoundtrip()
    scan()
    assert.equal(output.destroyed, false)
    assert.equal(h.ws.readyState, WebSocket.OPEN)
  }
  const stalled = h.begin("request", false, "198.51.100.2")
  const opened = await h.take("open")
  stalled.req.emit("data", Buffer.from("x"))
  now += 60_001
  scan()
  await h.take("abort", opened.c)
  assert.equal(stalled.output.destroyed, true)
})

test("a single source leaves capacity for other visitors", { timeout: 10_000 }, async t => {
  const h = await harness(t)
  for (let i = 0; i < CONNECTIONS_PER_TUNNEL_MAX / 2; i++) await h.open("request", true, "10.0.0.1")
  const req = new IncomingMessage(new Socket())
  Object.defineProperty(req.socket, "remoteAddress", { value: "10.0.0.1" })
  req.url = "/over-source-limit"
  const output = new Visitor(false)
  t.after(() => { req.socket.destroy(); output.destroy() })
  const finished = once(output, "finish")
  h.relay.server.emit("request", req, output)
  await finished
  assert.equal(output.status, 503)
  await h.fastRoundtrip()
  assert.equal(h.relay.onlineTunnelIds()[0], "test")
})

test("exhausted visitor control quota rejects only that request, not the tunnel", { timeout: 10_000 }, async t => {
  const h = await harness(t)
  const req = new IncomingMessage(new Socket())
  req.url = "/quota"
  const output = new Visitor(false)
  t.after(() => { req.socket.destroy(); output.destroy() })
  const allow = DataRateLimit.prototype.allow
  try {
    DataRateLimit.prototype.allow = () => false
    const finished = once(output, "finish")
    h.relay.server.emit("request", req, output)
    await finished
    assert.equal(output.status, 429)
    assert.deepEqual(h.relay.onlineTunnelIds(), ["test"])
  } finally {
    DataRateLimit.prototype.allow = allow
  }
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
