import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { parseWebArgs, resolveServerConfig, startOmpiUiServer } from "./start.ts"

const roots: string[] = []
const previousDriver = process.env.OMPIUI_DRIVER

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousDriver === undefined) delete process.env.OMPIUI_DRIVER
  else process.env.OMPIUI_DRIVER = previousDriver
})

test("server config validates ports and parses web flags", () => {
  const config = resolveServerConfig({}, { webRoot: null })
  assert.equal(config.host, "127.0.0.1")
  assert.equal(config.port, 8787)
  assert.equal(config.webRoot, null)
  assert.equal(config.publicBaseUrl, null)
  assert.throws(() => resolveServerConfig({ OMPIUI_PORT: "invalid" }, { webRoot: null }), /OMPIUI_PORT/)
  assert.deepEqual(parseWebArgs(["--host", "0.0.0.0", "--port=9000", "--api-only"]), {
    help: false,
    host: "0.0.0.0",
    port: 9000,
    webRoot: null,
  })
  assert.equal(parseWebArgs(["--public-base-url", "https://panel.example.com"]).publicBaseUrl, "https://panel.example.com")
  assert.throws(() => parseWebArgs(["--unknown"]), /unknown|requires/)
})

test("public base URL is normalized; invalid values are ignored", () => {
  // 结尾斜杠与首尾空白规范化
  const config = resolveServerConfig({ OMPIUI_PUBLIC_BASE_URL: " https://panel.example.com/ " }, { webRoot: null })
  assert.equal(config.publicBaseUrl, "https://panel.example.com")
  // 子路径反代保留路径
  const nested = resolveServerConfig({ OMPIUI_PUBLIC_BASE_URL: "https://omp.example.com/panel/" }, { webRoot: null })
  assert.equal(nested.publicBaseUrl, "https://omp.example.com/panel")
  // 显式 override（含禁用）优先于环境变量
  assert.equal(
    resolveServerConfig({ OMPIUI_PUBLIC_BASE_URL: "https://panel.example.com" }, { webRoot: null, publicBaseUrl: null }).publicBaseUrl,
    null,
  )
  assert.equal(
    resolveServerConfig({}, { webRoot: null, publicBaseUrl: "http://localhost:9999" }).publicBaseUrl,
    "http://localhost:9999",
  )
  // 非法输入不炸启动：告警 + 视为未设置
  for (const invalid of ["not a url", "ftp://panel.example.com", "javascript:alert(1)"]) {
    assert.equal(resolveServerConfig({ OMPIUI_PUBLIC_BASE_URL: invalid }, { webRoot: null }).publicBaseUrl, null)
  }
  assert.equal(resolveServerConfig({}, { webRoot: null }).publicBaseUrl, null)
})

test("one server provides the web app and authenticated API on the same port", async () => {
  process.env.OMPIUI_DRIVER = "mock"
  const webRoot = mkdtempSync(join(tmpdir(), "ompiui-start-web-"))
  roots.push(webRoot)
  writeFileSync(join(webRoot, "index.html"), "<html>ompiui</html>")
  const port = await availablePort()
  const running = await startOmpiUiServer(
    // 测试环境的 undici keep-alive 连接 + Windows 机器上的 dispose 轻松超过
    // 生产默认的 500ms 关闭窗口；这里用宽松预算，避免 hardStop 的
    // process.exit(1) 把测试进程带走。
    { host: "127.0.0.1", port, webRoot, authToken: "test-token", shutdownTimeoutMs: 5_000 },
    { installSignalHandlers: false },
  )
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /ompiui/)

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/v1/host/health`)
    assert.equal(unauthorized.status, 401)
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/host/health`, {
      headers: { authorization: "Bearer test-token" },
    })
    assert.equal(health.status, 200)
    assert.equal((await health.json() as { service?: string }).service, "ompiui-server")
  } finally {
    await running.stop()
  }
})

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
