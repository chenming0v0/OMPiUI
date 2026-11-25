import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { runInNewContext } from "node:vm"
import { test } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import type { OmpRpcClient, OmpRpcResponse } from "./rpc-client.js"
import { runtimeBridgeExtension, RuntimeBridgeTransport } from "./runtime-bridge.js"
import { SUBAGENT_OBSERVATION_PREFIX, type SubagentObservationPayload } from "./native-subagent-observation.js"

test("child observation receipts stay separate from managed command transport", () => {
  const transport = new RuntimeBridgeTransport()
  const payload: SubagentObservationPayload = {
    protocolVersion: 1, rootSessionId: "root", rootSessionFile: "root.jsonl",
    id: "child", sessionFile: "child.jsonl", observationEpoch: "epoch",
    observationId: "attachment", activityVersion: 1, observationSequence: 1, activity: "idle", pendingAsync: true,
  }
  assert.equal(transport.handleFrame({
    type: "extension_ui_request", method: "notify", level: "info",
    message: SUBAGENT_OBSERVATION_PREFIX + JSON.stringify(payload),
  }), false, "the session coordinator, not runtime command receipts, owns observation frames")
  assert.equal(transport.handleFrame({
    type: "extension_ui_request", method: "notify", message: "ompiui-runtime:" + JSON.stringify({ id: "unknown", success: true }),
  }), true)
  transport.close(new Error("fixture closed"))
})

test("a native command failure arriving before its prompt ACK rejects the managed operation", async () => {
  const transport = new RuntimeBridgeTransport()
  let acknowledge!: (response: OmpRpcResponse) => void
  let prompt!: JsonObject
  const client = {
    options: { applyRuntimePolicy: true },
    request(command: JsonObject) {
      prompt = command
      return new Promise<OmpRpcResponse>(resolve => { acknowledge = resolve })
    },
  } as unknown as OmpRpcClient
  const operation = transport.request(client, "queue", {}, 10_000)
  const rejected = assert.rejects(operation, /Command failed before dispatch/)
  assert.equal(transport.handleFrame({
    type: "prompt_result", id: prompt.id,
    status: "error", agentInvoked: false, sessionSettled: true,
    error: { message: "Command failed before dispatch", retryable: false },
  }), true)
  acknowledge({ type: "response", id: String(prompt.id), command: "prompt", success: true })
  await rejected
  // A late terminal replay cannot leak managed control traffic into chat.
  assert.equal(transport.handleFrame({ type: "prompt_result", id: prompt.id, status: "completed" }), true)
  assert.equal(transport.handleFrame({ type: "prompt_result", id: "ordinary-user-prompt", status: "completed" }), false)
  transport.close(new Error("fixture closed"))
})

