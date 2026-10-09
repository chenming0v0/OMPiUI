import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { WebSocket } from "ws"
import { EventHub } from "../event-hub.ts"
import { attachEventWebSocket, closeEventWebSocket } from "../ws.ts"
import { diagnostics, type DiagnosticFields } from "./recorder.ts"

test("refresh reconnect records correlated subscription/resync/state without disturbing agent events", async t => {
  const records: Array<{ event: string; fields: DiagnosticFields }> = []
  t.mock.method(diagnostics, "record", (event: string, fields: DiagnosticFields = {}) => { records.push({ event, fields }) })
  const server = createServer()
  const hub = new EventHub()
  const wss = attachEventWebSocket(server, { eventHub: hub, authToken: null })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  t.after(async () => {
    closeEventWebSocket(wss)
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${typeof address === "object" ? address!.port : 0}/api/v1/events`)
    const frames: any[] = []
    socket.on("message", data => frames.push(JSON.parse(String(data))))
    await once(socket, "open")
    socket.send(JSON.stringify({
      type: "subscribe", protocolVersion: 1,
      streams: [{ kind: "session", id: "s1" }], cursors: {},
    }))
    await waitFor(() => frames.some(frame => frame.type === "resync_required"))
    return { socket, frames }
  }

  const first = await connect()
  const firstClosed = once(first.socket, "close")
  first.socket.close()
  await firstClosed
  await waitFor(() => records.some(record => record.event === "connection.closed"))
  const second = await connect()
  second.socket.send(JSON.stringify({
    type: "diagnostic", protocolVersion: 1, event: "connected", clientId: "reload-page",
    navigation: "reload",
  }))
  second.socket.send(JSON.stringify({
    type: "diagnostic", protocolVersion: 1, event: "state", clientId: "reload-page",
    sessionId: "s1", state: { isStreaming: true },
  }))
  hub.publish({ kind: "session", id: "s1" }, "pi.event", { event: { type: "message_update" } })
  await waitFor(() => records.some(record => record.event === "browser.state") &&
    second.frames.some(frame => frame.channel === "event"))
  const opens = records.filter(record => record.event === "connection.opened")
  assert.equal(opens.length, 2)
  assert.notEqual(opens[0].fields.connectionId, opens[1].fields.connectionId)
  const restored = records.find(record => record.event === "browser.state")!
  assert.equal(restored.fields.connectionId, opens[1].fields.connectionId)
  assert.equal(restored.fields.sessionId, "s1")
  assert.equal(restored.fields.state?.isStreaming, true)
  assert.equal(records.find(record => record.event === "browser.connected")?.fields.navigation, "reload")
  assert.equal(records.some(record => record.event === "session.close.requested"), false)

  // 未订阅的会话、未知事件和超频诊断均不能绕过边界。
  second.socket.send(JSON.stringify({
    type: "diagnostic", protocolVersion: 1, event: "state", clientId: "reload-page",
    sessionId: "s2", state: { isStreaming: false },
  }))
  for (let index = 0; index < 125; index++) {
    second.socket.send(JSON.stringify({
      type: "diagnostic", protocolVersion: 1, event: "visibility", clientId: "reload-page", visibility: "hidden",
    }))
  }
  second.socket.send(JSON.stringify({ type: "ping", protocolVersion: 1 }))
  await waitFor(() => second.frames.some(frame => frame.type === "pong"))
  assert.ok(records.filter(record => record.event === "browser.visibility").length <= 120)
  assert.equal(records.some(record => record.fields.sessionId === "s2"), false)
  const closed = once(second.socket, "close")
  second.socket.close()
  await closed
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for websocket diagnostics")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
