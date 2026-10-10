import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

// 使用桌面壳相同的资源工作目录和编译后入口，验证实际产物而非开发服务器。
const resources = path.resolve(process.argv[2] ?? "dist-desktop")
const probe = createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const data = mkdtempSync(path.join(tmpdir(), "ompiui-packaged-shutdown-"))
const child = spawn(path.join(resources, process.platform === "win32" ? "omp-worker.exe" : "omp-worker"),
  ["web", "--port", String(port)], {
    cwd: resources, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OMPIUI_DRIVER: "mock", OMPIUI_AUTH_TOKEN: "offline-test-token", OMPIUI_DATA_DIR: data },
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
  const shutdown = await fetch(`${url}/api/v1/host/shutdown`, { method: "POST", headers })
  assert.equal(shutdown.status, 200)
  await shutdown.arrayBuffer()
  const [code] = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Shutdown did not exit: ${output}`)), 10_000).unref()),
  ])
  assert.equal(code, 0, output)
  await assert.rejects(fetch(`${url}/api/v1/host/health`, { headers, signal: AbortSignal.timeout(500) }))
  console.info("PASS: packaged health -> immediate shutdown -> exit code 0 -> port released")
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    else child.kill("SIGKILL")
    await exited
  }
  rmSync(data, { recursive: true, force: true })
}
