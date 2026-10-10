import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

// 使用桌面壳相同的资源工作目录和编译后入口，验证实际产物而非开发服务器。
const realOmp = process.argv.includes("--real-omp")
const resources = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "dist-desktop")
const probe = createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const data = mkdtempSync(path.join(tmpdir(), "ompiui-packaged-shutdown-"))
const agent = path.join(data, "agent")
if (realOmp) {
  mkdirSync(agent)
  writeFileSync(path.join(agent, "models.yml"), `providers:
  shutdown-fixture:
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
  writeFileSync(path.join(agent, "config.yml"), "modelRoles:\n  default: shutdown-fixture/offline\n")
}
const child = spawn(path.join(resources, process.platform === "win32" ? "omp-worker.exe" : "omp-worker"),
  ["web", "--port", String(port)], {
    cwd: resources, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OMPIUI_DRIVER: realOmp ? "omp" : "mock", OMPIUI_AUTH_TOKEN: "offline-test-token", OMPIUI_DATA_DIR: data,
      ...(realOmp ? { OMP_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, OMP_PROFILE: "", PI_PROFILE: "", PI_CODING_AGENT_SESSION_DIR: "" } : {}),
    },
  })
const exited = once(child, "exit")
let output = ""
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", chunk => { output = `${output}${chunk}`.slice(-8_000) })
}
const url = `http://127.0.0.1:${port}`
const headers = { authorization: "Bearer offline-test-token", connection: "close" }
try {
  let healthy = false
  for (let i = 0; i < 100; i++) {
    try {
      const health = await fetch(`${url}/api/v1/host/health`, { headers, signal: AbortSignal.timeout(500) })
      healthy = health.status === 200 && (await health.json()).service === "ompiui-server"
      if (healthy) break
    } catch {}
    if (child.exitCode !== null) throw new Error(output)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(healthy, true, output)
  if (realOmp) {
    const opened = await fetch(`${url}/api/v1/pi/commands/session.open`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cwd: data }),
    })
    const body = await opened.text()
    assert.equal(opened.status, 200, `${body}\n${output}`)
  }
  const shutdown = await fetch(`${url}/api/v1/host/shutdown`, { method: "POST", headers })
  assert.equal(shutdown.status, 200)
  await shutdown.arrayBuffer()
  const [code] = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Shutdown did not exit: ${output}`)), realOmp ? 30_000 : 10_000).unref()),
  ])
  assert.equal(code, 0, output)
  await assert.rejects(fetch(`${url}/api/v1/host/health`, { headers, signal: AbortSignal.timeout(500) }))
  console.info(`PASS: packaged ${realOmp ? "live OMP runtime" : "health"} -> shutdown -> exit code 0 -> port released`)
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      } catch {
        // 截止与正常退出可能同时发生，清理失败不能遮蔽原始验收结果。
      }
    }
    else child.kill("SIGKILL")
    await exited
  }
  rmSync(data, { recursive: true, force: true })
}
