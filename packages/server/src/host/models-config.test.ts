import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  deleteModelProvider,
  fetchModelProviderModels,
  readModelProvidersSnapshot,
  resolveModelsConfigPath,
  saveModelProvider,
} from "./models-config.ts"

const previousAgentDir = process.env.PI_CODING_AGENT_DIR
const previousProfile = process.env.OMP_PROFILE
const previousPiProfile = process.env.PI_PROFILE
let roots: string[] = []

function useTempAgentDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-models-config-"))
  const agentDir = path.join(root, "agent")
  roots.push(root)
  process.env.PI_CODING_AGENT_DIR = agentDir
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  mkdirSync(agentDir, { recursive: true })
  return agentDir
}

const SAMPLE = `providers:
  demo:
    api: openai-completions
    baseUrl: https://api.example.com/v1
    apiKey: sk-demo
    name: 演示
    compat:
      supportsReasoningEffort: true
    models:
    - id: demo-large
      name: Demo Large
      contextWindow: 200000
      maxTokens: 65536
      reasoning: true
      input:
      - text
      - image
      thinking:
        mode: effort
        efforts:
        - low
        - high
        defaultLevel: high
      compat:
        reasoningContentField: reasoning_content
      cost:
        input: 1
        output: 2
`

beforeEach(() => {
  useTempAgentDir()
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  if (previousProfile === undefined) delete process.env.OMP_PROFILE
  else process.env.OMP_PROFILE = previousProfile
  if (previousPiProfile === undefined) delete process.env.PI_PROFILE
  else process.env.PI_PROFILE = previousPiProfile
})

describe("models.yml provider config", () => {
  it("returns an empty snapshot when the file does not exist", async () => {
    const snapshot = await readModelProvidersSnapshot()
    assert.equal(snapshot.exists, false)
    assert.equal(snapshot.supported, true)
    assert.deepEqual(snapshot.providers, [])
    assert.equal(snapshot.path, resolveModelsConfigPath())
  })

  it("reads providers and models with the UI-facing shape", async () => {
    writeFileSync(resolveModelsConfigPath(), SAMPLE)
    const snapshot = await readModelProvidersSnapshot()
    assert.equal(snapshot.exists, true)
    assert.equal(snapshot.providers.length, 1)
    const provider = snapshot.providers[0]!
    assert.equal(provider.id, "demo")
    assert.equal(provider.name, "演示")
    assert.equal(provider.api, "openai-completions")
    assert.equal(provider.baseUrl, "https://api.example.com/v1")
    assert.equal(provider.apiKey, "sk-demo")
    const model = provider.models[0]!
    assert.equal(model.id, "demo-large")
    assert.equal(model.contextWindow, 200000)
    assert.equal(model.maxTokens, 65536)
    assert.deepEqual(model.input, ["text", "image"])
    assert.deepEqual(model.thinking, {
      mode: "effort",
      efforts: ["low", "high"],
      defaultLevel: "high",
    })
  })

  it("surfaces parse errors instead of throwing", async () => {
    writeFileSync(resolveModelsConfigPath(), "providers: [not: valid")
    const snapshot = await readModelProvidersSnapshot()
    assert.equal(snapshot.exists, true)
    assert.equal(snapshot.providers.length, 0)
    assert.ok(snapshot.error && snapshot.error.length > 0)
  })

  it("creates a provider, keeps unknown provider fields, and writes a backup", async () => {
    writeFileSync(resolveModelsConfigPath(), SAMPLE)
    const snapshot = await saveModelProvider({
      id: "demo",
      name: "演示",
      api: "openai-responses",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-new",
      authHeader: false,
      models: [
        { id: "demo-large", name: "Demo Large" },
        {
          id: "demo-small",
          name: "Demo Small",
          contextWindow: 64000,
          maxTokens: 16384,
          reasoning: false,
          input: ["text"],
        },
      ],
    })
    const provider = snapshot.providers.find(item => item.id === "demo")!
    assert.equal(provider.api, "openai-responses")
    assert.equal(provider.apiKey, "sk-new")
    assert.equal(provider.authHeader, false)
    assert.deepEqual(provider.models.map(model => model.id), ["demo-large", "demo-small"])
    assert.equal(provider.models[1]!.contextWindow, 64000)

    const text = readFileSync(resolveModelsConfigPath(), "utf8")
    assert.match(text, /supportsReasoningEffort: true/)
    assert.match(text, /reasoningContentField: reasoning_content/)
    assert.ok(readFileSync(`${resolveModelsConfigPath()}.bak`, "utf8").includes("sk-demo"))
  })

  it("renames a model via originalId and removes thinking when reasoning is disabled", async () => {
    writeFileSync(resolveModelsConfigPath(), SAMPLE)
    const snapshot = await saveModelProvider({
      id: "demo",
      name: "演示",
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      models: [
        {
          id: "demo-large-v2",
          originalId: "demo-large",
          name: "Demo Large v2",
          contextWindow: 300000,
          maxTokens: 32768,
          reasoning: false,
          input: ["text"],
        },
      ],
    })
    const models = snapshot.providers.find(item => item.id === "demo")!.models
    assert.deepEqual(models.map(model => model.id), ["demo-large-v2"])
    assert.equal(models[0]!.reasoning, false)
    assert.equal(models[0]!.thinking, undefined)
    assert.equal(models[0]!.input?.includes("image"), false)
  })

  it("deletes a provider", async () => {
    writeFileSync(resolveModelsConfigPath(), SAMPLE)
    const snapshot = await deleteModelProvider("demo")
    assert.deepEqual(snapshot.providers, [])
    assert.doesNotMatch(readFileSync(resolveModelsConfigPath(), "utf8"), /demo:/)
  })

  it("rejects saves when the existing file cannot be parsed", async () => {
    writeFileSync(resolveModelsConfigPath(), "providers: [not: valid")
    await assert.rejects(
      saveModelProvider({ id: "x", name: "X", baseUrl: "https://x.test", models: [] }),
      /解析失败/,
    )
  })

  it("falls back from /v1/models to /models and reports removed ids", async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/v1/models")) return new Response("nope", { status: 404 })
      return new Response(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    try {
      const result = await fetchModelProviderModels({
        baseUrl: "https://relay.test",
        api: "openai-completions",
        apiKey: "sk-x",
        knownModelIds: ["a-model", "gone-model"],
      })
      assert.deepEqual(calls, ["https://relay.test/v1/models", "https://relay.test/models"])
      assert.deepEqual(result.models, ["a-model", "b-model"])
      assert.deepEqual(result.removed, ["gone-model"])
      assert.equal(result.total, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("uses the anthropic auth header and a /v1 suffix directly", async () => {
    const originalFetch = globalThis.fetch
    let seenHeaders: Record<string, string> = {}
    let seenUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      seenHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ data: [{ id: "claude-x" }] }), { status: 200 })
    }) as typeof fetch
    try {
      const result = await fetchModelProviderModels({
        baseUrl: "https://anthropic.test/v1/",
        api: "anthropic-messages",
        apiKey: "sk-ant",
      })
      assert.equal(seenUrl, "https://anthropic.test/v1/models")
      assert.equal(seenHeaders["x-api-key"], "sk-ant")
      assert.equal(seenHeaders["anthropic-version"], "2023-06-01")
      assert.deepEqual(result.models, ["claude-x"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
