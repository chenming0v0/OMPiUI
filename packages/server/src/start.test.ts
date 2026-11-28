import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { once } from "node:events"
import { WebSocket } from "ws"
import { PROTOCOL_VERSION } from "@ompiui/protocol"
import { parseWebArgs, resolveServerConfig, startOmpiUiServer } from "./start.ts"
import { TailscaleManager } from "./host/tailscale.ts"
import { DshHostedManager, type DshHostStatus } from "./tunnel/dsh-hosted-manager.ts"

const roots: string[] = []
const previousDriver = process.env.OMPIUI_DRIVER
const previousDataDir = process.env.OMPIUI_DATA_DIR
const previousDiscovery = process.env.OMPIUI_DISCOVERY_ADVERTISE

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousDriver === undefined) delete process.env.OMPIUI_DRIVER
  else process.env.OMPIUI_DRIVER = previousDriver
  if (previousDataDir === undefined) delete process.env.OMPIUI_DATA_DIR
  else process.env.OMPIUI_DATA_DIR = previousDataDir
  if (previousDiscovery === undefined) delete process.env.OMPIUI_DISCOVERY_ADVERTISE
  else process.env.OMPIUI_DISCOVERY_ADVERTISE = previousDiscovery
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
  assert.deepEqual(parseWebArgs(["--api-only", "--dsh-remote"]), {
    help: false, webRoot: null, dshRemote: true,
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
    const network = await fetch(`http://127.0.0.1:${port}/api/v1/host/network`, {
      headers: { authorization: "Bearer test-token" },
    })
    assert.equal(network.status, 200)
    assert.notEqual(port, 8787)
    assert.equal((await network.json() as { port?: number }).port, port)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=test-token`)
    const baseline = new Promise<unknown>(resolve => {
      ws.on("message", data => {
        const message = JSON.parse(String(data))
        if (message.event?.channel === "sessions.activity") resolve(message.event.payload)
      })
    })
    try {
      await once(ws, "open")
      ws.send(JSON.stringify({ type: "subscribe", protocolVersion: PROTOCOL_VERSION,
        streams: [{ kind: "server", id: "server" }] }))
      assert.deepEqual(await baseline, { sessions: {} })
    } finally {
      ws.terminate()
    }
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

for (const startupEnabled of [true, false]) {
  test(`API-only DS host attaches and forwards local auth when ${startupEnabled ? "enabled at startup" : "enabled after startup"}`, { timeout: 15_000 }, async t => {
    const dataDir = mkdtempSync(join(tmpdir(), "ompiui-start-dsh-"))
    roots.push(dataDir)
    process.env.OMPIUI_DATA_DIR = dataDir
    process.env.OMPIUI_DRIVER = "mock"
    process.env.OMPIUI_DISCOVERY_ADVERTISE = "false"
    mkdirSync(join(dataDir, "dsh-remote"))
    writeFileSync(join(dataDir, "dsh-remote", "host.json"), JSON.stringify({
      identity: { deviceId: "7c1d3e5f-2a4b-4c6d-8e0f-1a3b5c7d9e22", identityKey: "A".repeat(43), privateKey: "A".repeat(43) },
      tokens: {
        accessToken: "access-token-0001", accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
        refreshToken: "refresh-token-0001", refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER,
      },
    }))
    t.mock.method(TailscaleManager.prototype, "resume", async () => {})
    // 保留真实挂接和管理流程，仅替换外部 DS 连接，核对启动入口传下来的凭据。
    const attach = t.mock.method(DshHostedManager.prototype, "attach")
    const dispose = t.mock.method(DshHostedManager.prototype, "dispose")
    const hostStarted = Promise.withResolvers<{ port: number; authToken?: string }>()
    const authToken = "api-only-local-credential"
    const port = await availablePort()
    const running = await startOmpiUiServer(
      { host: "127.0.0.1", port, webRoot: null, authToken, dshRemote: startupEnabled, shutdownTimeoutMs: 5_000 },
      {
        installSignalHandlers: false,
        runDshHost: async (_account, localPort, signal, _origins, ready, options) => {
          ready?.()
          hostStarted.resolve({ port: localPort, authToken: options?.authToken })
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        },
      },
    )
    try {
      const address = running.server.address()
      assert.ok(address && typeof address === "object")
      assert.equal(running.server.listening, true)
      assert.equal(running.config.webRoot, null)
      assert.equal(attach.mock.callCount(), 1)
      assert.deepEqual(attach.mock.calls[0]!.arguments, [address.port, address.address])
      await attach.mock.calls[0]!.result

      const base = `http://127.0.0.1:${address.port}`
      const headers = {
        authorization: `Bearer ${authToken}`,
        "x-ompiui-dsh-management": readFileSync(join(dataDir, "dsh-remote", "management-token"), "utf8"),
        connection: "close",
      }
      const getStatus = async (): Promise<DshHostStatus> => {
        const response = await fetch(`${base}/api/v1/host/dsh-remote`, { headers })
        assert.equal(response.status, 200)
        return response.json() as Promise<DshHostStatus>
      }
      if (!startupEnabled) {
        const disabled = await getStatus()
        assert.equal(disabled.available, true)
        assert.equal(disabled.reason, null)
        assert.equal(disabled.enabled, false)
        assert.equal(disabled.state, "disabled")
        const enabled = await fetch(`${base}/api/v1/host/dsh-remote`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ action: "enable" }),
        })
        assert.equal(enabled.status, 200)
        await enabled.arrayBuffer()
      }
      assert.deepEqual(await hostStarted.promise, { port: address.port, authToken })
      const status = await getStatus()
      assert.equal(status.available, true)
      assert.equal(status.reason, null)
      assert.equal(status.registered, true)
      assert.equal(status.enabled, true)
      assert.equal(status.state, "online")
      assert.ok(!JSON.stringify(status).includes(authToken))
    } finally {
      await running.stop()
      // stop 会异步释放 DS；删除隔离目录前等待该释放完成。
      await Promise.all(dispose.mock.calls.map(call => call.result))
    }
  })
}

