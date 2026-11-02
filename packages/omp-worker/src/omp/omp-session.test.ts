import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it, type TestContext } from "node:test"
import type { ImageInput, JsonObject } from "@ompiui/protocol"
import { OmpExtensionUiBridge } from "./omp-extension-ui.js"
import { OmpRpcSession } from "./omp-session.js"
import type { OmpRpcFrame } from "./rpc-client.js"
import { SUBAGENT_OBSERVATION_PREFIX } from "./native-subagent-observation.js"
import { SESSION_TITLE_FAILURE_PREFIX, SESSION_TITLE_PREFIX } from "./native-session-title.js"


// Exercise consumer-visible session projection and transitions with a controlled
// native transport. Installed RPC smoke is run separately by the main agent.
async function sessionFixture(t: TestContext) {
  const session = Reflect.construct(OmpRpcSession, []) as OmpRpcSession
  const internal = session as unknown as {
    client: unknown
    ompVersion: string | null
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
        native.goal = null;
      }
      if (command.type === "goal") return { type: "response", success: true, command: "goal", data: { state: native.goal ?? null } };
      const data = command.type === "get_state" ? structuredClone(native)
        : command.type === "get_entries" ? { entries: structuredClone(entries), leafId: native.leafId === undefined ? entries.at(-1)?.id ?? null : native.leafId }
          : command.type === "get_available_commands" ? { commands: [] }
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
  internal.ompVersion = '18.12.6'
  await internal.refreshIdentity()
  internal.extensionUi.bind(session.getSessionId(), response => rpc.writeExtensionUiResponse(response))
  t.after(() => session.dispose())
  return {
    session, commands, responses, native, rpc, entries,
    frame: (frame: OmpRpcFrame) => {
      if (frame.type === "goal_updated") native.goal = frame.state ?? (frame.goal ? { enabled: (frame.goal as JsonObject).status === "active", mode: "active", goal: frame.goal } : null);
      internal.handleFrame(frame)
    },
  }
}

const image = (data: string): ImageInput => ({ type: "image", data, mimeType: "image/png" })

