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

  writeExtensionUiResponse(): void {}

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
