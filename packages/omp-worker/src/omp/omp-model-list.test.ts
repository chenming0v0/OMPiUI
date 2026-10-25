import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, it } from "node:test"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { OmpProviderAuth } from "./omp-auth.js"
import { OmpCatalog } from "./omp-catalog.js"
import type { OmpRpcClient, OmpRpcResponse } from "./rpc-client.js"

class ModelListClient extends EventEmitter {
  hasExited = false
  readonly commands: JsonObject[] = []

  constructor(private readonly data: JsonValue) { super() }

  async request(command: JsonObject): Promise<OmpRpcResponse> {
    this.commands.push(command)
    assert.equal(command.type, "get_available_models", "browsing must not select a model or launch a turn")
    return { type: "response", command: "get_available_models", success: true, data: this.data }
  }
}

const gateways = [
  {
    name: "auth models.list",
    create: (client: OmpRpcClient) => new OmpProviderAuth(async () => client),
  },
  {
    name: "catalog listModels",
    create: (client: OmpRpcClient) => {
      const catalog = new OmpCatalog()
      catalog.control.acquire = async () => client
      return catalog
    },
  },
]

for (const gateway of gateways) {
  describe(gateway.name, () => {
    async function list(data: JsonValue): Promise<JsonObject[]> {
      const client = new ModelListClient(data)
      const models = await gateway.create(client as unknown as OmpRpcClient).listModels()
      assert.deepEqual(client.commands, [{ type: "get_available_models" }], "one native query serves every model")
      assert.ok(Array.isArray(models))
      return models as JsonObject[]
    }

    it("offers exactly the native gpt-6.1-sol ladder and preserves native metadata", async () => {
      const efforts = ["low", "medium", "high", "xhigh", "max"]
      const thinking = { mode: "effort", efforts, effortMap: { max: "provider-private-max" } }
      const native: JsonObject = {
        provider: "custom", id: "gpt-6.1-sol", name: "Configured GPT", reasoning: true,
        api: "openai-responses", contextWindow: 272000, input: ["text", "image"],
        thinking, cost: { input: 2, output: 8 },
      }
      Object.freeze(efforts)
      Object.freeze(thinking)
      Object.freeze(native)
      const [model] = await list({ models: [native] })
      assert.deepEqual(model, {
        ...native, supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      })
      assert.equal(model!.thinking, thinking, "metadata is retained, not rebuilt or translated")
      assert.equal(native.supportedThinkingLevels, undefined, "native objects are not mutated")
    })

    it("does not invent absent tiers for a restricted reasoning model", async () => {
      const models = await list({ models: [
        { provider: "custom", id: "restricted", reasoning: true, thinking: { mode: "google-level", efforts: ["low", "high"] } },
        { provider: "custom", id: "minimal-only", reasoning: true, thinking: { mode: "budget", efforts: ["minimal"] } },
      ] })
      assert.deepEqual(models.map(model => model.supportedThinkingLevels), [["off", "low", "high"], ["off", "minimal"]])
    })

    it("offers only off for nonreasoning and uncontrollable reasoning models", async () => {
      const models = await list({ models: [
        { provider: "custom", id: "plain", reasoning: false },
        { provider: "custom", id: "stale-thinking", reasoning: false, thinking: { efforts: ["high", "max"] } },
        { provider: "custom", id: "uncontrollable", reasoning: true },
        { provider: "custom", id: "explicit-empty", reasoning: true, thinking: { efforts: [] }, thinkingLevelMap: { high: "high" } },
      ] })
      assert.deepEqual(models.map(model => model.supportedThinkingLevels), [["off"], ["off"], ["off"], ["off"]])
    })

    it("preserves declared future efforts without offering provider wire aliases", async () => {
      const [model] = await list({ models: [{
        provider: "custom", id: "extended", reasoning: true,
        thinking: { efforts: ["low", "high", "extreme"], effortMap: { high: "provider-private-high" } },
      }] })
      assert.deepEqual(model!.supportedThinkingLevels, ["off", "low", "high", "extreme"])
    })

    it("reads the same supported metadata from bare native arrays and ignores non-model entries", async () => {
      const [model] = await list([null, "not-a-model", { provider: "custom", id: "bare", reasoning: true, thinking: { efforts: ["medium"] } }])
      assert.equal(model!.id, "bare")
      assert.deepEqual(model!.supportedThinkingLevels, ["off", "medium"])
    })

    it("keeps empty or malformed model discovery empty", async () => {
      for (const data of [[], {}, { models: null }, { models: [] }] satisfies JsonValue[]) {
        assert.deepEqual(await list(data), [])
      }
    })
  })
}