describe("OmpRpcSession native titles", () => {
  it("consumes title observer notifications without displaying private control traffic", async t => {
    const { session, frame } = await sessionFixture(t)
    const events: JsonObject[] = []
    session.onPiEvent(event => events.push(event))
    frame({ type: "extension_ui_request", method: "notify", message: SESSION_TITLE_PREFIX + JSON.stringify({ type: "session_info_update", sessionId: session.getSessionId(), title: "原生自动标题" }) })
    assert.equal(session.getHead().header?.name, "原生自动标题")
    frame({ type: "extension_ui_request", method: "notify", message: SESSION_TITLE_PREFIX + JSON.stringify({ type: "session_info_update", sessionId: "other-session", title: "其他标题" }) })
    frame({ type: "extension_ui_request", method: "notify", message: SESSION_TITLE_PREFIX + "not json" })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(events, [{ type: "session_info_update", sessionId: session.getSessionId(), title: "原生自动标题" }])
  })
  it("raises structured title failures to diagnostics listeners without echoing them as notifications", async t => {
    const { session, frame } = await sessionFixture(t)
    const failures: JsonObject[] = []
    session.onTitleFailed(failure => failures.push(failure as unknown as JsonObject))
    frame({ type: "extension_ui_request", method: "notify", message: SESSION_TITLE_FAILURE_PREFIX + JSON.stringify({ stage: "apply" }) })
    frame({ type: "extension_ui_request", method: "notify", message: SESSION_TITLE_FAILURE_PREFIX + "not json" })
    frame({ type: "extension_ui_request", method: "notify", message: SESSION_TITLE_FAILURE_PREFIX + JSON.stringify({ stage: "somewhere-else" }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(failures, [{ stage: "apply" }])
  })
  it("does not let a pre-title state read erase a newer native name", async t => {
    const { session, frame, native, rpc } = await sessionFixture(t)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first = true
    rpc.onRequest = command => {
      if (command.type !== "get_state" || !first) return
      first = false
      const stale = structuredClone(native)
      started.resolve()
      return release.promise.then(() => ({ data: stale }))
    }
    const reading = session.getState()
    await started.promise
    native.sessionName = "更新后的原生标题"
    frame({ type: "session_info_update", title: native.sessionName })
    release.resolve()
    assert.equal((await reading).sessionName, "更新后的原生标题")
  })

  it("updates cached metadata before forwarding a native title and preserves it on state refresh", async t => {
    const { session, native, frame } = await sessionFixture(t)
    const events: JsonObject[] = []
    session.onPiEvent(event => {
      if (event.type === "session_info_update") {
        if (typeof event.title === "string") assert.equal(session.getHead().header?.name, event.title)
        events.push(event)
      }
    })
    for (const title of ["修复会话自动命名", "更新后的自动标题"]) {
      native.sessionName = title
      const update = { type: "session_info_update", sessionId: session.getSessionId(), title }
      frame(update)
      assert.equal(session.getHead().header?.name, title)
      assert.equal((await session.getState()).sessionName, title)
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.deepEqual(events.at(-1), update)
    }
    frame({ type: "session_info_update", sessionId: "other-session", title: "其他会话标题" })
    assert.equal(session.getHead().header?.name, "更新后的自动标题")
    frame({ type: "session_info_update", title: 42 })
    frame({ type: "session_info_update" })
    assert.equal(session.getHead().header?.name, "更新后的自动标题")
  })
})

describe("OmpRpcSession extension diagnostics", () => {
  it("keeps delayed extension errors outside session streams across new, switch and fork", async t => {
    const { session, frame } = await sessionFixture(t)
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-diagnostics-"))
    const previous = process.env.OMPIUI_DATA_DIR
    process.env.OMPIUI_DATA_DIR = root
    mkdirSync(path.join(root, "sessions"))
    const targetPath = path.join(root, "sessions", "target.jsonl")
    writeFileSync(targetPath, "")
    t.after(() => {
      if (previous === undefined) delete process.env.OMPIUI_DATA_DIR
      else process.env.OMPIUI_DATA_DIR = previous
      rmSync(root, { recursive: true, force: true })
    })
    const events: JsonObject[] = []
    const diagnostics: JsonObject[] = []
    session.onPiEvent(event => events.push(event))
    const unsubscribe = session.onExtensionDiagnostic(event => diagnostics.push(event))
    for (const replace of [() => session.newSession(), () => session.switchSession(targetPath), () => session.fork("entry", "before")]) {
      await replace()
      const error = { type: "extension_error", extensionPath: "<timer>", event: "timeout_callback", error: "old callback\noriginal details" }
      frame(error)
      assert.deepEqual(diagnostics.at(-1), error)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(events.some(event => event.type === "extension_error"), false)
    assert.equal(diagnostics.length, 3)
    unsubscribe()
    frame({ type: "extension_error", extensionPath: "<timer>", event: "timeout_callback", error: "unsubscribed" })
    assert.equal(diagnostics.length, 3)
  })

  it("retains command-handler errors as host diagnostics while native prompt rejection still preserves the draft", async t => {
    const { session, rpc, frame } = await sessionFixture(t)
    const diagnostics: JsonObject[] = []
    const events: JsonObject[] = []
    session.onExtensionDiagnostic(event => diagnostics.push(event))
    session.onPiEvent(event => events.push(event))
    rpc.onRequest = command => {
      if (command.type !== "prompt") return
      const error = { type: "extension_error", event: "command", extensionPath: "command:review", error: "Permission denied" }
      frame(error)
      rpc.emit("frame", error)
      rpc.emit("frame", { type: "prompt_result", id: command.id, status: "completed", agentInvoked: false })
      return { data: { agentInvoked: false } }
    }
    await assert.rejects(session.sendUserMessage("/review draft"), /Permission denied/)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(events.some(event => event.type === "extension_error"), false)
    assert.equal(diagnostics[0]?.error, "Permission denied")
  })
})

describe("OmpRpcSession worktree relocation admission", () => {
  it("rejects every immediate submission throughout move and leaves explicit Stop available", async t => {
    const { session, rpc, commands, native } = await sessionFixture(t)
    native.isStreaming = false
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    rpc.onRequest = async command => {
      if (command.type === "worktreeState") return { data: { ...native, sessionFileReady: false } }
      if (command.type === "moveSession") {
        entered.resolve()
        await release.promise
        native.cwd = path.join(process.cwd(), "target-worktree")
        return { data: { ...native, cancelled: false } }
      }
    }
    const move = session.moveSession("target-worktree")
    await entered.promise
    const before = commands.length
    for (const submit of [
      () => session.sendUserMessage("draft"),
      () => session.sendUserMessage("/extension-command"),
      () => session.prompt("draft"),
      () => session.steer("draft"),
      () => session.followUp("draft"),
      () => session.sendQueuedMessage("steering", 0, "queued-id"),
      () => session.abortAndPrompt("draft"),
      () => session.moveSession("another-worktree"),
    ]) await assert.rejects(submit(), { code: "SESSION_BUSY" })
    assert.equal(commands.length, before)
    await session.abort()
    assert.equal(commands.some(command => command.type === "abort"), true)
    release.resolve()
    const receipt = await move
    assert.equal(receipt.targetSessionId, "old-session")
    assert.equal(receipt.targetCwd, native.cwd)
    await session.sendUserMessage("after relocation")
    assert.equal(commands.some(command => command.type === "submitUserMessage" && command.text === "after relocation"), true)
  })

  it("rejects relocation while a preexisting submission is awaiting native admission", async t => {
    const { session, rpc, commands, native } = await sessionFixture(t)
    native.isStreaming = false
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    rpc.onRequest = async command => {
      if (command.type !== "submitUserMessage") return
      entered.resolve()
      await release.promise
      return { data: { accepted: true } }
    }
    const submission = session.sendUserMessage("source turn")
    await entered.promise
    await assert.rejects(session.moveSession("target-worktree"), { code: "SESSION_BUSY" })
    assert.equal(commands.some(command => command.type === "worktreeState" || command.type === "moveSession"), false)
    release.resolve()
    await submission
  })

  it("rejects completed async work awaiting delivery even with no streaming turn", async t => {
    const { session, native, commands } = await sessionFixture(t)
    native.isStreaming = false
    native.isSettled = false
    native.hasPendingAsyncWork = true
    await session.getState()
    await assert.rejects(session.moveSession("target-worktree"), { code: "SESSION_BUSY" })
    assert.equal(commands.some(command => command.type === "worktreeState" || command.type === "moveSession"), false)
    assert.equal(session.getSessionId(), "old-session")
    assert.equal(session.getCwd(), process.cwd())
  })

  it("reopens admission after a failed move without changing identity", async t => {
    const { session, rpc, native } = await sessionFixture(t)
    native.isStreaming = false
    rpc.onRequest = command => command.type === "worktreeState" ? { data: { ...native, sessionFileReady: false } }
      : command.type === "moveSession" ? { success: false, error: "native relocation failed" } : undefined
    await assert.rejects(session.moveSession("target-worktree"), /native relocation failed/)
    assert.equal(session.getSessionId(), "old-session")
    await session.sendUserMessage("source retry")
  })
})

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

  it('projects a yielded async parent without treating its ACK as settled', async t => {
    const { session, frame, native } = await sessionFixture(t)
    const activity: unknown[] = []
    session.onActivity(value => activity.push(value))
    frame({ type: 'agent_start' })
    native.isStreaming = false
    native.isSettled = false
    native.hasPendingAsyncWork = true
    frame({ type: 'agent_end', isTerminal: false, yielded: true, awaitingAsyncWork: true })
    // Inspect the synchronous shadow before the asynchronous native readback.
    const shadow = session as unknown as { currentStreaming: boolean }
    assert.equal(shadow.currentStreaming, false)
    const pending = await session.getState()
    assert.equal(pending.hasPendingAsyncWork, true)
    assert.equal(pending.isIdle, false)
    assert.deepEqual(activity.at(-1), { type: 'busy' })
    native.hasPendingAsyncWork = false
    native.isSettled = true
    frame({ type: 'session_settled' })
    assert.equal(activity.at(-1), null)
  })

  it('reports no executing activity when Stop retains only queued messages', async t => {
    const { session, frame, native, rpc } = await sessionFixture(t)
    const activity: unknown[] = []
    const events: JsonObject[] = []
    session.onActivity(value => activity.push(value))
    session.onPiEvent(value => events.push(value))
    rpc.onRequest = command => command.type === 'queue'
      ? { data: { steering: [], followUp: [{ text: 'retained follow-up', entryId: 'queued:1' }] } } : undefined
    frame({ type: 'agent_start' })
    native.isStreaming = false
    native.isSettled = false
    native.hasPendingAsyncWork = false
    native.queuedMessageCount = 1
    frame({ type: 'agent_end' })
    await session.abort()
    const stopped = await session.getState()
    assert.equal(activity.at(-1), null)
    assert.equal(stopped.isSettled, false)
    assert.equal(stopped.isIdle, false)
    assert.equal(stopped.pendingMessageCount, 1)
    assert.deepEqual((stopped.queue as JsonObject).followUpEntries, [{ text: 'retained follow-up', entryId: 'queued:1' }])
    assert.equal(events.some(event => event.type === 'agent_settled'), false)
    native.hasPendingAsyncWork = true
    await session.getState()
    assert.deepEqual(activity.at(-1), { type: 'busy' })
    native.hasPendingAsyncWork = false
    await session.getState()
    assert.equal(activity.at(-1), null)
    native.isStreaming = true
    frame({ type: 'agent_start' })
    assert.deepEqual(activity.at(-1), { type: 'busy' })
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



  it("reopens a stable subagent ID without accepting retired task progress", async t => {
    const { session, frame } = await sessionFixture(t)
    frame({ type: "subagent_lifecycle", payload: { id: "reviewer", parentToolCallId: "first", status: "started" } })
    const first = ((await session.getState()).subagents as JsonObject[])[0]!.runId
    frame({ type: "subagent_progress", payload: { id: "reviewer", parentToolCallId: "first", progress: { status: "completed", tokens: 7 } } })
    frame({ type: "subagent_lifecycle", payload: { id: "reviewer", parentToolCallId: "second", status: "started" } })
    frame({ type: "subagent_progress", payload: { id: "reviewer", parentToolCallId: "first", progress: { status: "failed", tokens: 999 } } })
    const restarted = ((await session.getState()).subagents as JsonObject[])[0]!
    assert.notEqual(restarted.runId, first)
    assert.equal(restarted.status, "running")
    assert.equal(restarted.parentToolCallId, "second")
    assert.equal(restarted.progress, undefined)
  })

  it("starts a fresh autonomous run with the same task owner and rejects retired terminal replay", async t => {
    const { session, frame } = await sessionFixture(t)
    const started = { id: "reviewer", parentToolCallId: "task", sessionFile: "reviewer.jsonl", status: "started" }
    frame({ type: "subagent_lifecycle", payload: started })
    const first = ((await session.getState()).subagents as JsonObject[])[0]!.runId
    frame({ type: "subagent_progress", payload: { id: "reviewer", parentToolCallId: "task", progress: { status: "completed", tokens: 7 } } })
    frame({ type: "subagent_lifecycle", payload: started })
    const revived = ((await session.getState()).subagents as JsonObject[])[0]!
    assert.notEqual(revived.runId, first)
    assert.equal(revived.status, "running")
    assert.equal(revived.progress, undefined)
    frame({ type: "subagent_lifecycle", payload: { id: "reviewer", parentToolCallId: "task", runId: first, status: "failed" } })
    frame({ type: "subagent_progress", payload: { id: "reviewer", parentToolCallId: "task", runId: first, progress: { status: "aborted", tokens: 999 } } })
    const current = ((await session.getState()).subagents as JsonObject[])[0]!
    assert.equal(current.runId, revived.runId)
    assert.equal(current.status, "running")
    assert.equal(current.progress, undefined)
  })

  it("does not let an in-flight registry snapshot terminate a later run", async t => {
    const { session, frame, rpc } = await sessionFixture(t)
    frame({ type: "subagent_lifecycle", payload: { id: "reviewer", parentToolCallId: "task", status: "started" } })
    frame({ type: "subagent_lifecycle", payload: { id: "reviewer", parentToolCallId: "task", status: "completed" } })
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    rpc.onRequest = command => {
      if (command.type !== "get_subagents") return
      admitted.resolve()
      return release.promise.then(() => ({ data: { subagents: [{ id: "reviewer", parentToolCallId: "task", status: "completed" }] } }))
    }
    const reading = session.listSubagents()
    await admitted.promise
    frame({ type: "subagent_lifecycle", payload: { id: "reviewer", parentToolCallId: "task", status: "started" } })
    release.resolve()
    const snapshot = await reading as JsonObject[]
    assert.equal(snapshot[0]!.status, "running")
    assert.equal(((await session.getState()).subagents as JsonObject[])[0]!.runId, snapshot[0]!.runId)
  })

  it("keeps a same-owner running restart alive through identity-less old terminals and read-only refresh", async t => {
    const { session, frame, native, commands } = await sessionFixture(t)
    const emitted: JsonObject[] = []
    session.onSubagentFrame(event => emitted.push(event))
    const started = { id: "reviewer", parentToolCallId: "task", sessionFile: "reviewer.jsonl", status: "started" }
    let observationSequence = 0
    const observe = (version: number, activity: string, pendingAsync = false, observationId = "attachment") => frame({
      type: "extension_ui_request", method: "notify", message: SUBAGENT_OBSERVATION_PREFIX + JSON.stringify({
        protocolVersion: 1, rootSessionId: native.sessionId, rootSessionFile: native.sessionFile,
        id: "reviewer", sessionFile: "reviewer.jsonl", observationEpoch: "observer", observationId,
        observationSequence: ++observationSequence, activityVersion: version, activity, pendingAsync,
      }),
    })
    frame({ type: "subagent_lifecycle", payload: started })
    const first = ((await session.getState()).subagents as JsonObject[])[0]!.runId
    observe(1, "idle", true)
    observe(2, "running")
    assert.equal(((await session.getState()).subagents as JsonObject[])[0]!.runId, first, "activity is not a monitor boundary")
    frame({ type: "subagent_lifecycle", payload: started })
    const current = ((await session.getState()).subagents as JsonObject[])[0]!
    assert.notEqual(current.runId, first)
    frame({ type: "subagent_progress", payload: { ...started, progress: { status: "completed", tokens: 999 } } })
    frame({ type: "subagent_lifecycle", payload: { ...started, status: "completed" } })
    assert.equal(((await session.getState()).subagents as JsonObject[])[0]!.status, "running")
    assert.equal(emitted.filter(event => event.kind === "unassigned").length, 2)
    assert.equal(((await session.getState()).subagents as JsonObject[])[0]!.progress, undefined)
    observe(3, "idle")
    const idle = ((await session.getState()).subagents as JsonObject[])[0]!
    assert.equal(idle.status, "unknown")
    assert.equal(idle.runId, current.runId)
    observe(2, "running")
    assert.equal(((await session.getState()).subagents as JsonObject[])[0]!.status, "unknown", "old observation version rejected")
    observe(1, "running", false, "replacement")
    observe(99, "idle")
    assert.equal(((await session.getState()).subagents as JsonObject[])[0]!.status, "running", "retired attachment rejected")
    assert.ok(commands.every(command => command.type !== "prompt" && command.type !== "submitUserMessage"))
  })

  it("rejects a previously unseen older observer epoch without retiring the current task projection", async t => {
    const { session, frame, native, commands } = await sessionFixture(t)
    const emitted: JsonObject[] = []
    session.onSubagentFrame(event => emitted.push(event))
    const observe = (epoch: string, sequence: number, version: number, activity: string, pendingAsync = false) => frame({
      type: "extension_ui_request", method: "notify", message: SUBAGENT_OBSERVATION_PREFIX + JSON.stringify({
        protocolVersion: 1, rootSessionId: native.sessionId, rootSessionFile: native.sessionFile,
        id: "reviewer", sessionFile: "reviewer.jsonl", observationEpoch: epoch, observationId: `${epoch}-attachment`,
        observationSequence: sequence, activityVersion: version, activity, pendingAsync,
      }),
    })
    observe("epoch-B", 20, 1, "running")
    const current = ((await session.getState()).subagents as JsonObject[])[0]!
    const projectionRunId = current.runId
    assert.equal(current.nativeStarted, undefined)
    observe("epoch-A", 19, 99, "idle")
    const afterLate = ((await session.getState()).subagents as JsonObject[])[0]!
    assert.equal(afterLate.runId, projectionRunId)
    assert.equal(afterLate.observationEpoch, "epoch-B")
    assert.equal(afterLate.observationSequence, 20)
    assert.equal(afterLate.status, "running")
    assert.equal(emitted.filter(event => event.kind === "observation").length, 1)
    observe("epoch-B", 21, 2, "idle", true)
    const idle = ((await session.getState()).subagents as JsonObject[])[0]!
    assert.equal(idle.runId, projectionRunId)
    assert.equal(idle.status, "pending", "late unseen A must not retire B")
    observe("epoch-B", 22, 3, "running")
    const resumed = ((await session.getState()).subagents as JsonObject[])[0]!
    assert.equal(resumed.runId, projectionRunId)
    assert.equal(resumed.status, "running")
    assert.equal(resumed.observationSequence, 22)
    assert.ok(commands.every(command => String(command.type).startsWith("get_") || ["identity", "queue", "resources"].includes(String(command.type))),
      `unexpected non-read-only commands: ${JSON.stringify(commands.map(command => command.type))}`)
  })

  it("keeps an observation-only active child running through identityless terminal frames and registry reads", async t => {
    const { session, frame, native, rpc, commands } = await sessionFixture(t)
    const emitted: JsonObject[] = []
    session.onSubagentFrame(event => emitted.push(event))
    const observation = {
      protocolVersion: 1, rootSessionId: native.sessionId, rootSessionFile: native.sessionFile,
      id: "reviewer", sessionFile: "reviewer.jsonl", observationEpoch: "observer", observationId: "attachment",
      observationSequence: 1, activityVersion: 1, activity: "running", pendingAsync: false,
    }
    frame({ type: "extension_ui_request", method: "notify", message: SUBAGENT_OBSERVATION_PREFIX + JSON.stringify(observation) })
    const first = ((await session.getState()).subagents as JsonObject[])[0]!
    const runId = first.runId
    assert.equal(first.nativeStarted, undefined)
    assert.equal(first.identityAmbiguous, undefined)
    frame({ type: "subagent_event", payload: { id: "reviewer", event: { type: "tool_execution_start", toolCallId: "live-read", toolName: "read" } } })
    for (const terminal of ["completed", "failed", "aborted"]) {
      for (const type of ["subagent_lifecycle", "subagent_progress"]) {
        frame({ type, payload: { id: "reviewer", sessionFile: "reviewer.jsonl",
          ...(type === "subagent_progress" ? { progress: { status: terminal } } : { status: terminal }) } })
        const current = ((await session.getState()).subagents as JsonObject[])[0]!
        assert.equal(current.runId, runId)
        assert.equal(current.status, "running", `${type} ${terminal} cannot terminate independently observed activity`)
        assert.equal(current.activity, "running")
        assert.equal(current.nativeStarted, undefined)
        assert.equal(current.startToken, undefined)
        assert.equal(current.endedAt, undefined)
      }
    }
    rpc.onRequest = command => command.type === "get_subagents"
      ? { data: { subagents: [{ id: "reviewer", sessionFile: "reviewer.jsonl", status: "completed" }] } } : undefined
    const snapshot = await session.listSubagents() as JsonObject[]
    assert.equal(snapshot[0]!.runId, runId)
    assert.equal(snapshot[0]!.status, "running")
    // Progress snapshots are coalesced; a boundary flushes the final pending progress.
    frame({ type: "subagent_event", payload: { id: "reviewer", event: { type: "tool_execution_start", toolCallId: "next-read", toolName: "read" } } })
    const terminalEvents = emitted.filter(event => event.kind === "lifecycle" || event.kind === "progress")
    assert.equal(terminalEvents.length, 6)
    for (const event of terminalEvents) {
      const payload = event.payload as JsonObject
      assert.equal(payload.runId, runId)
      assert.equal(payload.activity, "running", "consumer must receive the independent active observation")
      assert.equal(payload.observationSequence, 1)
    }
    assert.ok(commands.every(command => String(command.type).startsWith("get_") || ["identity", "queue", "resources"].includes(String(command.type))),
      `unexpected non-read-only commands: ${JSON.stringify(commands.map(command => command.type))}`)
  })

  it("keeps goal and subagents on cancelled replacement and clears both after success", async t => {
    const { session, frame, rpc } = await sessionFixture(t)
    await session.manageGoal({ op: "create", objective: "old goal" })
    await session.manageGoal({ op: "pause" })
    frame({ type: "goal_updated", goal: { id: "goal-old", objective: "old goal", status: "paused", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } })
    frame({ type: "subagent_lifecycle", payload: { id: "old-agent", status: "started" } })
    rpc.onRequest = command => command.type === "new_session" ? { data: { cancelled: true } } : undefined
    assert.equal((await session.newSession()).cancelled, true)
    const cancelled = await session.getState()
    assert.equal(cancelled.sessionId, "old-session")
    assert.equal((cancelled.goal as JsonObject).objective, "old goal")
    assert.equal((cancelled.subagents as JsonObject[])[0]!.id, "old-agent")
    rpc.onRequest = () => undefined
    await session.newSession()
    const fresh = await session.getState()
    assert.equal(fresh.goal, null)
    assert.deepEqual(fresh.subagents, [])
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

  it('refuses inclusive fork on older native versions without issuing a whole-session fork', async t => {
    const { session, commands } = await sessionFixture(t)
    // The fixture owns this otherwise-private native version field.
    const internal = session as unknown as { ompVersion: string }
    internal.ompVersion = '18.3.1'
    await assert.rejects(session.fork('assistant', 'at'), { code: 'CAPABILITY_DISABLED' })
    assert.equal(commands.some(command => command.type === 'fork'), false)
    assert.equal(session.getSessionId(), 'old-session')
  })

  it('rejects a fork receipt that retains the source identity', async t => {
    const { session, rpc } = await sessionFixture(t)
    rpc.onRequest = command => command.type === 'fork' ? { data: { cancelled: false, sessionFile: 'source.jsonl', leafId: null } } : undefined
    await assert.rejects(session.fork('user', 'before'), /invalid committed identity/)
    assert.equal(session.getSessionId(), 'old-session')
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
    await session.manageGoal({ op: "create", objective: "keep goal" })
    frame({ type: "goal_updated", goal: { id: "goal-keep", objective: "keep goal", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } })
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

  it("discovers a changed model's supported efforts without retaining legacy choices", async t => {
    const { session, native, rpc } = await sessionFixture(t)
    native.model = { provider: "custom", id: "effort-model", reasoning: true }
    rpc.onRequest = command => command.type === "get_available_thinking_levels"
      ? { data: { levels: ["off", "high", "extreme"] } } : undefined
    assert.deepEqual((await session.getState()).supportedThinkingLevels, ["off", "high", "extreme"])
    rpc.onRequest = command => command.type === "get_available_thinking_levels"
      ? { data: { levels: ["off"] } } : undefined
    native.model = { provider: "custom", id: "no-effort", reasoning: false }
    assert.deepEqual((await session.getState()).supportedThinkingLevels, ["off"])
    assert.equal((await session.getState()).supportsThinking, false)
  })

  it("does not restore an older model's thinking candidates after a newer selection", async t => {
    const { session, native, rpc } = await sessionFixture(t)
    native.model = { provider: "custom", id: "old", reasoning: true }
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let reads = 0
    rpc.onRequest = command => {
      if (command.type === "set_model") native.model = { provider: "custom", id: "new", reasoning: false }
      if (command.type !== "get_available_thinking_levels") return
      if (reads++ === 0) {
        admitted.resolve()
        return release.promise.then(() => ({ data: { levels: ["off", "high", "extreme"] } }))
      }
      return { data: { levels: ["off"] } }
    }
    const oldState = session.getState()
    await admitted.promise
    await session.setModel("custom", "new")
    release.resolve()
    const refreshed = await oldState
    assert.equal((refreshed.model as JsonObject).id, "new")
    assert.deepEqual(refreshed.availableThinkingLevels, ["off"])
    const current = await session.getState()
    assert.deepEqual(current.availableThinkingLevels, ["off"])
    assert.equal(current.supportsThinking, false)
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

describe("OmpRpcSession official goal lifecycle (#354)", () => {
  const officialGoal = (overrides: JsonObject = {}): JsonObject => ({
    id: "goal-1", objective: "Finish the task", status: "active",
    tokensUsed: 42, tokenBudget: 100, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2, ...overrides,
  })
  it("projects native get_state goal mode and actual usage instead of cached events", async t => {
    const { session, native, frame } = await sessionFixture(t)
    frame({ type: "goal_updated", goal: officialGoal({ objective: "stale event" }) })
    native.goal = { enabled: false, mode: "exiting", reason: "completed", goal: officialGoal({ status: "complete" }) }
    const state = await session.getState()
    assert.deepEqual(state.goalState, native.goal)
    assert.deepEqual(state.goal, (native.goal as JsonObject).goal)
  })
  it("rejects invalid goal inputs before native mutation", async t => {
    const { session, commands } = await sessionFixture(t)
    const withImages = { op: "create", objective: "Image goal", images: [image("AA==")] } as Parameters<typeof session.manageGoal>[0]
    await assert.rejects(session.manageGoal(withImages), { code: "INVALID_REQUEST" })
    await assert.rejects(session.manageGoal({ op: "budget", tokenBudget: 0 }), { code: "INVALID_REQUEST" })
    await assert.rejects(session.manageGoal({ op: "budget" }), { code: "INVALID_REQUEST" })
    assert.equal(commands.filter(command => command.type === "goal").length, 0)
  })
  it("does not restore private goal state or submit a goal prompt on replacement", async t => {
    const { session, commands } = await sessionFixture(t)
    await session.newSession()
    assert.equal(commands.some(command => command.type === "goal"), false)
    assert.equal(commands.some(command => command.type === "prompt"), false)
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

describe("OmpRpcSession identity epochs (#361)", () => {
  it("expires a source state read instead of returning target resources", async t => {
    const { session, rpc, native } = await sessionFixture(t)
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let delayed = false
    rpc.onRequest = command => {
      if (command.type !== "get_state" || delayed) return
      delayed = true
      const source = structuredClone(native)
      admitted.resolve()
      return release.promise.then(() => ({ data: source }))
    }
    const reading = session.getState()
    const expired = assert.rejects(reading, error => error instanceof Error && "code" in error && error.code === "SESSION_REPLACED")
    await admitted.promise
    await session.newSession()
    release.resolve()
    await expired
    assert.equal((await session.getState()).sessionId, "replacement-new_session")
  })



  it("clears paused subagent buffers without emitting source frames to target", async t => {
    const { session, frame } = await sessionFixture(t)
    const events: JsonObject[] = []
    session.onSubagentFrame(event => events.push(event))
    session.setOutputPaused(true)
    frame({ type: "subagent_lifecycle", payload: { id: "source-agent", status: "started" } })
    frame({ type: "subagent_progress", payload: { id: "source-agent", progress: { id: "source-agent", status: "running" } } })
    await session.newSession()
    session.setOutputPaused(false)
    assert.deepEqual(events, [])
    assert.deepEqual((await session.getState()).subagents, [])
  })

  it("returns the committed target when a subsequent state projection fails", async t => {
    const { session, rpc, frame } = await sessionFixture(t)
    frame({ type: "goal_updated", goal: { id: "source-goal", objective: "source" } })
    rpc.onRequest = command => command.type === "get_state"
      ? { success: false, error: "projection read failed" } : undefined
    const result = await session.newSession()
    assert.equal(result.cancelled, false)
    assert.equal(result.targetSessionId, "replacement-new_session")
    assert.match(String(result.projectionError), /projection read failed/)
    assert.equal(session.getSessionId(), "replacement-new_session")
    rpc.onRequest = () => undefined
    assert.equal((await session.getState()).goal, null)
  })

  it("does not wait on an old abort response before submitting to target", { timeout: 5000 }, async t => {
    const { session, rpc, commands } = await sessionFixture(t)
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    rpc.onRequest = command => {
      if (command.type !== "abort") return
      admitted.resolve()
      return release.promise.then(() => ({ data: {} }))
    }
    const oldAbort = session.abort()
    await admitted.promise
    await session.newSession()
    try {
      await session.sendUserMessage("target message")
      assert.ok(commands.some(command => command.type === "submitUserMessage" && command.text === "target message"))
    } finally {
      release.resolve()
      await oldAbort
    }
  })
})
