import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it, type TestContext } from "node:test"
import type { ImageInput, JsonObject } from "@ompiui/protocol"
import { OmpExtensionUiBridge } from "./omp-extension-ui.js"
import { OmpRpcSession } from "./omp-session.js"
import type { OmpRpcFrame } from "./rpc-client.js"

type QueueEntry = { text: string; images?: ImageInput[] }
type QueueSnapshot = {
  steering: string[]
  followUp: string[]
  steeringEntries: QueueEntry[]
  followUpEntries: QueueEntry[]
}

// Exercise the real session adapter with a deterministic RPC transport, not an
// installed OMP process. In particular, this does not bypass its version gate.
async function sessionFixture(t: TestContext) {
  const session = Reflect.construct(OmpRpcSession, []) as OmpRpcSession
  const internal = session as unknown as {
    client: unknown
    extensionUi: OmpExtensionUiBridge
    refreshIdentity(): Promise<void>
    handleFrame(frame: OmpRpcFrame): void
    userQueueDrain?: Promise<void>
  }
  const commands: JsonObject[] = []
  const responses: JsonObject[] = []
  const native: JsonObject = { sessionId: "old-session", cwd: process.cwd(), isStreaming: true }
  const rpc = {
    onRequest: (_command: JsonObject) => {},
    async request(command: JsonObject) {
      commands.push(structuredClone(command))
      if (["new_session", "switch_session", "branch"].includes(String(command.type))) {
        native.sessionId = `replacement-${command.type}`
      }
      if (command.type === "set_steering_mode") native.steeringMode = command.mode
      if (command.type === "set_follow_up_mode") native.followUpMode = command.mode
      rpc.onRequest(command)
      const data = command.type === "get_state" ? structuredClone(native)
        : command.type === "get_entries" ? { entries: [], leafId: null }
          : {}
      return { type: "response", success: true, command: command.type, data }
    },
    writeExtensionUiResponse(response: JsonObject) { responses.push(response) },
    async close() {},
  }
  internal.client = rpc
  await internal.refreshIdentity()
  internal.extensionUi.bind(session.getSessionId(), response => rpc.writeExtensionUiResponse(response))
  t.after(() => session.dispose())
  return {
    session, commands, responses, native, rpc,
    frame: (frame: OmpRpcFrame) => internal.handleFrame(frame),
    drain: () => internal.userQueueDrain,
  }
}

const emptyQueue: QueueSnapshot = { steering: [], followUp: [], steeringEntries: [], followUpEntries: [] }
const image = (data: string): ImageInput => ({ type: "image", data, mimeType: "image/png" })

describe("OmpRpcSession extension identity after replacement", () => {
  for (const operation of ["new", "switch", "fork"] as const) {
    it(`rebinds before ${operation} synchronization publishes extension events`, async t => {
      const { session, frame, rpc, responses } = await sessionFixture(t)
      const events: JsonObject[] = []
      session.onExtensionUi(event => events.push(event))
      frame({ type: "extension_ui_request", method: "input", id: "old-dialog", title: "Old" })
      frame({ type: "extension_ui_request", method: "setStatus", key: "old", text: "Old state" })
      events.length = 0

      let emitted = false
      rpc.onRequest = command => {
        if (command.type !== "get_entries" || emitted) return
        emitted = true
        frame({ type: "extension_ui_request", method: "select", id: "new-dialog", title: "New", options: ["yes"] })
        frame({ type: "extension_ui_request", method: "notify", message: "New notification" })
        frame({ type: "extension_ui_request", method: "setStatus", key: "new", text: "New state" })
        frame({ type: "extension_ui_request", method: "set_editor_text", text: "New editor" })
      }

      let targetPath = ""
      if (operation === "switch") {
        const root = mkdtempSync(path.join(tmpdir(), "ompiui-identity-"))
        const previous = process.env.OMPIUI_DATA_DIR
        process.env.OMPIUI_DATA_DIR = root
        t.after(() => {
          if (previous === undefined) delete process.env.OMPIUI_DATA_DIR
          else process.env.OMPIUI_DATA_DIR = previous
          rmSync(root, { recursive: true, force: true })
        })
        mkdirSync(path.join(root, "sessions"))
        targetPath = path.join(root, "sessions", "target.jsonl")
        writeFileSync(targetPath, "")
      }
      const result = operation === "new" ? await session.newSession()
        : operation === "switch" ? await session.switchSession(targetPath)
          : await session.fork("entry", "at")
      const targetId = session.getSessionId()
      assert.notEqual(targetId, "old-session")
      assert.equal(result.sourceSessionId, "old-session")
      assert.equal(result.targetSessionId, targetId)
      assert.deepEqual(events.shift(), {
        type: "settled", requestId: "old-dialog", sessionId: "old-session", reason: "session_replaced",
      })
      assert.deepEqual(responses.shift(), { type: "extension_ui_response", id: "old-dialog", cancelled: true })
      assert.deepEqual(events.map(event => event.type), ["requested", "notify", "state", "editor"])
      for (const event of events) {
        assert.equal(event.type === "requested" ? (event.request as JsonObject).sessionId : event.sessionId, targetId)
      }
      const state = await session.getState()
      assert.deepEqual((state.pendingExtensionUiRequests as JsonObject[]).map(request => request.sessionId), [targetId])
      assert.deepEqual(state.extensionUiState, [{ kind: "status", key: "new", text: "New state" }])

      assert.equal(await session.respondExtensionUi("old-dialog", { value: "stale" }), false)
      assert.equal(await session.respondExtensionUi("new-dialog", { value: "yes" }), true)
      assert.deepEqual(responses.at(-1), { type: "extension_ui_response", id: "new-dialog", value: "yes" })
      assert.deepEqual(events.at(-1), { type: "settled", requestId: "new-dialog", sessionId: targetId, reason: "submitted" })
      frame({ type: "extension_ui_request", method: "notify", message: "After replacement" })
      assert.equal(events.at(-1)?.sessionId, targetId)
    })
  }
})

