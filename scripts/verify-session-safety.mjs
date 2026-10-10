import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { OmpRpcSession } from "../packages/omp-worker/dist/omp/omp-session.js"
import { OmpCatalog } from "../packages/omp-worker/dist/omp/omp-catalog.js"
import { OmpRpcClient, unwrapResponse } from "../packages/omp-worker/dist/omp/rpc-client.js"

// 真实 OMP 离线验收：本地假服务提供一条回复用于落盘，不调用真实模型服务。
const root = mkdtempSync(path.join(tmpdir(), "ompiui-session-safety-"))
const agent = path.join(root, "agent")
const cwd = path.join(root, "work space")
mkdirSync(agent)
mkdirSync(cwd)
process.env.OMP_AGENT_DIR = agent
process.env.PI_CODING_AGENT_DIR = agent
process.env.OMPIUI_DATA_DIR = path.join(root, "webui")
delete process.env.OMP_PROFILE
delete process.env.PI_PROFILE
delete process.env.PI_CODING_AGENT_SESSION_DIR
const fixtureServer = createServer((request, response) => {
  request.resume()
  response.writeHead(200, { "content-type": "text/event-stream" })
  const chunk = delta => ({
    id: "offline-response", object: "chat.completion.chunk", created: 1, model: "offline",
    choices: [{ index: 0, delta, finish_reason: null }],
  })
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "Persisted offline safety reply" }))}\n\n`)
  response.write(`data: ${JSON.stringify({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
  response.end("data: [DONE]\n\n")
})
await new Promise(resolve => fixtureServer.listen(0, "127.0.0.1", resolve))
const fixturePort = fixtureServer.address().port
writeFileSync(path.join(agent, "models.yml"), `providers:
  safety-fixture:
    baseUrl: http://127.0.0.1:${fixturePort}/v1
    apiKey: sk-offline-fixture
    api: openai-completions
    models:
      - id: offline
        name: Offline
        reasoning: false
        input: [text]
        contextWindow: 128000
        maxTokens: 4096
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
`)
writeFileSync(path.join(agent, "config.yml"), "modelRoles:\n  default: safety-fixture/offline\nautoResume: true\n")
const catalog = new OmpCatalog()
let runtime
let terminal
try {
  runtime = await OmpRpcSession.open(cwd)
  await runtime.prompt("Offline safety verification")
  await runtime.waitForIdle()
  await runtime.setSessionName("Shared native safety fixture")
  const id = runtime.getSessionId()
  const file = runtime.getSessionFile()
  assert.ok(file && file.startsWith(path.join(agent, "sessions")))
  await runtime.dispose()
  runtime = undefined
  const bytes = readFileSync(file)
  assert.ok((await catalog.listSessions(cwd)).some(item => item.id === id))
  await catalog.previewSessionById(id)
  await catalog.readSession(id, "branch.get")
  assert.deepEqual(readFileSync(file), bytes)

  // 控制 RPC 无持久化：即使全局配置打开自动恢复，也不碰已有原会话。
  await catalog.control.acquire()
  await catalog.control.close()
  assert.deepEqual(readFileSync(file), bytes)

  // 官方 CLI 恢复同一身份；只读取，无模型请求。
  terminal = new OmpRpcClient({ cwd, args: ["--resume", file], protectSession: true })
  await terminal.waitForReady()
  const state = unwrapResponse(await terminal.request({ type: "get_state" }))
  assert.equal(state.sessionId, id)
  await terminal.close()
  terminal = undefined

  runtime = await OmpRpcSession.open(cwd, file)
  assert.equal(runtime.getSessionId(), id)
  await runtime.setSessionName("Continued shared fixture")
  await runtime.dispose()
  runtime = undefined
  const backups = path.join(root, "webui", "session-backups")
  assert.ok(readdirSync(backups).length > 0)

  // 新建不能因 autoResume=true 偷偷接管前一个会话。
  runtime = await OmpRpcSession.open(cwd)
  assert.notEqual(runtime.getSessionId(), id)
  await runtime.dispose()
  runtime = undefined
  console.info("PASS: native directory, same-id resume, byte-identical previews, ephemeral control, takeover backup, no auto-resume")
} finally {
  await runtime?.dispose()
  await terminal?.close()
  await catalog.control.close()
  fixtureServer.closeAllConnections()
  await new Promise(resolve => fixtureServer.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
