import assert from "node:assert/strict"
import { test } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { projectSubagentPayload, projectToolUpdate } from "./event-payload.js"
import { OmpRpcSession } from "./omp-session.js"
import type { OmpRpcFrame } from "./rpc-client.js"

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

test("task updates omit unused repeated reports without truncating live text or modifying upstream data", () => {
  const progress = Array.from({ length: 10 }, (_, index) => ({ id: `child-${index}`, status: "completed",
    extractedToolData: { yield: [{ report: "x".repeat(14000) }] }, tokens: 1000 }))
  const event: JsonObject = { type: "tool_execution_update", toolCallId: "task-call", toolName: "task",
    args: { context: "x".repeat(20000) }, partialResult: { content: [{ type: "text", text: "Running 10 agents..." }], details: { progress } } }
  const original = structuredClone(event)
  const projected = projectToolUpdate(event)
  assert.deepEqual(projected, { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
    partialResult: { content: (event.partialResult as JsonObject).content } })
  assert.deepEqual(event, original)
  assert.ok(bytes(projected) < 256)
  assert.ok(bytes(projected) < bytes(event) / 500)
  console.log(JSON.stringify({ fixture: "task progress with 10 result snapshots", beforeBytes: bytes(event), afterBytes: bytes(projected) }))
  for (const type of ["tool_execution_start", "tool_execution_end", "message_end", "bash_execution_update"]) {
    const boundary = { ...event, type }
    assert.equal(projectToolUpdate(boundary), boundary)
  }
  const ordinary = { ...event, toolName: "bash", partialResult: { content: [{ type: "text", text: "output".repeat(50000) }] } }
  assert.deepEqual(projectToolUpdate(ordinary).partialResult, ordinary.partialResult)
})

test("subagent preview preserves UI progress and tool states without duplicating canonical results", () => {
  const progress = { id: "child", index: 2, status: "running", currentTool: "read", currentToolArgs: "file.ts", currentToolStartMs: 10,
    recentTools: [{ tool: "bash", args: "test", endMs: 9 }], recentOutput: ["working"], toolCount: 8, requests: 5,
    tokens: 100, contextTokens: 80, contextWindow: 200, cost: 0.1, durationMs: 1000, resolvedModel: "model", lastIntent: "verify" }
  const payload: JsonObject = { id: "child", parentToolCallId: "task-call", sessionFile: "child.jsonl", task: "task", assignment: "assignment",
    progress: { ...progress, task: "duplicated task", assignment: "duplicated assignment", extractedToolData: { yield: ["large report"] }, inflightTaskDetails: {} } }
  const projected = projectSubagentPayload("progress", payload)
  assert.deepEqual(projected, { ...payload, progress })
  const final = { id: "child", event: { type: "tool_execution_end", toolCallId: "call", result: { details: { report: "all results" } } } }
  assert.deepEqual(projectSubagentPayload("event", final).event, { type: "tool_execution_end", toolCallId: "call" })
  assert.equal(projectToolUpdate(final.event), final.event, "main timeline final results remain intact")
})

test("message updates omit the SDK duplicate snapshot without changing the message or upstream data", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "x".repeat(100000) }] }
  const event = { type: "message_update", message, assistantMessageEvent: { type: "text_delta", partial: message, delta: "x" } }
  const projected = projectToolUpdate(event)
  assert.equal(projected.message, message)
  assert.equal(projected.assistantMessageEvent, undefined)
  assert.equal(event.assistantMessageEvent.partial, message)
  assert.ok(bytes(projected) < bytes(event) * 0.51)
})

test("subagent events strip large tool arguments, provider reasoning signatures and unused result bodies", () => {
  const huge = "x".repeat(1000000)
  const original = { id: "child", event: { type: "message_update", message: { role: "assistant", content: [
    { type: "text", text: "checking" }, { type: "thinking", thinking: "inspect files", thinkingSignature: huge },
    { type: "toolCall", id: "read", name: "read", title: "Read file", arguments: { context: huge } },
  ] }, assistantMessageEvent: { partial: huge } } }
  const projected = projectSubagentPayload("event", original)
  assert.ok(bytes(projected) < 400)
  assert.equal(original.event.message.content[2]?.arguments?.context, huge)
  const result = projectSubagentPayload("event", { id: "child", event: {
    type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: huge }] },
  } })
  assert.ok(bytes(result) < 150)
})

test("IRC messages keep the sender and actual message instead of their injected instructions", () => {
  const event = projectSubagentPayload("event", { id: "child", event: {
    type: "irc_message", message: { role: "custom", customType: "irc:incoming",
      content: "Delivery instructions", details: { from: "Reviewer", message: "Tests passed" } },
  } })
  assert.deepEqual((event.event as JsonObject).message, { role: "agent", content: "Reviewer: Tests passed" })
})

test("real session emits compact updates and keeps compact subagent state for reconnect", async t => {
  const session = Reflect.construct(OmpRpcSession, []) as OmpRpcSession
  const internal = session as unknown as { client: unknown; handleFrame(frame: OmpRpcFrame): void }
  internal.client = { async request(command: JsonObject) { return { type: "response", success: true, command: command.type, data: {} } }, async close() {} }
  t.after(() => session.dispose())
  const events: JsonObject[] = []
  const subevents: JsonObject[] = []
  session.onPiEvent(event => events.push(event))
  session.onSubagentFrame(event => subevents.push(event))
  internal.handleFrame({ type: "tool_execution_update", toolCallId: "call", toolName: "task", args: { text: "big" },
    partialResult: { content: [{ type: "text", text: "running" }], details: { report: "big" } } })
  const result = { content: [{ type: "text", text: "final" }], details: { report: "full result" } }
  internal.handleFrame({ type: "tool_execution_end", toolCallId: "call", toolName: "task", result })
  assert.equal(events[0]?.args, undefined)
  assert.deepEqual(events[0]?.partialResult, { content: [{ type: "text", text: "running" }] })
  assert.equal(events[1]?.result, result)
  internal.handleFrame({ type: "subagent_progress", payload: { parentToolCallId: "call", sessionFile: "child.jsonl", task: "task",
    progress: { id: "child", status: "completed", tokens: 99, extractedToolData: { yield: ["x".repeat(150000)] } } } })
  internal.handleFrame({ type: "subagent_lifecycle", payload: { id: "child", status: "completed" } })
  const payload = subevents[0]?.payload as JsonObject
  assert.equal((payload.progress as JsonObject).extractedToolData, undefined)
  const state = await session.getState()
  const child = (state.subagents as JsonObject[])[0]!
  assert.equal(child.id, "child")
  assert.equal(child.parentToolCallId, "call")
  assert.equal(child.status, "completed")
  assert.equal(child.sessionFile, "child.jsonl")
  assert.equal((child.progress as JsonObject).tokens, 99)
  assert.ok(bytes(state.subagents) < 512)
})
