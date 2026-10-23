import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it, type TestContext } from "node:test"
import type { ImageInput, JsonObject } from "@ompiui/protocol"
import { parseGoalMessage } from "@ompiui/protocol"
import { OmpExtensionUiBridge } from "./omp-extension-ui.js"
import { OmpRpcSession } from "./omp-session.js"
import type { OmpRpcFrame } from "./rpc-client.js"


// Exercise consumer-visible session projection and transitions with a controlled
// native transport. Installed RPC smoke is run separately by the main agent.
async function sessionFixture(t: TestContext) {
  const session = Reflect.construct(OmpRpcSession, []) as OmpRpcSession
  const internal = session as unknown as {
    client: unknown
    extensionUi: OmpExtensionUiBridge
    refreshIdentity(): Promise<void>
    handleFrame(frame: OmpRpcFrame): void
    resetHistory(): void
  }
  const commands: JsonObject[] = []
  const responses: JsonObject[] = []
  const entries: JsonObject[] = []
  const native: JsonObject = { sessionId: "old-session", sessionFile: null, cwd: process.cwd(), isStreaming: true }
  const rpc = Object.assign(new EventEmitter(), {
    onRequest: (_command: JsonObject): void | JsonObject | Promise<void | JsonObject> => {},
    async request(command: JsonObject) {
      commands.push(structuredClone(command))
      if (command.type === "set_steering_mode") native.steeringMode = command.mode
      if (command.type === "set_follow_up_mode") native.followUpMode = command.mode
      const override = await rpc.onRequest(command)
      if (override) return { type: "response", success: true, command: command.type, ...override }
      if (["new_session", "switch_session"].includes(String(command.type))) {
        native.sessionId = `replacement-${command.type}`
      }
      const data = command.type === "get_state" ? structuredClone(native)
        : command.type === "get_entries" ? { entries: structuredClone(entries), leafId: native.leafId === undefined ? entries.at(-1)?.id ?? null : native.leafId }
          : command.type === "get_available_thinking_levels" ? { levels: ["off", "high"] }
            : {}
      return { type: "response", success: true, command: command.type, data }
    },
    async requestRuntime(operation: string, args: JsonObject = {}) {
      const command = { type: operation, ...args }
      commands.push(structuredClone(command))
      const override = await rpc.onRequest(command)
      if (override?.success === false) throw new Error(String(override.error))
      if (override?.data !== undefined) {
        if ((operation === "fork" || operation === "navigateTree") && override.data && typeof override.data === "object" && !Array.isArray(override.data))
          return { ...native, leafId: native.leafId === undefined ? entries.at(-1)?.id ?? null : native.leafId, ...override.data };
        return override.data;
      }
      if (operation === "identity") return structuredClone(native)
      if (operation === "fork") {
        native.sessionId = "replacement-fork"
        native.sessionFile = path.join(process.cwd(), "replacement-fork.jsonl")
        return { ...native, leafId: native.leafId ?? null, cancelled: false, selectedText: "selected draft" }
      }
      if (operation === "navigateTree") {
        native.leafId = args.entryId
        return { ...native, cancelled: false, editorText: "restored draft" }
      }
      return operation === "queue" ? { steering: [], followUp: [] }
        : operation === "resources" ? { skills: [], prompts: [], contextFiles: [], tools: [], activeTools: [], commands: [] }
          : {}
    },
    writeExtensionUiResponse(response: JsonObject) { responses.push(response) },
    async close() {},
  })
  internal.client = rpc
  await internal.refreshIdentity()
  internal.extensionUi.bind(session.getSessionId(), response => rpc.writeExtensionUiResponse(response))
  t.after(() => session.dispose())
  return {
    session, commands, responses, native, rpc, entries,
    frame: (frame: OmpRpcFrame) => internal.handleFrame(frame),
  }
}

const image = (data: string): ImageInput => ({ type: "image", data, mimeType: "image/png" })

