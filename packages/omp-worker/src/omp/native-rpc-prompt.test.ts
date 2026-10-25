import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { requestNativePromptAcceptance } from "./native-rpc-prompt.js"
import type { OmpRpcClient } from "./rpc-client.js"

// Controlled native frames cover rejection ownership. Actual installed command
// dispatch and provider absence are proved by the centralized native smoke.
test("a reported command-handler throw rejects local completion without poisoning the next same-name command", async () => {
  const frames = new EventEmitter()
  const dispatched: JsonObject[] = []
  const client = Object.assign(frames, {
    async request(command: JsonObject) {
      dispatched.push(command)
      return { type: "response", id: command.id, command: "prompt", success: true }
    },
  }) as unknown as OmpRpcClient
  const first = requestNativePromptAcceptance(client, { type: "prompt", message: "/review first" })
  const rejected = assert.rejects(first, error => error instanceof Error && error.message === "Permission denied" &&
    "code" in error && error.code === "SUBMISSION_NOT_ADMITTED")
  const next = requestNativePromptAcceptance(client, { type: "prompt", message: "/review second" })
  assert.equal(dispatched.length, 1)
  frames.emit("frame", { type: "extension_error", event: "command", extensionPath: "command:review", error: "Permission denied" })
  frames.emit("frame", { type: "prompt_result", id: dispatched[0]!.id, status: "completed", agentInvoked: false })
  await rejected
  await Promise.resolve()
  assert.equal(dispatched.length, 2)
  frames.emit("frame", { type: "extension_error", event: "command", extensionPath: "command:other", error: "Unrelated error" })
  frames.emit("frame", { type: "prompt_result", id: dispatched[1]!.id, status: "completed", agentInvoked: false })
  assert.equal((await next).success, true)
  assert.equal(frames.listenerCount("frame"), 0)
})

test("an accepted model failure is not converted into a rejected draft by extension background errors", async () => {
  const frames = new EventEmitter()
  let id: JsonObject["id"]
  const client = Object.assign(frames, {
    async request(command: JsonObject) {
      id = command.id
      return { type: "response", id, command: "prompt", success: true }
    },
  }) as unknown as OmpRpcClient
  const accepted = requestNativePromptAcceptance(client, { type: "prompt", message: "/skill:review input" })
  frames.emit("frame", { type: "extension_error", event: "agent_end", extensionPath: "command:skill:review", error: "Background error" })
  frames.emit("frame", { type: "prompt_result", id, status: "error", agentInvoked: true, error: { message: "Model connection closed" } })
  assert.equal((await accepted).success, true)
  assert.equal(frames.listenerCount("frame"), 0)
})

test("atomic interrupt ignores unrelated terminal results and rejects same-id pre-agent failure", async () => {
  const frames = new EventEmitter()
  let command: JsonObject = {}
  const client = Object.assign(frames, {
    async request(input: JsonObject) {
      command = input
      return { type: "response", id: input.id, command: "abort_and_prompt", success: true }
    },
  }) as unknown as OmpRpcClient
  const flight = requestNativePromptAcceptance(client, { type: "abort_and_prompt", message: "new prompt", images: [{ type: "image", data: "YWJj", mimeType: "image/png" }] })
  const rejected = assert.rejects(flight, /Native model unavailable/)
  frames.emit("frame", { type: "prompt_result", id: "old-run", status: "completed", agentInvoked: true })
  frames.emit("frame", { type: "prompt_result", id: command.id, status: "error", agentInvoked: false, error: { message: "Native model unavailable" } })
  await rejected
  assert.equal(command.type, "abort_and_prompt")
  assert.deepEqual(command.images, [{ type: "image", data: "YWJj", mimeType: "image/png" }])
  assert.equal(frames.listenerCount("frame"), 0)
})

test("identity is checked after the native prompt helper's pending flight", async () => {
  const frames = new EventEmitter()
  const dispatched: JsonObject[] = []
  const client = Object.assign(frames, {
    async request(command: JsonObject) {
      dispatched.push(command)
      return { type: "response", id: command.id, command: command.type, success: true }
    },
  }) as unknown as OmpRpcClient
  const previous = requestNativePromptAcceptance(client, { type: "prompt", message: "/local" })
  const guarded = requestNativePromptAcceptance(client, { type: "prompt", message: "/guarded" }, 60_000, () => { throw new Error("Session replaced") })
  const rejected = assert.rejects(guarded, /Session replaced/)
  frames.emit("frame", { type: "prompt_result", id: dispatched[0]!.id, status: "completed", agentInvoked: false })
  await previous
  await rejected
  assert.equal(dispatched.length, 1)
  assert.equal(frames.listenerCount("frame"), 0)
})

test("atomic interruption overtakes an earlier pending prompt instead of waiting for its completion", async () => {
  const frames = new EventEmitter()
  const dispatched: JsonObject[] = []
  const client = Object.assign(frames, {
    async request(command: JsonObject) {
      dispatched.push(command)
      return { type: "response", id: command.id, command: command.type, success: true }
    },
  }) as unknown as OmpRpcClient
  const previous = requestNativePromptAcceptance(client, { type: "prompt", message: "/running" })
  const atomic = requestNativePromptAcceptance(client, { type: "abort_and_prompt", message: "new prompt" })
  assert.equal(dispatched.length, 2)
  frames.emit("frame", { type: "prompt_result", id: dispatched[0]!.id, status: "aborted", agentInvoked: true })
  frames.emit("frame", { type: "prompt_result", id: dispatched[1]!.id, status: "completed", agentInvoked: true })
  await Promise.all([previous, atomic])
  assert.equal(frames.listenerCount("frame"), 0)
})
