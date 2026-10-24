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

// #391/#392: goal 操作接收者是 AgentSession 本身；同一桥实例内验证首轮投递与续跑调度。
type GoalEvent = Record<string, unknown>
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonObject

function goalHarness(session: Record<string, unknown>) {
  const source = runtimeBridgeExtension()
    .replace(/^import[^\n]+\n/gm, "")
    .replace("export default function (pi)", "function extension(pi)")
    + "\nextension"
  let commandHandler!: (text: string, ctx: unknown) => Promise<void>
  const sessionManager = { getSessionId: () => "session", getSessionFile: () => "session.jsonl" }
  // 原地挂 sessionManager：多个桥实例共享同一 session 对象（循环登记在 session 上）。
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

function fakeGoalSession(options: { streaming?: boolean } = {}) {
  const calls: string[] = []
  const prompts: string[] = []
  const continuations: JsonObject[] = []
  const listeners = new Set<(event: GoalEvent) => void>()
  let active = ["read", "bash"]
  let objective = ""
  let state: JsonObject | null = null
  const setState = (status: string) => {
    state = { enabled: status === "active", goal: { status, objective } }
    return state
  }
  return {
    calls,
    prompts,
    continuations,
    listeners,
    active: () => active,
    emit: (event: GoalEvent) => { for (const listener of [...listeners]) listener(event) },
    surface: {
      goalRuntime: {
        createGoal: async (input: { objective: string }) => { calls.push("create"); objective = input.objective; return setState("active") },
        pauseGoal: async () => { calls.push("pause"); return setState("paused") },
        resumeGoal: async () => { calls.push("resume"); return setState("active") },
        buildContinuationPrompt: () => "continue the goal",
      },
      getGoalModeState: () => state,
      getEnabledToolNames: () => active.slice(),
      // vm 上下文传入的数组原型不同，复制到测试 realm 再比较
      setActiveToolsByName: async (names: string[]) => { active = [...names] },
      isStreaming: options.streaming === true,
      isCompacting: false,
      hasPostPromptWork: false,
      hasAdmittedSubmission: false,
      queuedMessageCount: 0,
      sendGoalModeContext: async (deliver?: { deliverAs?: string }) => { calls.push("context:" + deliver?.deliverAs) },
      prompt: async (text: string) => { prompts.push(text) },
      promptCustomMessage: async (message: JsonObject) => { continuations.push(plain(message)) },
      subscribe: (listener: (event: GoalEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
  }
}

test("goal operations use the goal runtime on AgentSession", async () => {
  const fake = fakeGoalSession()
  const harness = goalHarness({ ...fake.surface, agent: {} })
  const created = await harness.run({ op: "create", objective: "ship it" })
  assert.equal(created.success, true, String(created.error))
  assert.deepEqual((created.data as JsonObject).state, { enabled: true, goal: { status: "active", objective: "ship it" } })
  assert.deepEqual(fake.active(), ["read", "bash", "goal"])
  const paused = await harness.run({ op: "pause" })
  assert.equal(paused.success, true, String(paused.error))
  assert.equal((((paused.data as JsonObject).state as JsonObject).goal as JsonObject).status, "paused")
  assert.deepEqual(fake.active(), ["read", "bash"])
  const snapshot = await harness.run({ op: "snapshot" })
  assert.equal((((snapshot.data as JsonObject).state as JsonObject).goal as JsonObject).status, "paused")
  assert.deepEqual(fake.calls, ["create", "pause"])
})

test("goal operations ignore a goal runtime that only exists on the inner agent", async () => {
  const fake = fakeGoalSession()
  const response = await goalHarness({ agent: fake.surface }).run({ op: "create", objective: "ship it" })
  assert.equal(response.success, false)
  assert.equal(response.code, "CAPABILITY_DISABLED")
  assert.deepEqual(fake.calls, [])
})

test("goal create on an idle session delivers the objective as the first turn exactly once", async () => {
  const fake = fakeGoalSession()
  const harness = goalHarness(fake.surface)
  await harness.run({ op: "create", objective: "ship it" })
  assert.deepEqual(fake.prompts, ["ship it"])
  assert.deepEqual(fake.continuations, [])
  assert.equal(fake.calls.includes("context:steer"), false)
  assert.equal(harness.pendingTimers(), 0)
})

test("goal create while streaming steers goal context instead of prompting", async () => {
  const fake = fakeGoalSession({ streaming: true })
  await goalHarness(fake.surface).run({ op: "create", objective: "ship it" })
  assert.deepEqual(fake.prompts, [])
  assert.deepEqual(fake.calls, ["create", "context:steer"])
})

test("terminal agent_end continues an active goal through the official continuation prompt", async () => {
  const fake = fakeGoalSession()
  const harness = goalHarness(fake.surface)
  await harness.run({ op: "create", objective: "ship it" })
  fake.emit({ type: "agent_end", isTerminal: false, messages: [] })
  assert.equal(harness.pendingTimers(), 0)
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
  harness.flushTimers()
  assert.deepEqual(fake.continuations, [{ customType: "goal-continuation", content: "continue the goal", display: false }])
  // 续跑轮有新工具活动：继续调度。
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] }] })
  harness.flushTimers()
  assert.equal(fake.continuations.length, 2)
  // 续跑轮无工具活动：按官方语义抑制，直到下一条真实用户消息。
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
  assert.equal(harness.pendingTimers(), 0)
  fake.emit({ type: "message_start", message: { role: "user" } })
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
  harness.flushTimers()
  assert.equal(fake.continuations.length, 3)
})