describe("OmpRpcSession native subagent progress", () => {
  it("tracks progress.id and keeps the parent task identity in refreshed state", async t => {
    const { session, frame } = await sessionFixture(t)
    frame({ type: "subagent_lifecycle", payload: {
      id: "LaneAppNav", parentToolCallId: "task-call", status: "started", index: 0,
    } })
    frame({ type: "subagent_progress", payload: {
      index: 0, parentToolCallId: "task-call", task: "Review navigation",
      sessionFile: "C:/sessions/parent/LaneAppNav.jsonl",
      progress: { id: "LaneAppNav", status: "running", currentTool: "read", tokens: 123 },
    } })
    const state = await session.getState()
    assert.deepEqual((state.subagents as JsonObject[])[0]?.progress, {
      id: "LaneAppNav", status: "running", currentTool: "read", tokens: 123,
    })
    assert.equal((state.subagents as JsonObject[])[0]?.sessionFile, "C:/sessions/parent/LaneAppNav.jsonl")
    assert.equal((state.subagents as JsonObject[])[0]?.parentToolCallId, "task-call")
  })

  it("coalesces parent task snapshots but preserves the final tool result and every bash delta", async t => {
    const { session, frame } = await sessionFixture(t)
    const events: JsonObject[] = []
    session.onPiEvent(event => events.push(event))
    for (let index = 0; index < 10_000; index++) {
      frame({ type: "tool_execution_update", toolCallId: "parent-task", partialResult: {
        content: [{ type: "text", text: `Progress ${index}` }],
      } })
    }
    assert.equal(events.length, 0)
    frame({ type: "tool_execution_end", toolCallId: "parent-task", result: { content: "All ten results" } })
    assert.equal(events.length, 2)
    assert.equal(((events[0]!.partialResult as JsonObject).content as JsonObject[])[0]?.text, "Progress 9999")
    assert.equal((events[1]!.result as JsonObject).content, "All ten results")
    for (let index = 0; index < 20; index++) {
      frame({ type: "bash_execution_update", id: "bash-stream", delta: String(index) })
    }
    assert.equal(events.filter(event => event.type === "bash_execution_update").map(event => event.delta).join(","), Array.from({ length: 20 }, (_, index) => String(index)).join(","))
  })
})

