import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { OmpRpcSession } from "../packages/omp-worker/src/omp/omp-session.ts"
import { OmpRpcClient, unwrapResponse } from "../packages/omp-worker/src/omp/rpc-client.ts"
import { resolveOmpCommand } from "../packages/omp-worker/src/omp/omp-command.ts"
import { appendTranscriptEvent } from "../packages/app/src/omp/ompSubagentTranscript.ts"

// Run with node --import tsx. A deterministic local provider drives real native
// tool execution; all configuration, projects and native transcripts are isolated.
const root = mkdtempSync(path.join(tmpdir(), "ompiui-subagent-runtime-"))
const agent = path.join(root, "agent")
const cwd = path.join(root, "workspace")
mkdirSync(agent)
mkdirSync(cwd)
process.env.HOME = root
process.env.USERPROFILE = root
process.env.XDG_CONFIG_HOME = path.join(root, "xdg-config")
process.env.XDG_DATA_HOME = path.join(root, "xdg-data")
process.env.XDG_STATE_HOME = path.join(root, "xdg-state")
process.env.XDG_CACHE_HOME = path.join(root, "xdg-cache")
process.env.PI_CODING_AGENT_DIR = agent
process.env.OMPIUI_DATA_DIR = path.join(root, "webui")
delete process.env.OMP_PROFILE
delete process.env.PI_PROFILE
delete process.env.PI_CODING_AGENT_SESSION_DIR
delete process.env.PI_CONFIG_FILES
delete process.env.OMP_AGENT_DIR
delete process.env.PI_CONFIG_DIR

let dispatched = false
let childRequests = 0
let activeChildren = 0
let maxActiveChildren = 0
const errors = []
let requests = 0
const childText = `LIVE_CHILD_OUTPUT\n${Array.from({ length: 400 }, (_, index) =>
  `${index}: ${createHash("sha256").update(String(index)).digest("hex")}`).join("\n")}\nFINAL_CHILD_OUTPUT`
const streamedChildren = new Set()
const server = createServer(async (request, response) => {
  try {
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    const tools = (input.tools ?? []).map(tool => tool.function?.name)
    const requestIndex = ++requests
    const child = tools.includes("yield")
    const childIndex = child ? JSON.stringify(input.messages).match(/Offline fixture child index: (\d+)/)?.[1] : undefined
    const streamText = child && !streamedChildren.has(childIndex)
    let delta
    if (child) {
      assert.ok(!tools.includes("task"), "a child must not have the task tool")
      childRequests += 1
      activeChildren += 1
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren)
      await new Promise(resolve => setTimeout(resolve, 50))
      activeChildren -= 1
      if (streamText) {
        streamedChildren.add(childIndex)
        delta = { content: childText }
      } else delta = { tool_calls: [{
        index: 0, id: `yield-${childIndex}`, type: "function",
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
            name: `OfflineChild${index}`, agent: "task", task: `Offline fixture child index: ${index}. Return an offline completion using yield.`,
          })),
        }) },
      }] }
    } else {
      delta = { content: "All offline children completed" }
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = {
      id: `offline-runtime-${requestIndex}`, object: "chat.completion.chunk", created: 1, model: "offline",
      choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
    }
    if (streamText) {
      response.write(`data: ${JSON.stringify({
        ...chunk, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`)
      for (let offset = 0; offset < childText.length; offset += 2000) {
        response.write(`data: ${JSON.stringify({
          ...chunk, choices: [{ index: 0, delta: { content: childText.slice(offset, offset + 2000) }, finish_reason: null }],
        })}\n\n`)
        await new Promise(resolve => setTimeout(resolve, 4))
      }
    } else {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
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
        maxTokens: 32768
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
`)
writeFileSync(path.join(agent, "config.yml"), `modelRoles:
  default: runtime-fixture/offline
  task: runtime-fixture/offline
  smol: runtime-fixture/offline
task:
  batch: true
  maxConcurrency: 10
  maxRecursionDepth: 1
  structured: true
  maxRuntimeMs: 30000
async:
  enabled: false
`)
let runtime
const finished = new Set()
const crashes = []
const transcripts = new Map()
const liveChildren = new Set()
let largestSubagentFrame = 0
let subagentFrames = 0
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
    largestSubagentFrame = Math.max(largestSubagentFrame, Buffer.byteLength(JSON.stringify(frame)))
    subagentFrames += 1
    if (frame.kind === "event" && frame.payload?.event) {
      const id = frame.payload.id
      const items = appendTranscriptEvent(frame.payload.event, transcripts.get(id) ?? [])
      transcripts.set(id, items)
      if (!finished.has(id) && items.some(item => item.streaming && item.text.includes("LIVE_CHILD_OUTPUT"))) {
        liveChildren.add(id)
      }
    }
    if (frame.kind === "lifecycle" && frame.payload?.status === "completed") finished.add(frame.payload.id)
  })
  await runtime.prompt("Start ten offline children and collect their results.")
  await runtime.waitForIdle()
  if (finished.size !== 10) {
    const state = await runtime.getState()
    console.info(JSON.stringify({ subagentStatuses: state.subagents?.map(run => ({ id: run.id, status: run.status, tools: run.progress?.recentTools })) }))
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(crashes, [])
  assert.equal(finished.size, 10, `requests=${requests}, dispatched=${dispatched}, childRequests=${childRequests}`)
  assert.equal(childRequests, 20)
  assert.ok(maxActiveChildren > 1, "first-level children must still run concurrently")
  assert.equal(liveChildren.size, 10, "every child must render output before completion")
  for (const id of finished) {
    const items = transcripts.get(id) ?? []
    assert.ok(items.some(item => item.kind === "assistant" && item.text === childText),
      `${id}: chunked output must reach the UI decoder without loss; ${JSON.stringify(items.map(item => ({
        kind: item.kind, length: item.text.length, offset: item.textOffset,
        prefix: item.text.slice(0, 40), suffix: item.text.slice(-60), tool: item.toolName,
      })))}`)
    assert.ok(items.some(item => item.kind === "tool" && item.toolName === "yield" && item.toolStatus === "completed"),
      `${id}: final tool status must reach the UI`)
  }
  assert.ok(largestSubagentFrame < 50000, `large subagent frame: ${largestSubagentFrame}`)
  const state = await runtime.getState()
  assert.equal(state.isIdle, true)
  console.info(`PASS: ${finished.size} children completed; peak parallel model requests=${maxActiveChildren}; no child task tool; runtime idle`)
  console.info(`PASS: ${liveChildren.size} live UI transcripts; ${subagentFrames} frames; largest frame=${largestSubagentFrame} bytes; full replies and tool states restored`)
} finally {
  await runtime?.dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}ompiui-subagent-runtime-`))
  rmSync(root, { recursive: true, force: true })
}