describe("OmpRpcSession image-bearing user queue", () => {
  it("preserves duplicate text, image-only entries and clone boundaries in snapshots, events and clear results", async t => {
    const { session, frame } = await sessionFixture(t)
    const events: JsonObject[] = []
    session.onPiEvent(event => { if (event.type === "queue_update") events.push(event) })
    frame({ type: "agent_start" })
    const inputs = [image("AAEC+/==")]
    await session.sendUserMessage("duplicate", inputs, "steer")
    const firstEvent = events[0] as QueueSnapshot
    inputs[0]!.data = "caller mutation"
    inputs.push(image("extra"))
    firstEvent.steeringEntries[0]!.images![0]!.mimeType = "event mutation"
    firstEvent.steering.push("event-only")
    await session.sendUserMessage("duplicate", [image("AgM=")], "steer")
    await session.sendUserMessage("", [image("BAU=")], "steer")
    await session.sendUserMessage("duplicate", [image("Bgc=")])
    await session.sendUserMessage("duplicate")
    await session.sendUserMessage("", [image("CAk=")])
    const expected: QueueSnapshot = {
      steering: ["duplicate", "duplicate", ""], followUp: ["duplicate", "duplicate", ""],
      steeringEntries: [
        { text: "duplicate", images: [image("AAEC+/==")] },
        { text: "duplicate", images: [image("AgM=")] },
        { text: "", images: [image("BAU=")] },
      ],
      followUpEntries: [
        { text: "duplicate", images: [image("Bgc=")] },
        { text: "duplicate" },
        { text: "", images: [image("CAk=")] },
      ],
    }
    assert.deepEqual(events.at(-1), { type: "queue_update", ...expected })
    await session.setSteeringMode("all")
    await session.setFollowUpMode("all")
    const snapshot = (await session.getState()).queue as QueueSnapshot
    assert.deepEqual(snapshot, { ...expected, steeringMode: "all", followUpMode: "all" })
    snapshot.steeringEntries[0]!.images![0]!.data = "snapshot mutation"
    snapshot.followUpEntries.splice(0)
    snapshot.followUp.splice(0)

    // Native/internal queue contents must not replace editable user entries.
    frame({ type: "queue_update", steering: ["internal"], followUp: [], steeringEntries: [{ text: "internal" }], followUpEntries: [] })
    assert.deepEqual(events.at(-1), { type: "queue_update", ...expected })
    const cleared = await session.clearQueue() as QueueSnapshot
    assert.deepEqual(cleared, expected)
    assert.deepEqual(events.at(-1), { type: "queue_update", ...emptyQueue })
    assert.deepEqual((await session.getState()).queue, { ...emptyQueue, steeringMode: "all", followUpMode: "all" })

    // Replaying the authoritative clear result copies attachments again.
    await session.sendUserMessage(cleared.steeringEntries[1]!.text, cleared.steeringEntries[1]!.images, "followUp")
    cleared.steeringEntries[1]!.images![0]!.data = "clear-result mutation"
    assert.deepEqual((await session.getState()).queue, {
      ...emptyQueue, followUp: ["duplicate"], followUpEntries: [{ text: "duplicate", images: [image("AgM=")] }],
      steeringMode: "all", followUpMode: "all",
    })
  })

  it("drains image-only messages without losing encoding or a duplicate-text neighbor", async t => {
    const { session, frame, commands, native, drain } = await sessionFixture(t)
    const events: JsonObject[] = []
    session.onPiEvent(event => { if (event.type === "queue_update") events.push(event) })
    frame({ type: "agent_start" })
    await session.sendUserMessage("", [image("AAEC+/==")], "steer")
    await session.sendUserMessage("", [image("AgM=")], "steer")
    native.isStreaming = false
    frame({ type: "agent_end" })
    await drain()
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [
      { type: "prompt", message: "", images: [image("AAEC+/==")] },
    ])
    assert.deepEqual(events.at(-1), {
      type: "queue_update", ...emptyQueue, steering: [""], steeringEntries: [{ text: "", images: [image("AgM=")] }],
    })
    assert.deepEqual(await session.clearQueue(), {
      ...emptyQueue, steering: [""], steeringEntries: [{ text: "", images: [image("AgM=")] }],
    })
  })
})

describe("OmpRpcSession idle reporting for host recycling", () => {
  it("surfaces hasPendingAsyncWork and keeps isIdle false while the session can still wake", async t => {
    const { session, native } = await sessionFixture(t)
    // 回合已 yield，但后台作业（bash 后台化 / async task / eval）还会把会话叫醒：
    // OMP 此时 isStreaming=false、isSettled=false、hasPendingAsyncWork=true。
    // 宿主的空闲回收判据完全依赖这两个字段，丢失就会误杀正在收尾的会话。
    native.isStreaming = false
    native.isSettled = false
    native.hasPendingAsyncWork = true
    const pending = await session.getState()
    assert.equal(pending.isStreaming, false)
    assert.equal(pending.isIdle, false)
    assert.equal(pending.hasPendingAsyncWork, true)

    native.isSettled = true
    delete native.hasPendingAsyncWork
    const settled = await session.getState()
    assert.equal(settled.isIdle, true)
    assert.equal(settled.hasPendingAsyncWork, false)
  })
})