describe("OmpRpcSession authoritative lifecycle", () => {
  it("keeps nonterminal end busy until native settle and preserves queued work on Stop", async t => {
    const { session, frame, native, rpc } = await sessionFixture(t)
    const activity: unknown[] = []
    const events: JsonObject[] = []
    session.onActivity(value => activity.push(value))
    session.onPiEvent(value => events.push(value))
    rpc.onRequest = command => command.type === "queue"
      ? { data: { steering: [{ text: "keep", images: [image("AA==")] }], followUp: [] } } : undefined
    frame({ type: "agent_start" })
    frame({ type: "agent_end", isTerminal: false })
    assert.deepEqual(activity, [{ type: "busy" }])
    native.isStreaming = false
    native.isSettled = false
    native.queuedMessageCount = 1
    await session.abort()
    const state = await session.getState()
    assert.equal(state.isIdle, false)
    assert.equal(state.pendingMessageCount, 1)
    assert.deepEqual((state.queue as JsonObject).steeringEntries, [{ text: "keep", images: [image("AA==")] }])
    assert.equal(events.some(event => event.type === "agent_settled"), false)
    native.queuedMessageCount = 0
    native.isSettled = true
    frame({ type: "session_settled" })
    assert.equal(activity.at(-1), null)
    assert.equal((await session.getState()).isSettled, true)
  })

  it('preserves a native resumed turn that starts before the Stop ACK', async t => {
    const { session, frame, native, rpc } = await sessionFixture(t)
    const events: JsonObject[] = []
    session.onPiEvent(event => events.push(event))
    rpc.onRequest = command => {
      if (command.type !== 'abort') return
      native.isStreaming = true
      native.isSettled = false
      frame({ type: 'agent_start' })
      frame({ type: 'message_start', messageId: 'resumed', message: { role: 'assistant', content: [{ type: 'text', text: 'retained follow-up running' }] } })
    }
    await session.abort()
    const state = await session.getState()
    assert.equal(state.isStreaming, true)
    assert.equal(state.isSettled, false)
    const branch = await session.getBranchPage(undefined, 100, 100000)
    assert.equal((branch.checkpoint?.liveMessage as JsonObject).id, 'resumed')
    assert.equal(events.some(event => event.type === 'agent_settled'), false)
  })

  it('keeps async-only work busy after Stop and records cancellation only on native settle', async t => {
    const { session, frame, native } = await sessionFixture(t)
    native.isStreaming = false
    native.isSettled = false
    native.hasPendingAsyncWork = true
    await session.abort()
    const pending = await session.getState()
    assert.equal(pending.isIdle, false)
    assert.equal(pending.toolInterruption, undefined)
    native.hasPendingAsyncWork = false
    native.isSettled = true
    frame({ type: 'session_settled' })
    const settled = await session.getState()
    assert.equal((settled.toolInterruption as JsonObject).kind, 'cancelled')
    frame({ type: 'agent_start' })
    native.isStreaming = true
    native.isSettled = false
    assert.equal((await session.getState()).toolInterruption, undefined)
  })
  it('does not let a pre-Stop state read erase a newer native resumed run', async t => {
    const { session, frame, native, rpc } = await sessionFixture(t)
    native.isStreaming = false
    native.isSettled = true
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first = true
    rpc.onRequest = command => {
      if (command.type !== 'get_state' || !first) return
      first = false
      const stale = structuredClone(native)
      started.resolve()
      return release.promise.then(() => ({ data: stale }))
    }
    const reading = session.getState()
    await started.promise
    native.isStreaming = true
    native.isSettled = false
    frame({ type: 'agent_start' })
    release.resolve()
    const state = await reading
    assert.equal(state.isStreaming, true)
    assert.equal(state.isSettled, false)
  })
  it('reads authoritative queue state without manufacturing an event or invalidating its caller', async t => {
    const { session, native, rpc } = await sessionFixture(t)
    native.isStreaming = false
    native.isSettled = false
    native.queuedMessageCount = 1
    rpc.onRequest = command => command.type === 'queue' ? { data: { steering: [{ text: 'retained', entryId: 'runtime:1' }], followUp: [] } } : undefined
    const events: JsonObject[] = []
    session.onPiEvent(event => events.push(event))
    for (let read = 0; read < 3; read++) {
      const state = await session.getState()
      assert.equal(state.isSettled, false)
      assert.equal(state.pendingMessageCount, 1)
      assert.deepEqual((state.queue as JsonObject).steeringEntries, [{ text: 'retained', entryId: 'runtime:1' }])
    }
    assert.deepEqual(events.filter(event => event.type === 'queue_update'), [])
  })



  

  

  

  

  it("keeps tree navigation in the same identity and preserves cancelled history", async t => {
    const { session, entries, rpc } = await sessionFixture(t)
    entries.push({ id: "assistant", type: "message", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "assistant", content: [] } })
    await session.ensureSynced()
    const result = await session.navigateTree("assistant")
    assert.equal(result.targetSessionId, "old-session")
    assert.equal(result.editorText, "restored draft")
    rpc.onRequest = command => command.type === "navigateTree" ? { data: { cancelled: true } } : undefined
    assert.equal((await session.navigateTree("missing")).cancelled, true)
    assert.equal((await session.getBranchPage(undefined, 100, 100000)).items[0]!.id, "assistant")
  })

  for (const operation of ["navigateTree", "fork"] as const) {
    it(`preserves committed ${operation} identity and image draft when history readback fails`, async t => {
      const { session, entries, native, rpc } = await sessionFixture(t)
      t.mock.method(console, "error", () => undefined)
      entries.push({ id: "user", type: "message", parentId: null, message: { role: "user", content: "image question" } },
        { id: "answer", type: "message", parentId: "user", message: { role: "assistant", content: [] } })
      await session.ensureSynced()
      let committed = false
      rpc.onRequest = command => {
        if (command.type === operation) {
          committed = true
          native.leafId = null
          if (operation === "fork") {
            native.sessionId = "fork-target"
            native.sessionFile = path.join(process.cwd(), "fork-target.jsonl")
          }
          return { data: { ...native, cancelled: false, editorText: "image question", selectedText: "image question",
            editorImages: [image("AA==")], selectedImages: [image("AA==")] } }
        }
        if (committed && command.type === "get_entries") throw new Error("History readback unavailable")
      }
      const result = operation === "fork" ? await session.fork("user", "before") : await session.navigateTree("user")
      assert.equal(result.cancelled, false)
      assert.equal(result.targetSessionId, native.sessionId)
      assert.equal(session.getSessionId(), native.sessionId)
      assert.equal(session.getSessionFile() ?? null, native.sessionFile)
      assert.equal(session.getHead().leafId, null)
      assert.deepEqual(result[operation === "fork" ? "selectedImages" : "editorImages"], [image("AA==")])
      assert.equal(result.projectionError, "History readback unavailable")
      committed = false
      assert.deepEqual((await session.getBranchPage(undefined, 100, 100000)).items, [])
    })
  }

  it("does not publish a successful transition from a malformed native receipt", async t => {
    const { session, rpc } = await sessionFixture(t)
    rpc.onRequest = command => command.type === "fork" || command.type === "navigateTree"
      ? { data: { cancelled: false, sessionId: 42 } } : undefined
    await assert.rejects(session.fork("entry", "at"), /invalid committed identity/)
    await assert.rejects(session.navigateTree("entry"), /invalid committed identity/)
    assert.equal(session.getSessionId(), "old-session")
  })
  it('keeps the current branch and live projection on a native no-op navigation', async t => {
    const { session, entries, rpc, frame } = await sessionFixture(t)
    entries.push({ id: 'answer', type: 'message', parentId: null, message: { role: 'assistant', content: [] } })
    await session.ensureSynced()
    frame({ type: 'message_start', messageId: 'current', message: { role: 'assistant', content: [{ type: 'text', text: 'current projection' }] } })
    rpc.onRequest = command => command.type === 'navigateTree' ? { data: { cancelled: false, noOp: true } } : undefined
    const result = await session.navigateTree('answer')
    assert.equal(result.noOp, true)
    assert.equal(result.editorText, undefined)
    const branch = await session.getBranchPage(undefined, 100, 100000)
    assert.equal((branch.checkpoint?.liveMessage as JsonObject).id, 'current')
    assert.deepEqual(branch.items.map(entry => entry.id), ['answer'])
  })


  it("undoes to an empty root without replacing native runtime state and can redo", async t => {
    const { session, entries, native, frame, rpc } = await sessionFixture(t)
    entries.push({ id: "user", type: "message", parentId: null, message: { role: "user", content: "question" } },
      { id: "answer", type: "message", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } })
    await session.ensureSynced()
    frame({ type: "agent_start" })
    await session.manageGoal({ op: "set", objective: "keep goal" })
    frame({ type: "subagent_lifecycle", payload: { id: "reviewer", status: "started" } })
    frame({ type: "extension_ui_request", method: "input", id: "dialog", title: "Keep" })
    rpc.onRequest = command => {
      if (command.type === "queue") return { data: { steering: ["keep steer"], followUp: [], scopedModels: [{ model: { provider: "p", id: "m" } }] } }
      if (command.type !== "navigateTree" || command.entryId !== "user") return
      native.leafId = null
      return { data: { cancelled: false, editorText: "question", editorImages: [image("AA==")] } }
    }
    const undo = await session.navigateTree("user")
    assert.equal(undo.targetSessionId, "old-session")
    assert.deepEqual(undo.editorImages, [image("AA==")])
    assert.deepEqual((await session.getBranchPage(undefined, 100, 100000)).items, [])
    const state = await session.getState()
    assert.equal((state.goal as JsonObject).objective, "keep goal")
    assert.equal((state.subagents as JsonObject[])[0]!.id, "reviewer")
    assert.deepEqual((state.queue as JsonObject).steering, ["keep steer"])
    assert.deepEqual(state.scopedModels, [{ model: { provider: "p", id: "m" } }])
    assert.equal((state.pendingExtensionUiRequests as JsonObject[])[0]!.requestId, "dialog")
    await session.navigateTree("answer")
    assert.deepEqual((await session.getBranchPage(undefined, 100, 100000)).items.map(item => item.id), ["user", "answer"])
  })

  it("applies and removes native journal labels on existing tree nodes", async t => {
    const { session, entries, rpc } = await sessionFixture(t)
    entries.push({ id: "answer", type: "message", parentId: null, message: { role: "assistant", content: [] } })
    await session.ensureSynced()
    rpc.onRequest = command => {
      if (command.type === "setLabel") entries.push({ id: `label-${entries.length}`, type: "label", parentId: entries.at(-1)!.id, targetId: command.entryId, ...(command.label === undefined ? {} : { label: command.label }) })
    }
    await session.setLabel("answer", "bookmark")
    const labeled = await session.getTree() as JsonObject[]
    assert.equal(labeled.find(node => (node.entry as JsonObject).id === "answer")!.label, "bookmark")
    await session.setLabel("answer")
    const cleared = await session.getTree() as JsonObject[]
    assert.equal(cleared.find(node => (node.entry as JsonObject).id === "answer")!.label, undefined)
  })

  it("does not replay paused main events from an abandoned branch after navigation", async t => {
    const { session, entries, frame } = await sessionFixture(t)
    entries.push({ id: "answer", type: "message", parentId: null, message: { role: "assistant", content: [] } })
    await session.ensureSynced()
    const events: JsonObject[] = []
    session.onPiEvent(event => events.push(event))
    session.setOutputPaused(true)
    frame({ type: "message_start", messageId: "abandoned", message: { role: "assistant", content: [{ type: "text", text: "old branch" }] } })
    frame({ type: "message_update", messageId: "abandoned", message: { role: "assistant", content: [{ type: "text", text: "old branch update" }] } })
    await session.navigateTree("answer")
    session.setOutputPaused(false)
    assert.equal(events.some(event => event.messageId === "abandoned"), false)
    frame({ type: "message_start", messageId: "current", message: { role: "assistant", content: [{ type: "text", text: "new branch" }] } })
    assert.equal(events.find(event => event.type === "message_start")?.messageId, "current")
  })

  it("keeps an aborted navigation's history and propagates fork cancellation with the selected images", async t => {
    const { session, entries, rpc } = await sessionFixture(t)
    entries.push({ id: "answer", type: "message", parentId: null, message: { role: "assistant", content: [] } })
    await session.ensureSynced()
    rpc.onRequest = command => command.type === "navigateTree" ? { data: { cancelled: true, aborted: true } }
      : command.type === "fork" ? { data: { cancelled: true, selectedText: "draft", selectedImages: [image("AA==")] } } : undefined
    assert.equal((await session.navigateTree("missing", { summarize: true })).aborted, true)
    const fork = await session.fork("answer", "at")
    assert.equal(fork.cancelled, true)
    assert.equal(fork.sourceSessionId, "old-session")
    assert.equal(fork.targetSessionId, undefined)
    assert.deepEqual(fork.selectedImages, [image("AA==")])
    assert.equal(session.getSessionId(), "old-session")
    assert.deepEqual((await session.getBranchPage(undefined, 100, 100000)).items.map(item => item.id), ["answer"])
  })

  it("rejects failed commands and transitions without mutating identity", async t => {
    const { session, rpc } = await sessionFixture(t)
    rpc.onRequest = command => command.type === "prompt" || command.type === "new_session" || command.type === "fork"
      ? { success: false, error: "native rejection" } : undefined
    await assert.rejects(session.invokeCommand("missing"), /native rejection/)
    await assert.rejects(session.newSession(), /native rejection/)
    await assert.rejects(session.fork("missing", "at"), /native rejection/)
    assert.equal(session.getSessionId(), "old-session")
  })
})

