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
  const entries: JsonObject[] = []
  const native: JsonObject = { sessionId: "old-session", cwd: process.cwd(), isStreaming: true }
  const rpc = {
    onRequest: (_command: JsonObject): void | Promise<void> => {},
    async request(command: JsonObject) {
      commands.push(structuredClone(command))
      if (["new_session", "switch_session", "branch"].includes(String(command.type))) {
        native.sessionId = `replacement-${command.type}`
      }
      if (command.type === "set_steering_mode") native.steeringMode = command.mode
      if (command.type === "set_follow_up_mode") native.followUpMode = command.mode
      await rpc.onRequest(command)
      const data = command.type === "get_state" ? structuredClone(native)
        : command.type === "get_entries" ? { entries: structuredClone(entries), leafId: entries.at(-1)?.id ?? null }
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
    session, commands, responses, native, rpc, entries,
    frame: (frame: OmpRpcFrame) => internal.handleFrame(frame),
    drain: () => internal.userQueueDrain,
  }
}

const emptyQueue: QueueSnapshot = { steering: [], followUp: [], steeringEntries: [], followUpEntries: [] }
const image = (data: string): ImageInput => ({ type: "image", data, mimeType: "image/png" })

describe("OmpRpcSession immediate queued delivery", () => {
  it("submits only the selected message with images before the current turn ends", async t => {
    const { session, frame, commands, entries } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.sendUserMessage("neighbor", undefined, "followUp")
    await session.sendUserMessage("send now", [image("AgM=")], "followUp")
    await session.sendQueuedMessage("followUp", 1)
    assert.deepEqual(commands.filter(command => command.type === "steer"), [
      { type: "steer", message: "send now", images: [image("AgM=")] },
    ])
    const accepted = await session.getState()
    assert.deepEqual((accepted.queue as QueueSnapshot).followUp, ["neighbor"])
    assert.equal((accepted.submittedMessages as JsonObject[]).length, 1)
    assert.deepEqual((accepted.submittedMessages as JsonObject[])[0]!.message, {
      role: "user", content: [{ type: "text", text: "send now" }, image("AgM=")],
      timestamp: ((accepted.submittedMessages as JsonObject[])[0]!.message as JsonObject).timestamp,
    })
    const message: JsonObject = {
      role: "user", content: [{ type: "text", text: "send now" }, image("AgM=")], timestamp: 123456,
    }
    frame({ type: "message_start", message })
    const consumed = (await session.getState()).submittedMessages as JsonObject[]
    assert.equal((consumed[0]!.message as JsonObject).timestamp, 123456)
    entries.push({ type: "message", id: "native-user", parentId: null, timestamp: new Date(123456).toISOString(), message })
    frame({ type: "message_end", message })
    await session.ensureSynced()
    assert.deepEqual((await session.getState()).submittedMessages, [])
    assert.equal((await session.getBranchPage(undefined, 100, 100000)).items.length, 1)
  })

  it("retains the selected message on failed submission and rejects overlapping submissions", async t => {
    const { session, frame, rpc } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.sendUserMessage("keep", [image("AA==")], "steer")
    let fail = true
    rpc.onRequest = command => {
      if (command.type === "steer" && fail) throw new Error("provider rejected")
    }
    await assert.rejects(session.sendQueuedMessage("steering", 0), /provider rejected/)
    assert.deepEqual((await session.getState()).submittedMessages, [])
    assert.deepEqual(((await session.getState()).queue as QueueSnapshot).steering, ["keep"])
    fail = false
    const sending = session.sendQueuedMessage("steering", 0)
    await assert.rejects(session.sendQueuedMessage("steering", 0), /already being submitted/)
    await sending
    assert.deepEqual(((await session.getState()).queue as QueueSnapshot).steering, [])
  })

  it("starts a normal prompt if the queued message is sent after the turn becomes idle", async t => {
    const { session, frame, native, commands } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.sendUserMessage("idle send", undefined, "followUp")
    native.isStreaming = false
    await session.getState()
    await session.sendQueuedMessage("followUp", 0)
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [{ type: "prompt", message: "idle send" }])
  })
})

