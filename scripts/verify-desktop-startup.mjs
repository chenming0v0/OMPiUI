import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { PROTOCOL_VERSION } from "@ompiui/protocol"

const args = process.argv.slice(2).filter(arg => !arg.startsWith("--"))
const resources = path.resolve(args[0] ?? "dist-desktop")
const workspace = args[1] ? path.resolve(args[1]) : undefined
const hostConfig = process.argv.includes("--host-config")
const probe = createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const data = mkdtempSync(path.join(tmpdir(), "ompiui-packaged-startup-"))
const agent = path.join(data, "agent")
mkdirSync(agent)
const watchedRoot = path.join(data, "workspace")
mkdirSync(watchedRoot)
writeFileSync(path.join(agent, "models.yml"), `providers:
  startup-fixture:
    baseUrl: http://127.0.0.1:9/v1
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
const child = spawn(path.join(resources, process.platform === "win32" ? "omp-worker.exe" : "omp-worker"),
  ["web", "--port", String(port)], {
    cwd: resources, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, OMPIUI_DRIVER: "omp", OMPIUI_AUTH_TOKEN: "offline-test-token",
      OMPIUI_DATA_DIR: data,
      ...(hostConfig ? {} : {
        OMP_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
        OMP_PROFILE: "", PI_PROFILE: "", PI_CODING_AGENT_SESSION_DIR: "",
      }),
    },
  })
const exited = once(child, "exit")
let output = ""
let socket
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", chunk => { output = `${output}${chunk}`.slice(-8_000) })
}
const url = `http://127.0.0.1:${port}`
const headers = { authorization: "Bearer offline-test-token", connection: "close" }
async function request(endpoint, body, timeout = 5_000) {
  const response = await fetch(`${url}/api/v1/${endpoint}`, {
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  })
  const result = await response.json()
  assert.equal(response.status, 200, `${endpoint}: ${JSON.stringify(result)}\n${output}`)
  return result
}
try {
  let healthy = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      healthy = (await request("host/health", undefined, 500)).ok === true
      if (healthy) break
    } catch {}
    if (child.exitCode !== null) throw new Error(output)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(healthy, true, output)
  console.info("PASS: packaged server started")
  await request("pi/registry", undefined, 15_000)
  console.info("PASS: real OMP handshake and registry")
  // 模型列表比握手大得多，必须同时验证传输期间 HTTP 仍可响应。
  const models = request("pi/commands/models.list", {}, 15_000)
  await request("host/health")
  const result = await models
  assert.ok(Array.isArray(result.data))
  console.info(`PASS: models.list returned ${result.data.length} models`)
  const events = []
  socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, { headers })
  await once(socket, "open")
  socket.on("message", raw => {
    const message = JSON.parse(String(raw))
    if (message.channel === "event") events.push(message.event)
  })
  socket.send(JSON.stringify({
    type: "subscribe", protocolVersion: PROTOCOL_VERSION,
    streams: [{ kind: "workspace", id: watchedRoot }],
  }))
  await request("host/commands/workspaces.watch", { workspacePath: watchedRoot })
  async function waitForEvent(predicate) {
    const deadline = Date.now() + 10_000
    while (!events.some(predicate)) {
      if (Date.now() >= deadline) throw new Error(`Workspace event did not arrive: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 50))
      await request("host/health", undefined, 2_000)
    }
  }
  await waitForEvent(event => event.channel === "workspace.files" && event.payload.rescan)
  events.length = 0
  writeFileSync(path.join(watchedRoot, "created.txt"), "fixture")
  await waitForEvent(event => event.channel === "workspace.files" &&
    event.payload.changes.some(change => change.path === "created.txt" && change.kind === "created"))
  assert.ok(events.some(event => event.channel === "workspace.git"))
  await request("host/commands/workspaces.close", { workspacePath: watchedRoot })
  console.info("PASS: packaged watcher delivered file and Git events")
  if (workspace) {
    await request("host/commands/workspaces.watch", { workspacePath: workspace })
    console.info("PASS: workspace watch requested")
  }
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    await request("host/health", undefined, 2_000)
  }
  console.info("PASS: health stayed responsive after startup")
  const disconnected = once(socket, "close")
  socket.close()
  await disconnected
  await request("host/shutdown", {})
  const [code] = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Shutdown did not exit: ${output}`)), 15_000).unref()),
  ])
  assert.equal(code, 0, output)
} finally {
  socket?.terminate()
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      } catch {}
    } else child.kill("SIGKILL")
    await exited
  }
  // 仅清理本次 mkdtemp 创建的隔离目录，不接触用户配置和会话。
  rmSync(data, { recursive: true, force: true })
}