test("shutdown immediately after health works while Tailscale startup is still pending", { timeout: 15_000 }, async t => {
  process.env.OMPIUI_DRIVER = "mock"
  const attach = t.mock.method(DshHostedManager.prototype, "attach")
  let releaseResume!: () => void
  let resumeStarted!: () => void
  const enteredResume = new Promise<void>(resolve => { resumeStarted = resolve })
  t.mock.method(TailscaleManager.prototype, "resume", async () => {
    resumeStarted()
    await new Promise<void>(resolve => { releaseResume = resolve })
  })
  const port = await availablePort()
  const starting = startOmpiUiServer(
    { host: "127.0.0.1", port, webRoot: null, authToken: "test-token", shutdownTimeoutMs: 5_000 },
    { installSignalHandlers: false },
  )
  try {
    await enteredResume
    const url = `http://127.0.0.1:${port}`
    const headers = { authorization: "Bearer test-token", connection: "close" }
    const health = await fetch(`${url}/api/v1/host/health`, { headers })
    assert.equal(health.status, 200)
    await health.arrayBuffer()
    const shutdown = await fetch(`${url}/api/v1/host/shutdown`, { method: "POST", headers })
    assert.equal(shutdown.status, 200)
    await shutdown.arrayBuffer()
    // 不释放 resume 也必须关闭监听；旧实现此时返回 200 却完全不执行 stop。
    let closed = false
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(`${url}/api/v1/host/health`, { headers, signal: AbortSignal.timeout(500) })
        await response.arrayBuffer()
      } catch {
        closed = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(closed, true, "shutdown must close the listener before startup restoration finishes")
  } finally {
    releaseResume()
    const running = await starting
    await running.stop()
    assert.equal(running.server.listening, false)
    assert.equal(attach.mock.callCount(), 0)
  }
})
