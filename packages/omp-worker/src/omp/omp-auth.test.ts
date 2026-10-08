import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, it } from "node:test"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import type { OmpRpcClient, OmpRpcResponse } from "./rpc-client.js"
import { OmpProviderAuth } from "./omp-auth.js"

/**
 * OmpRpcClient 假身：只实现 OmpProviderAuth 用到的面（on/hasExited/request/
 * writeExtensionUiResponse/close）。request 返回未决 promise，由测试按命令
 * 类型显式 resolve —— 模拟挂在长驻进程上的慢请求（如进行中的 OAuth login）。
 */
class FakeOmpClient extends EventEmitter {
  hasExited = false
  closeCalls = 0
  private readonly resolvers = new Map<string, Array<(response: OmpRpcResponse) => void>>()

  request(command: JsonObject): Promise<OmpRpcResponse & { data?: JsonValue }> {
    const type = String(command.type)
    return new Promise(resolve => {
      const list = this.resolvers.get(type) ?? []
      list.push(resolve as (response: OmpRpcResponse) => void)
      this.resolvers.set(type, list)
    })
  }

  hasPending(type: string): boolean {
    return (this.resolvers.get(type)?.length ?? 0) > 0
  }

  /** resolve 最早挂起的指定类型请求 */
  resolveFirst(type: string, success: boolean, data?: JsonValue): void {
    const list = this.resolvers.get(type)
    const resolve = list?.shift()
    if (!resolve) throw new Error(`no pending request of type ${type}`)
    if (list!.length === 0) this.resolvers.delete(type)
    resolve({ type: "response", command: type, success, data })
  }

  responses: JsonObject[] = []
  onResponse: ((response: JsonObject) => void) | undefined

  writeExtensionUiResponse(response: JsonObject): void {
    this.responses.push(response)
    this.onResponse?.(response)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.hasExited = true
  }
}

function createAuth(): { auth: OmpProviderAuth; clients: FakeOmpClient[] } {
  const clients: FakeOmpClient[] = []
  const auth = new OmpProviderAuth(async () => {
    const client = new FakeOmpClient()
    clients.push(client)
    return client as unknown as OmpRpcClient
  })
  return { auth, clients }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}


function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle)
  if (Array.isArray(value)) return value.some(item => containsString(item, needle))
  if (value && typeof value === "object") return Object.values(value).some(item => containsString(item, needle))
  return false
}

function emitPrompt(client: FakeOmpClient, id: string, title: string): void {
  client.emit("frame", { type: "extension_ui_request", method: "input", id, title })
}

describe("OmpProviderAuth.invalidate", () => {
  it("recycles the bound client so the next command acquires a fresh one", async () => {
    const { auth, clients } = createAuth()

    const first = auth.listModels()
    await waitUntil(() => clients[0]?.hasPending("get_available_models") === true)
    clients[0]!.resolveFirst("get_available_models", true, { models: [] })
    assert.deepEqual(await first, [])
    assert.equal(clients.length, 1)

    await auth.invalidate()
    assert.equal(clients[0]!.closeCalls, 1, "old process should be closed")

    const second = auth.listModels()
    await waitUntil(() => clients[1]?.hasPending("get_available_models") === true)
    clients[1]!.resolveFirst("get_available_models", true, { models: [] })
    assert.deepEqual(await second, [])
    assert.equal(clients.length, 2, "next listModels must spawn a new omp process")
  })

  it("defers invalidation until an in-flight login flow ends", async () => {
    const { auth, clients } = createAuth()

    const started = await auth.start("anthropic", "oauth")
    assert.ok(typeof started.flowId === "string")
    await waitUntil(() => clients[0]!.hasPending("login"))

    await auth.invalidate()
    assert.equal(clients[0]!.closeCalls, 0, "must not kill the process an OAuth flow is running on")

    // 登录流进行中：listModels 仍复用旧进程
    const midList = auth.listModels()
    await waitUntil(() => clients[0]!.hasPending("get_available_models"))
    assert.equal(clients.length, 1)
    clients[0]!.resolveFirst("get_available_models", true, { models: [] })
    await midList

    // 流结束（登录成功）：挂起的作废放行，旧进程关闭
    clients[0]!.resolveFirst("login", true, {})
    await waitUntil(() => clients[0]!.closeCalls > 0)
    assert.equal(clients[0]!.closeCalls, 1, "deferred invalidation runs once the flow drains")

    const postList = auth.listModels()
    await waitUntil(() => clients[1]?.hasPending("get_available_models") === true)
    clients[1]!.resolveFirst("get_available_models", true, { models: [] })
    await postList
    assert.equal(clients.length, 2, "post-flow listModels must get the fresh process")
  })

  it("reloadConfig() respawns the process before querying available models", async () => {
    const { auth, clients } = createAuth()

    const first = auth.listModels()
    await waitUntil(() => clients[0]?.hasPending("get_available_models") === true)
    clients[0]!.resolveFirst("get_available_models", true, { models: [] })
    await first

    const reload = auth.reloadConfig()
    await waitUntil(() => clients[1]?.hasPending("get_available_models") === true)
    assert.equal(clients[0]!.closeCalls, 1)
    clients[1]!.resolveFirst("get_available_models", true, { models: [] })
    await reload
    assert.equal(clients.length, 2, "reloadConfig must recycle the stale process")
  })
})

