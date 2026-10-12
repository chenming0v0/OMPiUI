import assert from "node:assert/strict"
import { createServer, request } from "node:http"
import { once } from "node:events"
import { gunzipSync } from "node:zlib"
import test from "node:test"
import { WebSocket } from "ws"
import { PROTOCOL_VERSION, eventStreamKey } from "@ompiui/protocol"
import { EventHub } from "./event-hub.ts"
import { attachEventWebSocket, closeEventWebSocket } from "./ws.ts"
import { createAppServer } from "./http.ts"
import { MAX_PROMPT_BODY_BYTES } from "./host/security.ts"
import type { TerminalManager } from "./host/terminal-manager.ts"

test("event history bounds bytes globally and per stream, retaining correct expired-cursor semantics", () => {
  const hub = new EventHub()
  const stream = { kind: "session" as const, id: "large" }
  const before = hub.getCursor(stream)
  for (let index = 0; index < 5; index++) hub.publish(stream, "session.head", { text: "x".repeat(700000) })
  assert.equal(hub.replaySince(stream, before).reason, "history_expired")
  const retained = hub.replaySince(stream, { ...hub.getCursor(stream), sequence: 3 })
  assert.equal(retained.events.length, 2)
  for (let index = 0; index < 50; index++) {
    hub.publish({ kind: "session", id: String(index) }, "session.head", { text: "x".repeat(700000) })
  }
  assert.ok((hub as unknown as { historyBytes: number }).historyBytes <= 32 * 1024 * 1024)
  hub.resetEpoch(stream)
  assert.equal(hub.replaySince(stream, hub.getCursor(stream)).resyncRequired, false)
})

test("event subscribers have a finite ceiling and release slots on unsubscribe", () => {
  const hub = new EventHub()
  const subscribers = Array.from({ length: 1024 }, () => hub.subscribe(() => {}))
  assert.throws(() => hub.subscribe(() => {}), /limit/)
  subscribers[0]!()
  const remove = hub.subscribe(() => {})
  remove()
  for (const unsubscribe of subscribers) unsubscribe()
})

test("real websocket subscriptions replay only newly added streams and cap connections", async () => {
  const server = createServer()
  const hub = new EventHub()
  let snapshots = 0
  const wss = attachEventWebSocket(server, { eventHub: hub, authToken: null, maxConnections: 1,
    onSubscribe: () => { snapshots++ } })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`)
  const received: Array<{ type?: string; event?: { stream: { id: string } } }> = []
  ws.on("message", data => received.push(JSON.parse(String(data))))
  const serverStream = { kind: "server" as const, id: "server" }
  const sessionStream = { kind: "session" as const, id: "s" }
  const cursors = hub.getCursorMap([serverStream, sessionStream])
  hub.publish(serverStream, "sessions.updated", {})
  hub.publish(sessionStream, "session.head", {})
  const subscribe = async (streams: typeof serverStream[] | Array<typeof serverStream | typeof sessionStream>) => {
    ws.send(JSON.stringify({ type: "subscribe", protocolVersion: PROTOCOL_VERSION, streams, cursors }))
    const pong = new Promise<void>(resolve => {
      const listener = (data: unknown) => {
        if (JSON.parse(String(data)).type === "pong") { ws.off("message", listener); resolve() }
      }
      ws.on("message", listener)
    })
    ws.send(JSON.stringify({ type: "ping", protocolVersion: PROTOCOL_VERSION }))
    await pong
  }
  try {
    await once(ws, "open")
    await subscribe([serverStream])
    await subscribe([serverStream, sessionStream])
    await subscribe([serverStream, sessionStream])
    assert.deepEqual(received.filter(frame => frame.event).map(frame => frame.event!.stream.id), ["server", "s"])
    assert.equal(snapshots, 1)
    const refused = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`)
    const status = await new Promise<number>(resolve => {
      refused.on("error", () => {})
      refused.on("unexpected-response", (_req, response) => {
        response.resume()
        resolve(response.statusCode!)
        refused.terminate()
      })
    })
    assert.equal(status, 503)
    hub.publish(sessionStream, "session.head", { text: "x".repeat(1024 * 1024) })
    await subscribe([serverStream, sessionStream])
    const control = received.find(frame => frame.type === "resync_required") as unknown as {
      streams: Record<string, unknown>
    }
    assert.ok(control.streams[eventStreamKey(sessionStream)])
  } finally {
    ws.terminate()
    await new Promise<void>(resolve => closeEventWebSocket(wss, () => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("terminal overflow closes with 1013 without pumping the discarded queue", async () => {
  const server = createServer()
  let detached = false
  let activated = false
  const manager = {
    consumeConnectToken: () => "/workspace",
    attach: () => ({ replay: "x".repeat(10 * 1024 * 1024), replayCursor: 0, cursor: 10 * 1024 * 1024,
      activate: () => { activated = true }, detach: () => { detached = true } }),
    get: () => ({ id: "t", cursor: 10 * 1024 * 1024, status: "running" }),
  } as unknown as TerminalManager
  const wss = attachEventWebSocket(server, { eventHub: new EventHub(), authToken: null, terminalManager: manager })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/host/terminals/t/stream?ticket=test`)
  let outputFrames = 0
  ws.on("message", data => { if (JSON.parse(String(data)).type === "output") outputFrames++ })
  try {
    const [code] = await once(ws, "close")
    assert.equal(code, 1013)
    assert.equal(detached, true)
    assert.equal(activated, false)
    assert.ok(outputFrames <= 1)
  } finally {
    ws.terminate()
    await new Promise<void>(resolve => closeEventWebSocket(wss, () => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("HTTP compresses negotiated JSON and all three command routes reject bodies beyond the prompt budget", async () => {
  const previous = process.env.OMPIUI_DRIVER
  process.env.OMPIUI_DRIVER = "mock"
  const app = createAppServer({ authToken: null })
  app.server.listen(0, "127.0.0.1")
  await once(app.server, "listening")
  const port = (app.server.address() as { port: number }).port
  const get = (encoding: string) => new Promise<{ encoding?: string; body: Buffer }>(resolve => {
    request({ host: "127.0.0.1", port, path: "/api/v1/pi/registry", headers: { "accept-encoding": encoding } }, res => {
      const chunks: Buffer[] = []
      res.on("data", chunk => chunks.push(chunk))
      res.on("end", () => resolve({ encoding: String(res.headers["content-encoding"] ?? ""), body: Buffer.concat(chunks) }))
    }).end()
  })
  try {
    const gzip = await get("gzip")
    assert.equal(gzip.encoding, "gzip")
    const plain = await get("gzip;q=0")
    assert.equal(plain.encoding, "")
    assert.deepEqual(JSON.parse(gunzipSync(gzip.body).toString()), JSON.parse(plain.body.toString()))
    assert.ok(plain.body.length > gzip.body.length)
    for (const route of ["/api/v1/pi/commands/noop", "/api/v1/pi/sessions/s/commands/noop", "/api/v1/host/commands/noop"]) {
      const body = Buffer.alloc(MAX_PROMPT_BODY_BYTES + 1, 32)
      const response = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: route, method: "POST",
          headers: { "content-type": "application/json", "content-length": body.length } }, res => {
          res.resume()
          res.on("end", () => resolve({ status: res.statusCode!, connection: res.headers.connection }))
        })
        req.on("error", reject)
        req.end(body)
      })
      assert.equal(response.status, 413)
      assert.equal(response.connection, "close")
    }
  } finally {
    await app.dispose()
    if (previous === undefined) delete process.env.OMPIUI_DRIVER
    else process.env.OMPIUI_DRIVER = previous
  }
})