function queuedBridgeHarness(streaming = true) {
  const source = runtimeBridgeExtension()
    .replace(/^import[^\n]+\n/gm, "")
    .replace("export default function (pi)", "function extension(pi)")
    + "\nextension"
  let commandHandler!: (text: string, ctx: unknown) => Promise<void>
  const replaced: Array<[JsonObject[], JsonObject[]]> = []
  const user = (text: string, timestamp: number, images: JsonObject[] = []): JsonObject => ({
    role: "user", timestamp, content: [{ type: "text", text }, ...images],
  })
  const sibling = user("already steering", 100)
  const companion: JsonObject = { role: "custom", display: false, content: "image description" }
  const selected = user("selected", 200, [{ type: "image", data: "AA==", mimeType: "image/png" }])
  const untouched = user("keep following up", 300)
  let steering = [sibling]
  let followUp = [companion, selected, untouched]
  const entries: JsonObject[] = []
  let continuationError: Error | undefined
  const session = {
    sessionManager: {
      getSessionId: () => "session", getSessionFile: () => "session.jsonl",
      getEntries: () => entries, getBranchView: () => entries,
    },
    scopedModels: [],
    agent: {
      peekSteeringQueue: () => steering,
      peekFollowUpQueue: () => followUp,
      replaceQueues: (nextSteering: JsonObject[], nextFollowUp: JsonObject[]) => {
        replaced.push([nextSteering, nextFollowUp]); steering = nextSteering; followUp = nextFollowUp
      },
      continue: async () => { if (continuationError) throw continuationError },
      state: { isStreaming: streaming },
    },
    hasAdmittedSubmission: true, isRetrying: false, isCompacting: false,
    isGeneratingHandoff: false, isStreaming: streaming,
  }
  const pi = {
    registerCommand: (_name: string, spec: { handler: typeof commandHandler }) => { commandHandler = spec.handler },
    pi: { AgentRegistry: { global: () => ({ list: () => [{ session }] }) } },
  }
  const extension = runInNewContext(source, {
    randomUUID: () => "runtime-id", AsyncLocalStorage, Buffer,
    isUserQueuedMessage: (value: JsonObject) => value.role === "user" || (value.role === "custom" && value.attribution === "user" && value.display !== false),
    isHiddenUserCompanion: (value: JsonObject) => value.role === "custom" && value.display === false,
    toRestoredQueuedMessage: (value: JsonObject) => ({
      text: typeof value.content === "string" ? value.content : (value.content as JsonObject[]).find(block => block.type === "text")?.text ?? "",
      images: typeof value.content === "string" ? [] : (value.content as JsonObject[]).filter(block => block.type === "image"),
    }),
    contextHash: createHash, contextSettings: () => ({}),
    resolveModelScope: async () => [], cfgDisabledExtensions: { get: () => [] }, rm: async () => undefined,
  }) as (value: typeof pi) => void
  extension(pi)
  return {
    session, selected, companion, sibling, untouched, entries, replaced,
    failContinuation: (error: Error) => { continuationError = error },
    async run(operation: string, args: JsonObject = {}): Promise<JsonObject> {
      const notifications: string[] = []
      const done = Promise.withResolvers<void>()
      const ctx = {
        cwd: process.cwd(), sessionManager: session.sessionManager,
        setTimeout: (callback: () => Promise<void>) => { void callback().then(done.resolve, done.reject) },
        ui: { notify: (message: string) => notifications.push(message) },
      }
      await commandHandler(JSON.stringify({ id: "request", operation, args }), ctx)
      await done.promise
      const response = notifications.find(message => message.startsWith("\u001eompiui-runtime:"))
      assert.ok(response, "missing runtime response")
      return JSON.parse(response.slice("\u001eompiui-runtime:".length)) as JsonObject
    },
  }
}

for (const kind of ["steering", "followUp"] as const) {
  test(`generated bridge promotes ${kind} without rewriting normalized native messages`, async () => {
    const harness = queuedBridgeHarness()
    const queue = (await harness.run("queue")).data as JsonObject
    const index = 0
    const selection = (queue[`${kind}Entries`] as JsonObject[])[index]!
    const original = structuredClone(kind === "steering" ? harness.sibling : harness.selected)
    const response = await harness.run("sendQueuedMessage", { kind, index, entryId: selection.entryId })
    assert.equal(response.success, true)
    const data = response.data as JsonObject
    assert.deepEqual(data.submittedMessage, {
      id: `submitted:${selection.entryId}`, queueEntryId: selection.entryId, submissionStatus: "queued",
      message: { role: "user", timestamp: original.timestamp, content: kind === "steering"
        ? [{ type: "text", text: "already steering" }]
        : [{ type: "text", text: "selected" }, { type: "image", data: "", mimeType: "image/png", dataOmitted: true }] },
    })
    assert.deepEqual(kind === "steering" ? harness.sibling : harness.selected, original)
    assert.equal(harness.replaced.length, 1)
    if (kind === "followUp") {
      assert.deepEqual([...harness.replaced[0]![0]], [harness.sibling, harness.companion, harness.selected])
      assert.deepEqual([...harness.replaced[0]![1]], [harness.untouched])
      assert.equal(harness.replaced[0]![0][1], harness.companion)
      assert.equal(harness.replaced[0]![0][2], harness.selected)
    } else {
      assert.deepEqual([...harness.replaced[0]![1]], [harness.companion, harness.selected, harness.untouched])
    }
    harness.entries.push({ id: "same-text-other-entry", type: "message", message: structuredClone(original) })
    let identity = (await harness.run("queue", { submittedQueueEntryIds: [selection.entryId!] })).data as JsonObject
    assert.deepEqual(identity.submittedHistoryEntries, [], "same content/timestamp is not native object identity")
    harness.entries.push({ id: "native-history", type: "message", message: kind === "steering" ? harness.sibling : harness.selected })
    identity = (await harness.run("queue", { submittedQueueEntryIds: [selection.entryId!] })).data as JsonObject
    assert.deepEqual(identity.submittedHistoryEntries, [{ queueEntryId: selection.entryId, historyEntryId: "native-history" }])
  })
}

