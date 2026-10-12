import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { OmpRpcSession } from "../packages/omp-worker/dist/omp/omp-session.js"

// 真实 OMP 只访问本地假模型，全部会话与配置隔离到临时目录。
const root = mkdtempSync(path.join(tmpdir(), "ompiui-subagent-runtime-"))
const agent = path.join(root, "agent")
const cwd = path.join(root, "workspace")
mkdirSync(agent)
mkdirSync(cwd)
process.env.PI_CODING_AGENT_DIR = agent
process.env.OMPIUI_DATA_DIR = path.join(root, "webui")
delete process.env.OMP_PROFILE
delete process.env.PI_PROFILE
delete process.env.PI_CODING_AGENT_SESSION_DIR
delete process.env.PI_CONFIG_FILES

let dispatched = false
let childRequests = 0
let activeChildren = 0
let maxActiveChildren = 0
const errors = []
let requests = 0
const server = createServer(async (request, response) => {
  try {
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    const tools = (input.tools ?? []).map(tool => tool.function?.name)
    requests += 1
    const child = tools.includes("yield")
    let delta
    if (child) {
      assert.ok(!tools.includes("task"), "a child must not have the task tool")
      childRequests += 1
      activeChildren += 1
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren)
      await new Promise(resolve => setTimeout(resolve, 150))
      activeChildren -= 1
      delta = { tool_calls: [{
        index: 0, id: `yield-${childRequests}`, type: "function",
        function: { name: "yield", arguments: JSON.stringify({ data: "Offline child completed" }) },
      }] }
    } else if (!dispatched && tools.includes("task")) {
      dispatched = true
      delta = { tool_calls: [{
        index: 0, id: "offline-ten-task", type: "function",
        function: { name: "task", arguments: JSON.stringify({
          i: "Run ten offline children",
          context: "This is an isolated offline runtime verification. Return a completion through yield.",
          tasks: Array.from({ length: 10 }, (_, index) => ({
            name: `OfflineChild${index}`, agent: "task", task: "Return an offline completion using yield.",
          })),
        }) },
      }] }
    } else {
      delta = { content: "All offline children completed" }
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = {
      id: "offline-runtime", object: "chat.completion.chunk", created: 1, model: "offline",
      choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
    }
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    response.write(`data: ${JSON.stringify({
      ...chunk, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(error)
    response.writeHead(500)
    response.end("Offline fixture failed")
  }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
writeFileSync(path.join(agent, "models.yml"), `providers:
  runtime-fixture:
    baseUrl: http://127.0.0.1:${server.address().port}/v1
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
writeFileSync(path.join(agent, "config.yml"), `modelRoles:
  default: runtime-fixture/offline
  task: runtime-fixture/offline
  smol: runtime-fixture/offline
task:
  batch: true
  maxConcurrency: 10
  maxRecursionDepth: 4
  maxRuntimeMs: 15000
async:
  enabled: false
`)
let runtime
const finished = new Set()
const crashes = []
try {
  runtime = await OmpRpcSession.open(cwd)
  runtime.onCrash(error => crashes.push(error))
  runtime.onPiEvent(event => {
    if (event.type === "message_end" && event.message?.stopReason === "error") {
      errors.push(new Error(event.message.errorMessage ?? "Offline model response failed"))
    }
    if (event.type === "message_end" && event.message?.role === "toolResult" && event.message.isError) {
      errors.push(event.message.content)
    }
    if (event.type === "tool_execution_end" && event.isError) errors.push(event.result)
  })
  runtime.onSubagentFrame(frame => {
    if (frame.kind === "lifecycle" && frame.payload?.status === "completed") finished.add(frame.payload.id)
  })
  await runtime.prompt("Start ten offline children and collect their results.")
  await runtime.waitForIdle()
  assert.deepEqual(errors, [])
  assert.deepEqual(crashes, [])
  assert.equal(finished.size, 10, `requests=${requests}, dispatched=${dispatched}, childRequests=${childRequests}`)
  assert.equal(childRequests, 10)
  assert.ok(maxActiveChildren > 1, "first-level children must still run concurrently")
  const state = await runtime.getState()
  assert.equal(state.isIdle, true)
  console.info(`PASS: ${finished.size} children completed; peak parallel model requests=${maxActiveChildren}; no child task tool; runtime idle`)
} finally {
  await runtime?.dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}ompiui-subagent-runtime-`))
  rmSync(root, { recursive: true, force: true })
}
