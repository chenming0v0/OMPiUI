import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { it } from "node:test"
import { createAppServer } from "./http.ts"
import { shutdownAppServer } from "./shutdown.ts"
import { attachEventWebSocket } from "./ws.ts"

it("ends a stalled HTTP request at the shutdown deadline without forcing exit", async () => {
  const app = createAppServer({ authToken: null })
  const eventServer = attachEventWebSocket(app.server, { eventHub: app.eventHub, authToken: null })
  await new Promise<void>((resolve, reject) => {
    app.server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()))
  })
  const address = app.server.address()
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port")
  const socket = createConnection({ host: "127.0.0.1", port: address.port })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  socket.write("POST /api/v1/host/commands/workspaces.open HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{")

  let timedOut = false
  let forcedExit = false
  await shutdownAppServer(app.server, eventServer, {
    timeoutMs: 20,
    hardStopGraceMs: 20,
    onTimeout: () => { timedOut = true },
    forceExit: () => { forcedExit = true },
  })
  await app.supervisor.dispose()
  await new Promise(resolve => setTimeout(resolve, 30))

  assert.equal(timedOut, true)
  assert.equal(forcedExit, false)
  assert.equal(socket.destroyed, true)
})

it("does not force exit during worker cleanup after HTTP has closed", async () => {
  const app = createAppServer({ authToken: null })
  const eventServer = attachEventWebSocket(app.server, { eventHub: app.eventHub, authToken: null })
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve))
  let forcedExit = false
  let cleaned = false
  await shutdownAppServer(app.server, eventServer, {
    timeoutMs: 10,
    hardStopGraceMs: 10,
    cleanupTimeoutMs: 1_000,
    forceExit: () => { forcedExit = true },
    cleanup: async () => {
      assert.equal(app.server.listening, false)
      await new Promise(resolve => setTimeout(resolve, 100))
      await app.dispose()
      cleaned = true
    },
  })
  assert.equal(cleaned, true)
  assert.equal(forcedExit, false)
})

it("still enforces a separate deadline for stuck worker cleanup", async () => {
  const app = createAppServer({ authToken: null })
  const eventServer = attachEventWebSocket(app.server, { eventHub: app.eventHub, authToken: null })
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve))
  let forcedExit = false
  await shutdownAppServer(app.server, eventServer, {
    timeoutMs: 10,
    hardStopGraceMs: 10,
    cleanupTimeoutMs: 20,
    forceExit: () => { forcedExit = true },
    cleanup: async () => {
      await new Promise(resolve => setTimeout(resolve, 80))
      await app.dispose()
    },
  })
  assert.equal(forcedExit, true)
})
