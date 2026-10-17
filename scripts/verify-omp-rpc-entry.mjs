import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { OmpRpcClient, unwrapResponse } from "../packages/omp-worker/dist/omp/rpc-client.js"

// 真实 OMP 入口验收：使用隔离目录和无持久化 RPC，不调用模型服务。
const root = mkdtempSync(path.join(tmpdir(), "ompiui rpc entry space-"))
const bins = process.argv.slice(2)
if (!bins.length) bins.push("omp")
try {
  for (const [index, bin] of bins.entries()) {
    const agent = path.join(root, `agent-${index}`)
    mkdirSync(agent)
    writeFileSync(path.join(agent, "models.yml"), JSON.stringify({
      providers: {
        "entry-fixture": {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "offline-entry-fixture",
          api: "openai-completions",
          models: [{
            id: "offline", name: "Offline", reasoning: false, input: ["text"],
            contextWindow: 128000, maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }))
    writeFileSync(path.join(agent, "config.yml"), JSON.stringify({
      modelRoles: { default: "entry-fixture/offline" },
    }))
    const client = new OmpRpcClient({
      cwd: root,
      bin,
      args: ["--no-session"],
      env: {
        PI_CODING_AGENT_DIR: agent,
        OMP_AGENT_DIR: undefined,
        OMP_PROFILE: undefined,
        PI_PROFILE: undefined,
        PI_CODING_AGENT_SESSION_DIR: undefined,
      },
    })
    try {
      await client.waitForReady()
      unwrapResponse(await client.request({ type: "negotiate_protocol", protocolVersion: 2 }))
      const state = unwrapResponse(await client.request({ type: "get_state" }))
      assert.ok(state && typeof state === "object")
      if (process.platform === "win32") assert.match(client.proc.spawnfile, /\.exe$/i)
      console.info(`PASS: RPC ready, protocol negotiation and state via ${bin}`)
      console.info(`Direct argv command: ${JSON.stringify(client.proc.spawnargs)}`)
    } finally {
      await client.close()
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