test("generated bridge preserves custom user queue operations without an unretirable shared receipt", async () => {
  const harness = queuedBridgeHarness()
  const custom: JsonObject = { role: "custom", customType: "user-custom-prompt", attribution: "user", display: true, timestamp: 400, content: "custom input" }
  harness.session.agent.peekFollowUpQueue().push(custom)
  const queue = (await harness.run("queue")).data as JsonObject
  const selection = (queue.followUpEntries as JsonObject[])[2]!
  const response = await harness.run("sendQueuedMessage", { kind: "followUp", index: 2, entryId: selection.entryId })
  assert.equal(response.success, true)
  assert.deepEqual(response.data, { accepted: true })
  assert.equal(harness.session.agent.peekSteeringQueue().at(-1), custom)
  assert.deepEqual([...harness.session.agent.peekFollowUpQueue()], [harness.companion, harness.selected, harness.untouched])
})

test("generated bridge rolls back queues and publishes no submission on native continuation failure", async () => {
  const harness = queuedBridgeHarness(false)
  const queue = (await harness.run("queue")).data as JsonObject
  const selection = (queue.followUpEntries as JsonObject[])[0]!
  harness.failContinuation(new Error("continuation rejected"))
  const response = await harness.run("sendQueuedMessage", { kind: "followUp", index: 0, entryId: selection.entryId })
  assert.equal(response.success, false)
  assert.equal(response.data, undefined)
  assert.equal(harness.replaced.length, 2)
  assert.deepEqual([...harness.session.agent.peekSteeringQueue()], [harness.sibling])
  assert.deepEqual([...harness.session.agent.peekFollowUpQueue()], [harness.companion, harness.selected, harness.untouched])
})

test("generated bridge rejects stale selection and display-budget overflow before queue mutation", async () => {
  const harness = queuedBridgeHarness()
  const queue = (await harness.run("queue")).data as JsonObject
  const selection = (queue.followUpEntries as JsonObject[])[0]!
  const stale = await harness.run("sendQueuedMessage", { kind: "followUp", index: 0, entryId: "stale" })
  assert.equal(stale.success, false)
  assert.equal(stale.code, "QUEUE_SELECTION_STALE")
  const overflow = await harness.run("sendQueuedMessage", { kind: "followUp", index: 0, entryId: selection.entryId, maxResultBytes: 1 })
  assert.equal(overflow.success, false)
  assert.equal(overflow.code, "FILE_TOO_LARGE")
  assert.deepEqual(harness.replaced, [])
})

test("process shutdown rejects an operation still waiting for its runtime receipt", async () => {
  const transport = new RuntimeBridgeTransport()
  const client = {
    options: { applyRuntimePolicy: true },
    async request(command: JsonObject) { return { type: "response", id: command.id, command: "prompt", success: true } },
  } as unknown as OmpRpcClient
  const operation = transport.request(client, "removeQueuedMessage", { kind: "steering", index: 0, entryId: 'original' }, 10_000)
  const rejected = assert.rejects(operation, /Native child exited/)
  transport.close(new Error("Native child exited"))
  await rejected
})

// Public extension forwarding tests; actual native lifecycle proof is separate.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonObject

