import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { OmpRpcSession } from "../packages/omp-worker/dist/omp/omp-session.js"
import { OmpCatalog } from "../packages/omp-worker/dist/omp/omp-catalog.js"
import { OmpRpcClient, unwrapResponse } from "../packages/omp-worker/dist/omp/rpc-client.js"
import { managedSessionDirectory } from "../packages/omp-worker/dist/omp/managed-sessions.js"
import { nativeOmpSessionDirectory } from "../packages/omp-worker/dist/omp/omp-directories.js"
import { detectOmpVersion } from "../packages/omp-worker/dist/omp/omp-version.js"

// Windows 上退出的 OMP 子进程可能还短暂持有 agent.db，删除临时目录会 EBUSY。
// 清理不属于验收结论：短暂重试后仍失败只提示，不把已经通过的断言判成失败。
async function removeTempRoot(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch (error) {
      const retryable = error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "ENOTEMPTY"
      if (!retryable || attempt === 9) {
        console.warn(`WARN: kept temporary verification directory ${target}: ${error?.message ?? error}`)
        return
      }
      await delay(200)
    }
  }
}

// 真实 OMP 离线验收：本地假服务提供一条回复用于落盘，不调用真实模型服务。
const root = mkdtempSync(path.join(tmpdir(), "ompiui-session-safety-"))
const agent = path.join(root, "agent")
const cwd = path.join(root, "work space")
mkdirSync(agent)
mkdirSync(cwd)
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
async function sendTerminalMessage(client, message) {
  unwrapResponse(await client.request({ type: "prompt", message }))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = unwrapResponse(await client.request({ type: "get_state" }))
    if (state.isSettled === true) return
    await delay(100)
  }
  throw new Error("Offline OMP turn did not settle")
}

function assertUnchanged(file, bytes, modified) {
  assert.deepEqual(readFileSync(file), bytes)
  assert.equal(statSync(file).mtimeMs, modified)
}

