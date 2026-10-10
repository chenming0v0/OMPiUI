// Worker IPC fixture for WorkerSession fault-injection tests.
//
// Modes (env OMPIUI_FIXTURE_MODE):
//   hello-ok          — full protocol: hello + heartbeats + request replies
//   silent            — hello + request replies, but never heartbeats
//   exit-on-request   — hello + heartbeats, then exit(1) on the first request
//   wrong-protocol    — hello with a bumped protocol version, then idle
//   slow-command      — hello + heartbeats, but never replies to requests
//                       (simulates a healthy worker stuck on one command)
//   slow-hello        — hello delayed ~400ms (simulates SDK cold boot), then
//                       heartbeats + request replies as in hello-ok
//
// Heartbeat cadence comes from OMPIUI_FIXTURE_HEARTBEAT_MS (default 20ms) so the
// client watchdog fires quickly without slowing the suite.
import { OMP_WORKER_PROTOCOL_VERSION } from "../../../omp-worker/src/ipc.ts"

const mode = process.env.OMPIUI_FIXTURE_MODE ?? "hello-ok"
const heartbeatIntervalMs = Number(process.env.OMPIUI_FIXTURE_HEARTBEAT_MS ?? 20)
const generation = "fixture-gen"
const sessions = new Set()
const sessionIds = new Map()
let nextSession = 0

const send = (message) => process.send?.(message)

const hello = () => send({
  kind: "hello",
  workerProtocolVersion: mode === "wrong-protocol" ? OMP_WORKER_PROTOCOL_VERSION + 1 : OMP_WORKER_PROTOCOL_VERSION,
  piSdkVersion: "0.84.0",
  piSdkVerified: true,
  generation,
  processId: process.pid,
  heartbeatIntervalMs,
})

if (mode === "slow-hello") {
  setTimeout(hello, 400)
} else {
  hello()
}

if (mode === "silent" || mode === "wrong-protocol") {
  // Never heartbeat. The client settles the ready error on the wrong protocol
  // version and never talks to us again; exit shortly so dispose() resolves
  // quickly instead of waiting out its kill timeout.
  process.on("message", () => {})
  if (mode === "wrong-protocol") {
    setTimeout(() => process.exit(0), 50).unref?.()
  }
} else {
  const heartbeat = setInterval(() => {
    send({ kind: "heartbeat", generation, timestamp: Date.now() })
  }, heartbeatIntervalMs)
  heartbeat.unref?.()

  if (mode === "exit-on-request") {
    process.on("message", message => {
      if (message && typeof message === "object" && message.kind === "request") {
        process.exit(1)
      }
    })
  } else if (mode === "slow-command") {
    // Healthy heartbeats, but never reply to any request. Models a worker
    // whose event loop is alive (heartbeats flow) while one command hangs
    // (e.g. a slow model call). The client must time the command out and
    // KEEP the worker — killing it here would murder a healthy process.
    process.on("message", message => {
      if (message && typeof message === "object" && message.kind === "request" &&
          message.command?.type === "dispose") {
        send({ kind: "response", id: message.id, generation, ok: true })
        setImmediate(() => process.exit(0))
      }
    })
  } else {
    process.on("message", message => {
      if (!message || typeof message !== "object" || message.kind !== "request") return
      const reply = { kind: "response", id: message.id, generation, ok: true, data: { fixture: "ok" } }
      if (message.command?.type === "session.open") {
        const file = message.command.params?.sessionFile
        const sessionId = sessionIds.get(file) ?? `fixture-session-${++nextSession}`
        if (file) sessionIds.set(file, sessionId)
        const opened = () => {
          sessions.add(sessionId)
          send({ ...reply, data: { sessionId, sessionFile: message.command.params?.sessionFile, cwd: message.command.params?.cwd } })
        }
        if (mode === "slow-open") setTimeout(opened, 150)
        else opened()
        return
      }
      if (message.command?.type === "session.close") sessions.delete(message.sessionId)
      if (message.command?.type === "fixture.sessions") reply.data = { active: sessions.size }
      if (message.command?.type === "fixture.crash") {
        sessions.delete(message.sessionId)
        send({ kind: "event", generation, sessionId: message.sessionId, channel: "session.crashed", event: { message: "fixture OMP child exited" } })
      }
      send(reply)
      // Mirror the real worker: acknowledge dispose, then exit so the client's
      // dispose() doesn't wait out its 5s kill timeout.
      if (message.command?.type === "dispose") {
        setImmediate(() => process.exit(0))
      }
    })
  }
}