describe("OmpRpcSession background history synchronization", () => {
  it("contains both event and timer sync failures and retries on the next read", async t => {
    const { session, frame, rpc, entries } = await sessionFixture(t)
    t.mock.method(console, "error", () => undefined)
    let failed = true
    rpc.onRequest = command => {
      if (command.type === "get_entries" && failed) throw new Error("history transport failed")
    }
    frame({ type: "message_end", message: { role: "assistant", content: [], timestamp: 1 } })
    await new Promise(resolve => setTimeout(resolve, 180))
    failed = false
    entries.push({ type: "message", id: "recovered", parentId: null, timestamp: new Date(1).toISOString(),
      message: { role: "assistant", content: [], timestamp: 1 } })
    assert.equal((await session.getBranchPage(undefined, 100, 100000)).items.length, 1)
  })
})

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

describe("OmpRpcSession goal pause and continuation", () => {
  it("aborts the running turn and clears queued messages before acknowledging pause", async t => {
    const { session, frame, commands, native, rpc, drain } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.manageGoal({ op: "set", objective: "Finish the task" })
    await session.sendUserMessage("must not restart", undefined, "followUp")
    const events: JsonObject[] = []
    session.onPiEvent(event => events.push(event))
    rpc.onRequest = command => {
      if (command.type !== "abort") return
      native.isStreaming = false
      frame({ type: "agent_end" })
      frame({ type: "session_settled" })
    }

    const result = await session.manageGoal({ op: "pause" })
    await drain()
    const state = await session.getState()
    assert.equal((result.goal as JsonObject).status, "paused")
    assert.equal((state.goal as JsonObject).status, "paused")
    assert.equal(state.isStreaming, false)
    assert.deepEqual((state.queue as QueueSnapshot).followUp, [])
    assert.equal(commands.filter(command => command.type === "abort").length, 1)
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [])
    assert.ok(events.some(event => event.type === "agent_settled"))
  })

  it("does not submit an idle goal continuation if pause arrives before the RPC write", async t => {
    const { session, commands, native } = await sessionFixture(t)
    native.isStreaming = false
    await session.getState()
    const setting = session.manageGoal({ op: "set", objective: "Finish the task" })
    const pausing = session.manageGoal({ op: "pause" })
    await Promise.all([setting, pausing])
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [])
    assert.equal((await session.getState()).isStreaming, false)
  })

  it("waits for abort and starts only the latest resumed continuation", async t => {
    const { session, frame, commands, native, rpc } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.manageGoal({ op: "set", objective: "Finish the task" })
    let releaseAbort!: () => void
    rpc.onRequest = command => {
      if (command.type !== "abort") return
      native.isStreaming = false
      frame({ type: "agent_end" })
      return new Promise<void>(resolve => { releaseAbort = resolve })
    }
    const firstPause = session.manageGoal({ op: "pause" })
    let pauseCompleted = false
    void firstPause.then(() => { pauseCompleted = true })
    await session.manageGoal({ op: "resume" })
    const secondPause = session.manageGoal({ op: "pause" })
    await session.manageGoal({ op: "resume" })
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [])
    assert.equal(pauseCompleted, false)
    assert.equal(commands.filter(command => command.type === "abort").length, 1)
    releaseAbort()
    await Promise.all([firstPause, secondPause])
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(commands.filter(command => command.type === "abort").length, 1)
    const prompts = commands.filter(command => command.type === "prompt")
    assert.equal(prompts.length, 1)
    assert.match(String(prompts[0]!.message), /Finish the task/)
    assert.equal(prompts[0]!.streamingBehavior, undefined)
    assert.equal(((await session.getState()).goal as JsonObject).status, "active")
  })

  it("propagates abort failure and allows a paused goal to retry stopping", async t => {
    const { session, frame, native, rpc, commands } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.manageGoal({ op: "set", objective: "Finish the task" })
    let fail = true
    rpc.onRequest = command => {
      if (command.type !== "abort") return
      if (fail) throw new Error("abort transport failed")
      native.isStreaming = false
    }
    await assert.rejects(session.manageGoal({ op: "pause" }), /abort transport failed/)
    assert.equal(((await session.getState()).goal as JsonObject).status, "paused")
    fail = false
    await session.manageGoal({ op: "pause" })
    assert.equal((await session.getState()).isStreaming, false)
    assert.equal(commands.filter(command => command.type === "abort").length, 2)
  })

  it("cancels a queued-message drain that was scheduled just before abort", async t => {
    const { session, frame, commands, native, drain } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.sendUserMessage("must not restart")
    native.isStreaming = false
    frame({ type: "agent_end" })
    const draining = drain()
    await session.abort()
    await draining
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [])
    assert.deepEqual((await session.getState()).queue, {
      ...emptyQueue, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
    })
  })

  it("still submits an explicit new user prompt with images after abort finishes", async t => {
    const { session, frame, commands, native, rpc } = await sessionFixture(t)
    frame({ type: "agent_start" })
    let releaseAbort!: () => void
    rpc.onRequest = command => {
      if (command.type !== "abort") return
      native.isStreaming = false
      frame({ type: "agent_end" })
      return new Promise<void>(resolve => { releaseAbort = resolve })
    }
    const stopping = session.abort()
    const sending = session.sendUserMessage("new request", [image("AgM=")], "followUp")
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [])
    releaseAbort()
    await Promise.all([stopping, sending])
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [
      { type: "prompt", message: "new request", images: [image("AgM=")] },
    ])
  })

  it("does not auto-continue after pausing during the settle grace period", async t => {
    const { session, frame, commands, native } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.manageGoal({ op: "set", objective: "Finish the task" })
    native.isStreaming = false
    frame({ type: "session_settled" })
    await session.manageGoal({ op: "pause" })
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [])
    assert.equal(((await session.getState()).goal as JsonObject).status, "paused")
  })

  it("still auto-continues an active goal after the turn settles", async t => {
    const { session, frame, commands, native } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.manageGoal({ op: "set", objective: "Finish the task" })
    native.isStreaming = false
    frame({ type: "session_settled" })
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(commands.filter(command => command.type === "prompt").length, 1)
    assert.equal(((await session.getState()).goal as JsonObject).status, "active")
  })

  it("still completes a goal with the completion marker without another turn", async t => {
    const { session, frame, commands, native, entries } = await sessionFixture(t)
    frame({ type: "agent_start" })
    await session.manageGoal({ op: "set", objective: "Finish the task" })
    entries.push({
      type: "message", id: "completed", parentId: null, timestamp: new Date(1).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "Done\nGOAL_COMPLETE" }], timestamp: 1 },
    })
    native.isStreaming = false
    frame({ type: "session_settled" })
    await session.ensureSynced()
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [])
    assert.equal(((await session.getState()).goal as JsonObject).status, "complete")
  })
})

describe("OmpRpcSession configuration reporting", () => {
  it("preserves native model reasoning metadata when the available-model cache has not caught up", async t => {
    const { session, native } = await sessionFixture(t)
    native.model = { provider: "custom", id: "correct", name: "Correct model", reasoning: true, input: ["text", "image"] }
    native.thinkingLevel = "xhigh"
    const state = await session.getState()
    assert.deepEqual(state.model, native.model)
    assert.equal(state.thinkingLevel, "xhigh")
  })

  it("rejects unsuccessful model and thinking RPC responses instead of acknowledging the selection", async t => {
    const { session } = await sessionFixture(t)
    const client = (session as unknown as { client: { request: unknown } }).client
    t.mock.method(client, "request", async (command: JsonObject) => ({
      type: "response", command: command.type, success: false, error: "unsupported selection",
    }))
    await assert.rejects(session.setModel("custom", "wrong"), /unsupported selection/)
    await assert.rejects(session.setThinkingLevel("wrong"), /unsupported selection/)
  })
})