describe("OmpRpcSession replacement isolation", () => {
  it("rejects old in-flight history after selecting a new session", async t => {
    const { session, rpc, entries } = await sessionFixture(t)
    const stale = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<void>()
    let held = false
    rpc.onRequest = command => {
      if (command.type !== "get_entries" || held) return
      held = true
      admitted.resolve()
      return stale.promise.then(() => ({ data: { entries: [{ id: "stale", type: "message", message: { role: "user", content: "old" } }], leafId: "stale" } }))
    }
    const oldRead = session.ensureSynced()
    await admitted.promise
    const replacing = session.newSession()
    await new Promise(resolve => setImmediate(resolve))
    entries.push({ id: "fresh", type: "message", parentId: null, timestamp: new Date(2).toISOString(), message: { role: "user", content: "new" } })
    stale.resolve()
    await Promise.all([oldRead, replacing])
    const page = await session.getBranchPage(undefined, 100, 100000)
    assert.deepEqual(page.items.map(item => item.id), ["fresh"])
    assert.equal(session.getSessionId(), "replacement-new_session")
  })

  

  

  it("rejects a user submission waiting behind Stop when the session is replaced", async t => {
    const { session, frame, rpc, commands } = await sessionFixture(t)
    frame({ type: "agent_start" })
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    rpc.onRequest = command => {
      if (command.type !== "abort") return
      admitted.resolve()
      return release.promise
    }
    const stopping = session.abort()
    await admitted.promise
    const sending = session.sendUserMessage("old-session question", [image("AA==")])
    const rejected = assert.rejects(sending, { code: "SESSION_REPLACED" })
    await session.newSession()
    frame({ type: "agent_start" })
    release.resolve()
    await Promise.all([stopping, rejected])
    assert.equal((await session.getState()).sessionId, "replacement-new_session")
    assert.equal(commands.some(command => command.message === "old-session question"), false)
  })

  it("migrates native workspace identity even though get_state omits cwd", async t => {
    const { session, rpc, native } = await sessionFixture(t)
    const workspace = path.resolve(tmpdir(), "ompiui-replacement-workspace")
    rpc.onRequest = command => {
      if (command.type === "get_state") {
        const state = structuredClone(native)
        delete state.cwd
        return { data: state }
      }
      if (command.type === "new_session") native.cwd = workspace
    }
    const replaced = await session.newSession()
    assert.equal(replaced.targetCwd, workspace)
    assert.equal(session.getCwd(), workspace)
    assert.equal((await session.getState()).cwd, workspace)
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
      frame({ type: "extension_ui_request", method: "setStatus", statusKey: "old", statusText: "Old state" })
      events.length = 0

      let emitted = false
      rpc.onRequest = command => {
        if (command.type !== "get_entries" || emitted) return
        emitted = true
        frame({ type: "extension_ui_request", method: "select", id: "new-dialog", title: "New", options: ["yes"] })
        frame({ type: "extension_ui_request", method: "notify", message: "New notification" })
        frame({ type: "extension_ui_request", method: "setStatus", statusKey: "new", statusText: "New state" })
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
      assert.deepEqual(responses, [], "Replacement must not send a stale reply into the new native session")
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
  it("sends goal images on the first turn and keeps subsequent continuations compact", async t => {
    const { session, frame, commands, native } = await sessionFixture(t)
    native.isStreaming = false
    await session.getState()
    await session.manageGoal({ op: "set", objective: '按 "截图" 修复\n布局', images: [image("AA==")] })
    await new Promise(resolve => setImmediate(resolve))
    const first = commands.find(command => command.type === "prompt")!
    assert.equal(parseGoalMessage(String(first.message))?.kind, "set")
    assert.deepEqual(first.images, [image("AA==")])
    assert.deepEqual(((await session.getState()).goal as JsonObject).images, [image("AA==")])
    frame({ type: "agent_start" })
    native.isStreaming = false
    frame({ type: "session_settled" })
    await new Promise(resolve => setTimeout(resolve, 1100))
    const prompts = commands.filter(command => command.type === "prompt")
    assert.equal(prompts.length, 2)
    assert.equal(parseGoalMessage(String(prompts[1]!.message))?.kind, "continuation")
    assert.equal(prompts[1]!.images, undefined)
    await session.manageGoal({ op: "drop" })
    await session.manageGoal({ op: "set", objective: "新目标" })
    await new Promise(resolve => setImmediate(resolve))
    const last = commands.filter(command => command.type === "prompt").at(-1)!
    assert.equal(parseGoalMessage(String(last.message))?.objective, "新目标")
    assert.equal(last.images, undefined)
  })

  it("preserves pending goal images across pause before the first submission", async t => {
    const { session, commands, native } = await sessionFixture(t)
    native.isStreaming = false
    await session.getState()
    await Promise.all([
      session.manageGoal({ op: "set", objective: "图片目标", images: [image("AA==")] }),
      session.manageGoal({ op: "pause" }),
    ])
    assert.equal(commands.filter(command => command.type === "prompt").length, 0)
    await session.manageGoal({ op: "resume" })
    await new Promise(resolve => setImmediate(resolve))
    const first = commands.find(command => command.type === "prompt")!
    assert.deepEqual(first.images, [image("AA==")])
    assert.equal(parseGoalMessage(String(first.message))?.kind, "set")
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
    t.mock.timers.enable({ apis: ["setTimeout"] })
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
    t.mock.timers.tick(1000)
    assert.deepEqual(commands.filter(command => command.type === "prompt"), [])
    assert.equal(((await session.getState()).goal as JsonObject).status, "complete")
  })

  it("ignores a completion marker on an inactive sibling branch", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const { session, frame, native, entries, commands } = await sessionFixture(t)
    entries.push({ id: "question", type: "message", parentId: null, message: { role: "user", content: "request" } },
      { id: "active", type: "message", parentId: "question", message: { role: "assistant", content: [{ type: "text", text: "work remains" }] } },
      { id: "sibling", type: "message", parentId: "question", message: { role: "assistant", content: [{ type: "text", text: "GOAL_COMPLETE" }] } })
    native.leafId = "active"
    frame({ type: "agent_start" })
    await session.manageGoal({ op: "set", objective: "Finish active branch" })
    native.isStreaming = false
    frame({ type: "session_settled" })
    await session.ensureSynced()
    t.mock.timers.tick(1000)
    const submitted = Promise.withResolvers<void>()
    queueMicrotask(submitted.resolve)
    await submitted.promise
    assert.equal(((await session.getState()).goal as JsonObject).status, "active")
    assert.equal(parseGoalMessage(String(commands.find(command => command.type === "prompt")?.message))?.objective, "Finish active branch")
  })
})