test("goal continuation stops after pause and after a user abort", async () => {
  const fake = fakeGoalSession()
  const harness = goalHarness(fake.surface)
  await harness.run({ op: "create", objective: "ship it" })
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted", content: [] }] })
  assert.equal(harness.pendingTimers(), 0)
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
  await harness.run({ op: "pause" })
  assert.equal(fake.listeners.size, 0)
  assert.equal(harness.pendingTimers(), 0)
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
  harness.flushTimers()
  assert.deepEqual(fake.continuations, [])
})

test("goal resume on an idle session schedules one continuation", async () => {
  const fake = fakeGoalSession()
  const harness = goalHarness(fake.surface)
  await harness.run({ op: "create", objective: "ship it" })
  await harness.run({ op: "pause" })
  await harness.run({ op: "resume" })
  assert.equal(fake.listeners.size, 1)
  harness.flushTimers()
  assert.equal(fake.continuations.length, 1)
})

test("goal create on an old runtime is rejected before any goal state changes", async () => {
  for (const missing of ["subscribe", "buildContinuationPrompt"] as const) {
    const fake = fakeGoalSession()
    const surface: Record<string, unknown> = { ...fake.surface, goalRuntime: { ...fake.surface.goalRuntime } }
    if (missing === "subscribe") delete surface.subscribe
    else delete (surface.goalRuntime as Record<string, unknown>).buildContinuationPrompt
    const response = await goalHarness(surface).run({ op: "create", objective: "ship it" })
    assert.equal(response.success, false, missing)
    assert.equal(response.code, "CAPABILITY_DISABLED", missing)
    assert.deepEqual(fake.calls, [], missing)
    assert.deepEqual(fake.active(), ["read", "bash"], missing)
  }
})

test("a throwing continuation prompt never escapes the continuation timer", async () => {
  const fake = fakeGoalSession()
  fake.surface.goalRuntime.buildContinuationPrompt = () => { throw new Error("prompt failed") }
  const harness = goalHarness(fake.surface)
  await harness.run({ op: "create", objective: "ship it" })
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
  assert.doesNotThrow(() => harness.flushTimers())
  assert.deepEqual(fake.continuations, [])
})

test("a reloaded bridge replaces the previous goal loop instead of subscribing twice", async () => {
  const fake = fakeGoalSession()
  await goalHarness(fake.surface).run({ op: "create", objective: "ship it" })
  assert.equal(fake.listeners.size, 1)
  const reloaded = goalHarness(fake.surface)
  await reloaded.run({ op: "create", objective: "ship it again" })
  assert.equal(fake.listeners.size, 1)
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
  reloaded.flushTimers()
  assert.equal(fake.continuations.length, 1)
})