// #372: compare the managed rpc-ui path to the same official CLI in RPC mode.
// This drives actual task/yield tools, not mocked worker responses. Negative
// depth is unlimited natively; the provider stops deliberately at level four.
const invocation = resolveOmpCommand()
console.info(`Native runtime: ${execFileSync(invocation.command, [...invocation.args, "--version"], { encoding: "utf8" }).trim()}`)
for (const depth of [0, 1, 2, 3, -1]) {
  for (const scope of ["global", "project"]) {
    const native = await verifyRecursion(depth, scope, false)
    const managed = await verifyRecursion(depth, scope, true)
    assert.deepEqual(managed.schemas, native.schemas, `${scope} depth=${depth}: native/managed provider schemas`)
    assert.equal(managed.children, native.children)
    console.info(`PASS: ${scope} depth=${depth}; native/managed children=${managed.children}; provider schema levels=${managed.schemas.map(item => `${item.level}:${item.task ? "task" : "no-task"}`).join(",")}; live=${managed.live}; parent links/transcripts/config unchanged`)
  }
}

async function verifyRecursion(depth, scope, managed) {
  const fixture = mkdtempSync(path.join(tmpdir(), "ompiui-recursion-runtime-"))
  const agentDir = path.join(fixture, "agent")
  const workspace = path.join(fixture, "workspace")
  mkdirSync(agentDir)
  mkdirSync(path.join(workspace, ".omp"), { recursive: true })
  for (const key of ["OMP_PROFILE", "PI_PROFILE", "OMP_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CONFIG_FILES", "PI_CONFIG_DIR"]) delete process.env[key]
  process.env.HOME = fixture
  process.env.USERPROFILE = fixture
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.OMPIUI_DATA_DIR = path.join(fixture, "ui")
  for (const kind of ["CONFIG", "DATA", "STATE", "CACHE"]) process.env[`XDG_${kind}_HOME`] = path.join(fixture, `xdg-${kind.toLowerCase()}`)
  const maximum = depth < 0 ? 4 : depth
  const nodes = new Map()
  const starts = new Map()
  const finished = new Set()
  const live = new Set()
  const progress = new Set()
  const transcripts = new Map()
  const failures = []
  let active = 0
  let peak = 0
  const provider = createServer(async (request, response) => {
    try {
      let body = ""
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      const userText = input.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).join("\n")
      const marker = [...userText.matchAll(/RECURSION_LEVEL=(\d+); NODE=(\w+)/g)].at(-1)
      const tools = input.tools ?? []
      const task = tools.find(tool => tool.function?.name === "task")
      let delta = { content: "Offline fixture title" }
      let output
      if (marker && (Number(marker[1]) === 0 ? tools.length > 0 : tools.some(tool => tool.function?.name === "yield"))) {
        const level = Number(marker[1])
        const node = marker[2]
        const expected = depth < 0 || level < depth
        assert.equal(Boolean(task), expected, `${scope} depth=${depth} ${node}: task tool availability`)
        if (task) assert.ok(task.function.parameters?.properties?.tasks, `${node}: real task schema`)
        const record = nodes.get(node) ?? { level, requests: 0, task: Boolean(task), schema: task?.function.parameters ?? null }
        nodes.set(node, record)
        record.requests += 1
        if (expected && level < maximum && record.requests === (level === 0 ? 1 : 2)) {
          const names = level === 0 ? ["BranchA", "BranchB"] : [`${node}Next`]
          delta = { tool_calls: [{
            index: 0, id: `task-${node}`, type: "function",
            function: { name: "task", arguments: JSON.stringify({
              i: "Delegate recursion fixture", context: "Isolated recursion acceptance. Complete through yield.",
              tasks: names.map(name => ({ name, task: `RECURSION_LEVEL=${level + 1}; NODE=${name}. Complete the isolated fixture through yield.` })),
            }) },
          }] }
        } else if (level > 0 && record.requests === 1) {
          output = `LIVE_RECURSION_${node}\nFINAL_RECURSION_${node}`
          delta = { content: output }
        } else if (level > 0) {
          assert.ok(tools.some(tool => tool.function?.name === "yield"), `${node}: structured completion tool`)
          delta = { tool_calls: [{ index: 0, id: `yield-${node}`, type: "function", function: {
            name: "yield", arguments: JSON.stringify({ data: `COMPLETED_RECURSION_${node}` }),
          } }] }
        } else delta = { content: "Recursion fixture completed" }
      }
      active += 1
      peak = Math.max(peak, active)
      response.writeHead(200, { "content-type": "text/event-stream" })
      const send = (part, finish = null) => response.write(`data: ${JSON.stringify({
        id: "recursion-fixture", object: "chat.completion.chunk", created: 1, model: "offline",
        choices: [{ index: 0, delta: part, finish_reason: finish }],
        ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
      })}\n\n`)
      send({ role: "assistant" })
      if (output) {
        send({ content: output.slice(0, output.indexOf("\n") + 1) })
        await new Promise(resolve => setTimeout(resolve, 100))
        send({ content: output.slice(output.indexOf("\n") + 1) })
      } else send(delta)
      send({}, delta.tool_calls ? "tool_calls" : "stop")
      response.end("data: [DONE]\n\n")
      active -= 1
    } catch (error) {
      failures.push(error)
      response.writeHead(500)
      response.end("Recursion provider assertion failed")
    }
  })
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  const modelsFile = path.join(agentDir, "models.yml")
  const globalFile = path.join(agentDir, "config.yml")
  const projectFile = path.join(workspace, ".omp", "config.yml")
  writeFileSync(modelsFile, `providers:\n  recursion-fixture:\n    baseUrl: http://127.0.0.1:${provider.address().port}/v1\n    apiKey: sk-isolated\n    api: openai-completions\n    models:\n      - id: offline\n        name: Offline\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 32768\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`)
  writeFileSync(globalFile, `modelRoles:\n  default: recursion-fixture/offline\n  task: recursion-fixture/offline\n  smol: recursion-fixture/offline\ntask:\n  batch: true\n  structured: true\n  maxConcurrency: 2\n  maxRecursionDepth: ${scope === "global" ? depth : depth === 0 ? 3 : 0}\n  maxRuntimeMs: 30000\nasync:\n  enabled: false\nautoResume: false\n`)
  writeFileSync(projectFile, scope === "project" ? `task:\n  maxRecursionDepth: ${depth}\n` : "{}\n")
  const originals = new Map([modelsFile, globalFile, projectFile].map(file => [file, readFileSync(file, "utf8")]))
  let session
  let client
  const frame = (kind, payload) => {
    const id = payload.id ?? payload.progress?.id
    if (kind === "lifecycle" && payload.status === "started") starts.set(payload.id, payload)
    if (kind === "lifecycle" && payload.status === "completed") finished.add(payload.id)
    if (kind === "progress" && payload.progress?.requests > 0) progress.add(id)
    if (kind === "progress" && starts.has(id) && typeof payload.task === "string") {
      starts.set(id, { ...starts.get(id), task: payload.task })
    }
    if (kind === "event" && payload.event) {
      const items = appendTranscriptEvent(payload.event, transcripts.get(payload.id) ?? [])
      transcripts.set(payload.id, items)
      if (!finished.has(payload.id) && items.some(item => item.streaming && item.text.includes("LIVE_RECURSION_"))) live.add(payload.id)
    }
  }
  try {
    const cli = JSON.parse(execFileSync(invocation.command, [...invocation.args, "config", "get", "task.maxRecursionDepth", "--json"], { cwd: workspace, encoding: "utf8", timeout: 30000 }))
    assert.equal(cli.value, depth, `${scope}: official CLI effective depth`)
    if (managed) {
      session = await OmpRpcSession.open(workspace)
      session.onCrash(error => failures.push(error))
      session.onPiEvent(event => {
        if (event.type === "tool_execution_end" && event.isError) failures.push(event.result)
        if (event.type === "message_end" && event.message?.stopReason === "error") failures.push(event.message)
      })
      session.onSubagentFrame(event => frame(event.kind, event.payload))
      assert.equal((await session.getState()).activeTools.includes("task"), depth !== 0)
      await session.prompt("RECURSION_LEVEL=0; NODE=Root. Execute the recursion fixture.")
      await session.waitForIdle()
    } else {
      client = new OmpRpcClient({ cwd: workspace })
      client.on("protocolError", error => failures.push(error))
      client.on("frame", event => {
        if (event.type.startsWith("subagent_")) frame(event.type.slice(9), event.payload)
        if (event.type === "tool_execution_end" && event.isError) failures.push(event.result)
        if (event.type === "message_end" && event.message?.stopReason === "error") failures.push(event.message)
      })
      await client.waitForReady()
      unwrapResponse(await client.request({ type: "negotiate_protocol", protocolVersion: 2 }))
      unwrapResponse(await client.request({ type: "set_subagent_subscription", level: "events" }))
      assert.equal(unwrapResponse(await client.request({ type: "get_state" })).dumpTools.some(tool => tool.name === "task"), depth !== 0)
      unwrapResponse(await client.request({ type: "prompt", message: "RECURSION_LEVEL=0; NODE=Root. Execute the recursion fixture." }))
      const deadline = Date.now() + 120000
      while (true) {
        const state = unwrapResponse(await client.request({ type: "get_state" }))
        if (state.isSettled && nodes.get("Root")?.requests >= (maximum > 0 ? 2 : 1)) break
        assert.ok(Date.now() < deadline, "Native recursion did not settle")
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    assert.deepEqual(failures, [])
    assert.equal(nodes.size, 1 + maximum * 2, "Every permitted generation executed provider requests")
    assert.equal(finished.size, maximum * 2, "All real child tasks completed")
    assert.equal(starts.size, finished.size)
    assert.equal(live.size, finished.size, "Every generation has live preview before completion")
    assert.equal(progress.size, finished.size, "Every generation has request statistics")
    if (maximum > 0) assert.ok(peak > 1, "First-level concurrency remains available")
    for (const [id, start] of starts) {
      const marker = String(start.task).match(/RECURSION_LEVEL=(\d+); NODE=(\w+)/)
      assert.ok(marker, `${id}: task assignment marker`)
      const node = marker[2]
      const parent = Number(marker[1]) === 1 ? "Root" : node.slice(0, -4)
      assert.equal(start.parentToolCallId, `task-${parent}`, `${id}: native parent tool association`)
      assert.ok(path.resolve(start.sessionFile).startsWith(`${path.join(agentDir, "sessions")}${path.sep}`), `${id}: original native transcript path`)
      const disk = readFileSync(start.sessionFile, "utf8")
      assert.ok(disk.includes(`FINAL_RECURSION_${node}`), `${id}: real provider output on native disk`)
      assert.ok(disk.includes(`COMPLETED_RECURSION_${node}`), `${id}: structured result on native disk`)
      assert.ok((transcripts.get(id) ?? []).some(item => item.kind === "assistant" && item.text.includes(`FINAL_RECURSION_${node}`)), `${id}: live transcript decoder retains final text`)
    }
    for (const [file, original] of originals) assert.equal(readFileSync(file, "utf8"), original, `${file}: native config must remain byte-identical`)
    const schemas = []
    for (const level of [...new Set([...nodes.values()].map(node => node.level))].sort()) {
      const records = [...nodes.values()].filter(node => node.level === level)
      for (const record of records) assert.deepEqual(record.schema, records[0].schema, "Same-depth provider schemas")
      schemas.push({ level, task: records[0].task, schema: records[0].schema })
    }
    return { schemas, children: finished.size, live: live.size }
  } finally {
    await session?.dispose()
    await client?.close()
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    assert.ok(path.resolve(fixture).startsWith(`${path.resolve(tmpdir())}${path.sep}ompiui-recursion-runtime-`))
    rmSync(fixture, { recursive: true, force: true })
  }
}
