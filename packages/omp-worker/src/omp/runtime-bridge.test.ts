import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { runInNewContext } from "node:vm"
import { test } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import type { OmpRpcClient, OmpRpcResponse } from "./rpc-client.js"
import { runtimeBridgeExtension, RuntimeBridgeTransport } from "./runtime-bridge.js"

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

test("generated bridge promotes a queued message while a native submission is admitted", async () => {
  const source = runtimeBridgeExtension()
    .replace(/^import[^\n]+\n/gm, "")
    .replace("export default function (pi)", "function extension(pi)")
    + "\nextension"
  let commandHandler!: (text: string, ctx: unknown) => Promise<void>
  const notifications: string[] = []
  const replaced: Array<[unknown[], unknown[]]> = []
  const steering = [{ user: true, text: "already steering" }]
  const companion = { hidden: true, text: "image description" }
  const selected = { user: true, text: "selected", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] }
  const untouched = { user: true, text: "keep following up" }
  const followUp = [companion, selected, untouched]
  const session = {
    sessionManager: { getSessionId: () => "session", getSessionFile: () => "session.jsonl" },
    agent: {
      peekSteeringQueue: () => steering,
      peekFollowUpQueue: () => followUp,
      replaceQueues: (nextSteering: unknown[], nextFollowUp: unknown[]) => replaced.push([nextSteering, nextFollowUp]),
      state: { isStreaming: true },
    },
    hasAdmittedSubmission: true,
    isRetrying: false,
    isCompacting: false,
    isGeneratingHandoff: false,
    isStreaming: true,
  }
  const pi = {
    registerCommand: (_name: string, spec: { handler: typeof commandHandler }) => { commandHandler = spec.handler },
    pi: { AgentRegistry: { global: () => ({ list: () => [{ session }] }) } },
  }
  const context = {
    randomUUID: () => "runtime-id",
    AsyncLocalStorage,
    Buffer,
    isUserQueuedMessage: (value: unknown) => value !== null && typeof value === "object" && "user" in value && value.user === true,
    isHiddenUserCompanion: (value: unknown) => value !== null && typeof value === "object" && "hidden" in value && value.hidden === true,
    toRestoredQueuedMessage: (value: JsonObject) => ({ ...value }),
    resolveModelScope: async () => [],
    cfgDisabledExtensions: { get: () => [] },
    rm: async () => undefined,
  }
  const extension = runInNewContext(source, context) as (value: typeof pi) => void
  extension(pi)
  const request = JSON.stringify({ id: "request", operation: "sendQueuedMessage", args: { kind: "followUp", index: 0, entryId: "runtime-id:session:1" } })
  const ctx = {
    cwd: process.cwd(),
    sessionManager: session.sessionManager,
    setTimeout: (callback: () => Promise<void>) => { void callback() },
    ui: { notify: (message: string) => notifications.push(message) },
  }
  await commandHandler(request, ctx)
  const settled = Promise.withResolvers<void>()
  setImmediate(settled.resolve)
  await settled.promise
  assert.equal(notifications.length, 1)
  const response = JSON.parse(notifications[0]!.slice("\u001eompiui-runtime:".length)) as JsonObject
  assert.equal(response.success, true)
  assert.equal(replaced.length, 1)
  assert.deepEqual([...replaced[0]![0]], [companion, selected, ...steering])
  assert.deepEqual([...replaced[0]![1]], [untouched])
  assert.equal(replaced[0]![0][0], companion)
  assert.equal(replaced[0]![0][1], selected)
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