function goalHarness(session: Record<string, unknown>) {
  const source = runtimeBridgeExtension()
    .replace(/^import[^\n]+\n/gm, "")
    .replace("export default function (pi)", "function extension(pi)")
    + "\nextension"
  let commandHandler!: (text: string, ctx: unknown) => Promise<void>
  const sessionManager = { getSessionId: () => "session", getSessionFile: () => "session.jsonl", flush: async () => {} }
  const fullSession = Object.assign(session, { sessionManager })
  const timers = new Set<() => void>()
  const pi = {
    registerCommand: (_name: string, spec: { handler: typeof commandHandler }) => { commandHandler = spec.handler },
    pi: { AgentRegistry: { global: () => ({ list: () => [{ session: fullSession }] }) } },
  }
  const context = {
    randomUUID: () => "runtime-id", AsyncLocalStorage, Buffer,
    isUserQueuedMessage: () => false, isHiddenUserCompanion: () => false,
    toRestoredQueuedMessage: (value: JsonObject) => ({ ...value }),
    resolveModelScope: async () => [], cfgDisabledExtensions: { get: () => [] }, rm: async () => undefined,
    setTimeout: (callback: () => void) => { timers.add(callback); return callback },
    clearTimeout: (callback: unknown) => { timers.delete(callback as () => void) },
  }
  const extension = runInNewContext(source, context) as (value: typeof pi) => void
  extension(pi)
  return {
    pendingTimers: () => timers.size,
    flushTimers() {
      const due = [...timers]
      timers.clear()
      for (const callback of due) callback()
    },
    async run(args: JsonObject): Promise<JsonObject> {
      const notifications: string[] = []
      const done = Promise.withResolvers<void>()
      const ctx = {
        cwd: process.cwd(),
        sessionManager,
        setTimeout: (callback: () => Promise<void>) => { void callback().then(done.resolve, done.reject) },
        ui: { notify: (message: string) => notifications.push(message) },
      }
      await commandHandler(JSON.stringify({ id: "request", operation: "goal", args }), ctx)
      await done.promise
      const response = notifications.find(message => message.startsWith("\u001eompiui-runtime:"))
      assert.ok(response, "missing runtime response")
      return JSON.parse(response.slice("\u001eompiui-runtime:".length)) as JsonObject
    },
  }
}

function fakeGoalSession() {
  const calls: unknown[] = []
  let state: JsonObject = { enabled: true, mode: "active", goal: { id: "goal", objective: "ship it", status: "active", tokensUsed: 12, timeUsedSeconds: 3 } }
  return { calls, surface: {
    goalRuntime: {
      replaceGoal: async (input: unknown) => { calls.push(["replace", input]); return state },
      completeGoalFromTool: async () => { calls.push("complete"); state = { ...state, enabled: false, mode: "exiting" }; return state.goal },
      onBudgetMutated: async (value: unknown) => { calls.push(["budget", value]); return state },
    },
    getGoalModeState: () => state,
    sessionManager: { flush: async () => {} },
  } }
}

test("bridge uses public AgentSession GoalRuntime only for non-RPC operations", async () => {
  const fake = fakeGoalSession()
  const harness = goalHarness(fake.surface)
  for (const args of [{ op: "replace", objective: "new", tokenBudget: 100 }, { op: "complete" }, { op: "budget", tokenBudget: 200 }, { op: "budget", clearBudget: true }]) {
    assert.equal((await harness.run(args)).success, true)
  }
  assert.deepEqual(plain(fake.calls), [["replace", { objective: "new", tokenBudget: 100 }], "complete", ["budget", 200], ["budget", null]])
})

test("native RPC goal operations never use the bridge or a shadow continuation", async () => {
  const fake = fakeGoalSession()
  const harness = goalHarness(fake.surface)
  for (const op of ["create", "get", "pause", "resume", "drop"]) assert.equal((await harness.run({ op })).success, false)
  assert.deepEqual(fake.calls, [])
  assert.equal(harness.pendingTimers(), 0)
})

test("missing official operation fails before any goal mutation", async () => {
  const fake = fakeGoalSession()
  const response = await goalHarness({ agent: fake.surface }).run({ op: "complete" })
  assert.equal(response.success, false)
  assert.equal(response.code, "CAPABILITY_DISABLED")
  assert.deepEqual(fake.calls, [])
})