try {
  const ompVersion = await detectOmpVersion()
  assert.ok(ompVersion, "Cannot determine the OMP version under test")
  // 官方 OMP 创建原生会话并保持打开，UI 只能浏览它的磁盘历史。
  terminal = new OmpRpcClient({ cwd })
  await terminal.waitForReady()
  await sendTerminalMessage(terminal, "Official terminal creates this session")
  const initial = unwrapResponse(await terminal.request({ type: "get_state" }))
  const id = initial.sessionId
  const file = initial.sessionFile
  assert.ok(file && file.startsWith(path.join(agent, "sessions")))
  let bytes = readFileSync(file)
  let modified = statSync(file).mtimeMs
  const listed = await catalog.listSessions(cwd)
  assert.ok(listed.some(item => item.id === id), JSON.stringify({
    message: "Official session missing from UI catalog",
    ompVersion, cwd, id, file,
    sessionHeader: bytes.toString("utf8").split("\n").map(line => {
      try {
        const entry = JSON.parse(line)
        return entry.type === "session" ? { id: entry.id, cwd: entry.cwd } : undefined
      } catch { return undefined }
    }).find(Boolean),
    sessionFiles: readdirSync(path.join(agent, "sessions"), { recursive: true }),
    listed: listed.map(item => ({ id: item.id, cwd: item.cwd, path: item.path })),
  }))
  await catalog.previewSessionById(id)
  for (const query of ["state.get", "branch.get", "entries.get", "tree.get"]) {
    await catalog.readSession(id, query)
  }
  assertUnchanged(file, bytes, modified)

  // 控制 RPC 无持久化：即使全局配置打开自动恢复，也不碰已有原会话。
  await catalog.control.acquire()
  await catalog.control.close()
  assertUnchanged(file, bytes, modified)

  await sendTerminalMessage(terminal, "Terminal adds newer history during UI browsing")
  bytes = readFileSync(file)
  modified = statSync(file).mtimeMs
  await catalog.previewSessionById(id)
  assertUnchanged(file, bytes, modified)
  await terminal.close()
  terminal = undefined

  // UI 主动继续同一原文件，保留终端在浏览期间写入的新消息。
  runtime = await OmpRpcSession.open(cwd, file)
  assert.equal(runtime.getSessionId(), id)
  const sendStarted = performance.now()
  await runtime.sendUserMessage("UI explicitly continues the official session")
  console.info(`UI message acceptance: ${Math.round(performance.now() - sendStarted)}ms`)
  await runtime.waitForIdle()
  await runtime.dispose()
  runtime = undefined
  assert.match(readFileSync(file, "utf8"), /Terminal adds newer history during UI browsing/)
  assert.match(readFileSync(file, "utf8"), /UI explicitly continues the official session/)
  const backups = path.join(root, "webui", "session-backups")
  assert.ok(readdirSync(backups).length > 0)

  terminal = new OmpRpcClient({ cwd, args: ["--resume", file] })
  await terminal.waitForReady()
  assert.equal(unwrapResponse(await terminal.request({ type: "get_state" })).sessionId, id)
  await sendTerminalMessage(terminal, "Official terminal continues after UI")
  await terminal.close()
  terminal = undefined
  assert.match(readFileSync(file, "utf8"), /Official terminal continues after UI/)

  // 新建不能因 autoResume=true 偷偷接管前一个会话。
  runtime = await OmpRpcSession.open(cwd)
  const uiId = runtime.getSessionId()
  assert.notEqual(uiId, id)
  await runtime.sendUserMessage("UI creates a new native session")
  await runtime.waitForIdle()
  const uiFile = runtime.getSessionFile()
  await runtime.dispose()
  runtime = undefined
  assert.ok(uiFile.startsWith(path.join(agent, "sessions")))
  terminal = new OmpRpcClient({ cwd, args: ["--resume", uiId] })
  await terminal.waitForReady()
  assert.equal(unwrapResponse(await terminal.request({ type: "get_state" })).sessionId, uiId)
  await sendTerminalMessage(terminal, "Official terminal continues UI-created session")
  await terminal.close()
  terminal = undefined
  assert.match(readFileSync(uiFile, "utf8"), /Official terminal continues UI-created session/)

  // 复现旧版私有会话：更新后继续旧路径不会自动进入官方目录。
  terminal = new OmpRpcClient({ cwd, args: ["--session-dir", managedSessionDirectory(cwd)], applyRuntimePolicy: true })
  await terminal.waitForReady()
  await sendTerminalMessage(terminal, "Legacy UI session before migration")
  const legacy = unwrapResponse(await terminal.request({ type: "get_state" }))
  await terminal.close()
  terminal = undefined
  const legacyBytes = readFileSync(legacy.sessionFile)
  // 先用官方实际创建的目录对照，发现上游编码变化时在迁移前失败。
  assert.equal(nativeOmpSessionDirectory(cwd, ompVersion), path.dirname(uiFile), "OMP native directory contract changed")
  const migrationRun = spawnSync(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./migrate-legacy-sessions.ts", import.meta.url)), "--cwd", cwd, "--apply",
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true })
  assert.equal(migrationRun.status, 0, migrationRun.stderr || migrationRun.error?.message)
  const migration = JSON.parse(migrationRun.stdout)
  assert.equal(migration.ompVersion, ompVersion)
  assert.equal(migration.destination, path.dirname(uiFile))
  const migratedFile = path.join(migration.destination, path.basename(legacy.sessionFile))
  assert.deepEqual(readFileSync(migratedFile), legacyBytes)
  assert.equal((await new OmpCatalog().listSessions(cwd)).filter(item => item.id === legacy.sessionId).length, 1)

  // 用 ID 恢复验证官方发现能力，而不是用绝对路径绕过官方目录查找。
  terminal = new OmpRpcClient({ cwd, args: ["--resume", legacy.sessionId] })
  await terminal.waitForReady()
  assert.equal(unwrapResponse(await terminal.request({ type: "get_state" })).sessionId, legacy.sessionId)
  await sendTerminalMessage(terminal, "Terminal continues migrated legacy session")
  await terminal.close()
  terminal = undefined
  runtime = await OmpRpcSession.open(cwd, legacy.sessionFile)
  assert.equal(runtime.getSessionId(), legacy.sessionId)
  await runtime.sendUserMessage("UI continues migrated session through its saved old path")
  await runtime.waitForIdle()
  await runtime.dispose()
  runtime = undefined
  assert.match(readFileSync(migratedFile, "utf8"), /Terminal continues migrated legacy session/)
  assert.match(readFileSync(migratedFile, "utf8"), /UI continues migrated session through its saved old path/)
  assert.deepEqual(readFileSync(legacy.sessionFile), readFileSync(migratedFile))
  console.info("PASS: legacy migration, official ID discovery, old-path continuation, one shared history")
  console.info("PASS: read-only browsing with official OMP open, unchanged bytes and mtime, bidirectional native continuation, ephemeral control, backup, no auto-resume")
} finally {
  await runtime?.dispose()
  await terminal?.close()
  await catalog.control.close()
  fixtureServer.closeAllConnections()
  await new Promise(resolve => fixtureServer.close(resolve))
  await removeTempRoot(root)
}