describe("OmpProviderAuth active flows", () => {
  it("snapshots flowId, providerId, and the current prompt or notification without credentials", async () => {
    const { auth, clients } = createAuth()
    const started = await auth.start("anthropic", "oauth")
    assert.equal(typeof started.flowId, "string")
    const flowId = started.flowId
    const client = clients[0]!
    const secret = "credential-must-not-leak"

    emitPrompt(client, "prompt-a", "Enter the code")
    const prompted = auth.listActiveFlows()
    assert.ok(Array.isArray(prompted))
    assert.equal(prompted.length, 1)
    const promptItem = prompted[0] as JsonObject
    assert.deepEqual(Object.keys(promptItem).sort(), ["event", "flowId", "notifications", "providerId"])
    assert.equal(promptItem.flowId, flowId)
    assert.equal(promptItem.providerId, "anthropic")
    const promptEvent = promptItem.event as JsonObject
    assert.equal(promptEvent.type, "prompt")
    assert.equal(promptEvent.flowId, flowId)
    assert.equal(promptEvent.providerId, "anthropic")
    assert.equal(promptEvent.promptId, "prompt-a")
    assert.equal((promptEvent.prompt as JsonObject).message, "Enter the code")

    client.emit("frame", { type: "extension_ui_request", method: "notify", id: "note-1", message: "Check the browser" })
    const pending = (auth.listActiveFlows() as JsonObject[])[0]!
    assert.equal((pending.event as JsonObject).type, "prompt", "a notification must not replace the unanswered prompt")
    assert.equal((pending.event as JsonObject).promptId, "prompt-a")
    assert.deepEqual(pending.notifications, ["Check the browser"])

    auth.respond(flowId, "prompt-a", secret)
    const cleared = auth.listActiveFlows()
    assert.equal((cleared as JsonObject[])[0]!.event, null)
    assert.equal(containsString(cleared, secret), false)
    assert.equal(client.responses.some(response => response.value === secret), true)

    client.emit("frame", { type: "extension_ui_request", method: "notify", id: "note-2", message: "Still waiting" })
    const noted = (auth.listActiveFlows() as JsonObject[])[0]!
    const noteEvent = noted.event as JsonObject
    assert.equal(noteEvent.type, "notification")
    assert.equal(noteEvent.flowId, flowId)
    assert.equal(noteEvent.providerId, "anthropic")
    assert.equal(noteEvent.event, "Still waiting")
    assert.deepEqual(noted.notifications, ["Check the browser", "Still waiting"])
    assert.equal(containsString(auth.listActiveFlows(), secret), false)
  })

  it("does not clear prompt B when it arrives while prompt A is answered", async () => {
    const { auth, clients } = createAuth()
    const started = await auth.start("openai", "oauth")
    const flowId = started.flowId as string
    const client = clients[0]!
    const secret = "credential-must-not-leak"
    emitPrompt(client, "prompt-a", "First step")
    client.onResponse = () => emitPrompt(client, "prompt-b", "Second step")

    auth.respond(flowId, "prompt-a", secret)

    const item = (auth.listActiveFlows() as JsonObject[])[0]!
    const event = item.event as JsonObject
    assert.equal(event.type, "prompt")
    assert.equal(event.promptId, "prompt-b")
    assert.equal((event.prompt as JsonObject).message, "Second step")
    assert.equal(client.responses[0]?.id, "prompt-a")
    assert.equal(client.responses[0]?.value, secret)
    assert.equal(containsString(auth.listActiveFlows(), secret), false)
  })

  it("does not clear prompt B when a response for prompt A arrives after B", async () => {
    const { auth, clients } = createAuth()
    const started = await auth.start("openai", "oauth")
    const flowId = started.flowId as string
    const client = clients[0]!
    const secret = "credential-must-not-leak"
    emitPrompt(client, "prompt-a", "First step")
    emitPrompt(client, "prompt-b", "Second step")

    auth.respond(flowId, "prompt-a", secret)

    const event = ((auth.listActiveFlows() as JsonObject[])[0]!.event) as JsonObject
    assert.equal(event.promptId, "prompt-b")
    assert.equal((event.prompt as JsonObject).message, "Second step")
    assert.equal(client.responses.length, 0)
    assert.equal(containsString(auth.listActiveFlows(), secret), false)
  })
})
