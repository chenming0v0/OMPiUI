import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { setImmediate as nextTurn } from "node:timers/promises"
import test from "node:test"
import { decodeFrameMessage, encodeFrameMessages } from "@ompiui/relay"
import { TunnelClient } from "./tunnel-client.ts"

test("complete early HTTP responses drain after upload close and permit connection-id reuse", { timeout: 5000 }, async t => {
  let closed!: () => void
  const localClosed = new Promise<void>(resolve => { closed = resolve })
  const server = createServer((req, res) => {
    if (req.method === "GET") { res.end("OK"); return }
    req.socket.once("close", closed)
    req.once("data", () => {
      res.writeHead(413, { "content-length": "2", connection: "close" })
      res.end("NO")
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const client = new TunnelClient({
    relayUrl: "ws://127.0.0.1", key: "test", localPort: (server.address() as { port: number }).port,
  })
  const frames: Array<{ type: string; c: number; data?: Buffer }> = []
  let ended: (() => void) | undefined
  let allowed = false
  Object.assign(client, {
    ws: {
      readyState: 1, bufferedAmount: 0, close() {},
      send(data: Buffer | string) {
        if (Buffer.isBuffer(data)) {
          const frame = decodeFrameMessage(data)!
          frames.push({ type: "body", c: frame.connId, data: frame.payload })
        } else {
          const frame = JSON.parse(data)
          frames.push(frame)
          if (frame.type === "end") ended?.()
        }
      },
    },
    download: { allow: () => allowed, delayMs: () => 100 },
  })
  t.after(async () => {
    client.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const internal = client as unknown as {
    handleMessage(data: Buffer, binary: boolean): void
    conns: Map<number, { sink: { flush(): void } }>
  }
  internal.handleMessage(Buffer.from(JSON.stringify({
    type: "open", c: 1, m: "POST", u: "/", h: { "content-length": "2" },
  })), false)
  internal.handleMessage(encodeFrameMessages(1, Buffer.from("X"))[0]!, true)
  await localClosed
  await nextTurn()
  assert.equal(frames.some(frame => frame.type === "fail"), false)
  assert.equal(internal.conns.size, 1)
  allowed = true
  internal.conns.get(1)!.sink.flush()
  assert.deepEqual(frames.map(frame => frame.type), ["head", "body", "end"])
  assert.equal(Buffer.concat(frames.flatMap(frame => frame.data ? [frame.data] : [])).toString(), "NO")
  assert.equal(internal.conns.size, 0)
  frames.length = 0
  const reused = new Promise<void>(resolve => { ended = resolve })
  internal.handleMessage(Buffer.from(JSON.stringify({ type: "open", c: 1, m: "GET", u: "/", h: {} })), false)
  internal.handleMessage(Buffer.from(JSON.stringify({ type: "reqEnd", c: 1 })), false)
  await reused
  assert.equal(Buffer.concat(frames.flatMap(frame => frame.data ? [frame.data] : [])).toString(), "OK")
  assert.equal(internal.conns.size, 0)
})
