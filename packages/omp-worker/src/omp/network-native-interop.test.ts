import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { once } from "node:events"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { OmpRpcClient, unwrapResponse } from "./rpc-client.js"
import { OmpRpcSession } from "./omp-session.js"
import { OmpCatalog } from "./omp-catalog.js"

test("installed official OMP and UI share native sessions and continue writing in both directions", {
  skip: process.env.OMPIUI_TEST_NATIVE_OMP !== "1",
  timeout: 180_000,
}, async () => {
  const root = path.resolve(mkdtempSync(path.join(tmpdir(), "ompiui-native-network-")))
  const cwd = path.join(root, "project")
  const agent = path.join(root, "agent")
  mkdirSync(cwd)
  mkdirSync(agent)
  const endpoint = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
      id: "local-fixture", object: "chat.completion.chunk", created: 1, model: "local",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`
    res.end(chunk({ role: "assistant", content: "Local fixture reply." }, null) + chunk({}, "stop") + "data: [DONE]\n\n")
  })
  endpoint.listen(0, "127.0.0.1")
  await once(endpoint, "listening")
  const port = (endpoint.address() as { port: number }).port
  writeFileSync(path.join(agent, "models.yml"), JSON.stringify({ providers: {
    "network-fixture": { api: "openai-completions", apiKey: "local-fixture-key", baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [{ id: "local", name: "Local Fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }] },
  } }))
  writeFileSync(path.join(agent, "config.yml"), JSON.stringify({ modelRoles: { default: "network-fixture/local" } }))
  const keys = ["PI_CODING_AGENT_DIR", "OMP_AGENT_DIR", "OMPIUI_DATA_DIR", "OMPIUI_OMP_SESSION_DIRS", "OMP_PROFILE", "PI_PROFILE",
    "OPENAI_API_KEY", "OPENAI_BASE_URL"]
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.PI_CODING_AGENT_DIR = agent
  process.env.OMPIUI_DATA_DIR = path.join(root, "webui")
  for (const key of keys.filter(key => key !== "PI_CODING_AGENT_DIR" && key !== "OMPIUI_DATA_DIR")) delete process.env[key]
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1"
  const clients = new Set<OmpRpcClient>()
  const sessions = new Set<OmpRpcSession>()
  const bin = process.env.OMPI_OMP_BIN || "omp"
  const official = async (args: string[] = []) => {
    const client = new OmpRpcClient({ cwd, bin,
      args: [...args, "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--no-title"] })
    clients.add(client)
    await client.waitForReady()
    await client.request({ type: "negotiate_protocol", protocolVersion: 2 })
    return client
  }
  const state = async (client: OmpRpcClient) => {
    const data = unwrapResponse<JsonObject>(await client.request({ type: "get_state" }))!
    assert.equal(typeof data.sessionId, "string")
    assert.equal(typeof data.sessionFile, "string")
    return data as JsonObject & { sessionId: string; sessionFile: string }
  }
  const echo = async (client: OmpRpcClient, marker: string) => {
    unwrapResponse(await client.request({ type: "bash", command: `echo ${marker}` }))
  }
  const prompt = async (client: OmpRpcClient, message: string) => {
    unwrapResponse(await client.request({ type: "prompt", message }))
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await state(client)).isStreaming) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error("local fixture did not settle")
  }
  try {
    const terminal = await official()
    await prompt(terminal, "native-created")
    const terminalState = await state(terminal)
    await terminal.close()
    clients.delete(terminal)
    assert.ok(existsSync(terminalState.sessionFile))
    const catalog = new OmpCatalog()
    const before = readFileSync(terminalState.sessionFile)
    await catalog.previewSession(cwd, terminalState.sessionFile, { limit: 100 })
    assert.deepEqual(readFileSync(terminalState.sessionFile), before)
    const uiResume = await OmpRpcSession.open(cwd, terminalState.sessionFile, { bin })
    sessions.add(uiResume)
    assert.equal(uiResume.getSessionId(), terminalState.sessionId)
    await uiResume.bash("echo ui-continued-native")
    await uiResume.dispose()
    sessions.delete(uiResume)
    assert.match(readFileSync(terminalState.sessionFile, "utf8"), /ui-continued-native/)
    const terminalContinue = await official(["--continue"])
    assert.equal((await state(terminalContinue)).sessionId, terminalState.sessionId)
    await echo(terminalContinue, "native-resumed-ui")
    await terminalContinue.close()
    clients.delete(terminalContinue)

    const uiCreate = await OmpRpcSession.open(cwd, undefined, { bin })
    sessions.add(uiCreate)
    await uiCreate.prompt("ui-created")
    await uiCreate.waitForIdle()
    const uiId = uiCreate.getSessionId()
    const uiFile = uiCreate.getSessionFile()!
    assert.ok(path.resolve(uiFile).startsWith(path.join(agent, "sessions") + path.sep))
    await uiCreate.dispose()
    sessions.delete(uiCreate)
    const nativeResume = await official(["--continue"])
    assert.equal((await state(nativeResume)).sessionId, uiId)
    await echo(nativeResume, "native-continued-ui-created")
    await nativeResume.close()
    clients.delete(nativeResume)
    assert.match(readFileSync(uiFile, "utf8"), /native-continued-ui-created/)
    const latest = readFileSync(uiFile)
    const preview = await catalog.previewSession(cwd, uiFile, { limit: 100 }) as JsonObject
    const branch = preview.branch as JsonObject
    const items = branch.items as JsonObject[]
    const incremental = await catalog.previewSession(cwd, uiFile, {
      limit: 100, syncCursor: String(branch.syncCursor), beforeId: String(items[0]?.id),
    }) as JsonObject
    assert.deepEqual((incremental.branch as JsonObject).items, [])
    assert.deepEqual(readFileSync(uiFile), latest)
    console.log(JSON.stringify({ officialVersion: "installed", nativeToUi: true, uiToNative: true, readonlyPreview: true }))
  } finally {
    for (const session of sessions) await session.dispose()
    for (const client of clients) await client.close()
    endpoint.closeAllConnections()
    await new Promise<void>(resolve => endpoint.close(() => resolve()))
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep))
    rmSync(root, { recursive: true, force: true })
  }
})
