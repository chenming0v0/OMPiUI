import assert from "node:assert/strict"
import { after, describe, it } from "node:test"

// Parallel test files each spawn OMP workers; the default handshake budget
// is too tight when several spawn at once on a loaded machine.
process.env.OMPIUI_WORKER_HANDSHAKE_TIMEOUT_MS ??= "60000"

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { connect } from "node:net"
import { once } from "node:events"
import { createAppServer, type AppServer } from "./http.ts"
import { RuntimeSupervisor } from "./omp/supervisor.ts"
import { MAX_PAIRING_FAILURES, PairingStore } from "./host/pairing.ts"
import { TUNNEL_FORWARDING_HEADER } from "./host/security.ts"
import { FaultReportService } from "./diagnostics/fault-reports.ts"

// 测试进程的 session 租约目录放进独立临时目录，跑完即删，
// 不污染默认的 ompiui-session-leases 命名空间。
const leaseHome = mkdtempSync(path.join(tmpdir(), "ompiui-http-leases-"))
const previousDataDir = process.env.OMPIUI_DATA_DIR
process.env.OMPIUI_DATA_DIR = path.join(leaseHome, "data")
process.env.OMPIUI_SESSION_LEASE_DIR = leaseHome
after(() => {
  if (previousDataDir === undefined) delete process.env.OMPIUI_DATA_DIR
  else process.env.OMPIUI_DATA_DIR = previousDataDir
  rmSync(leaseHome, { recursive: true, force: true })
})

async function listen(app: AppServer) {
  await new Promise<void>((resolve, reject) => {
    app.server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()))
  })
  const addr = app.server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")
  return addr.port
}

async function request(
  port: number,
  method: string,
  path: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, json: await response.json().catch(() => undefined) }
}

describe("http api", () => {
  const cleanups: Array<() => Promise<void> | void> = []
  after(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  for (const mode of ["source", "anonymous-pool"] as const) {
    it(`slow anonymous pairing has bounded ${mode} admission without blocking authenticated reads`, { timeout: 5000 }, async () => {
      const app = createAppServer({
        authToken: "test-token", pairing: new PairingStore(), tunnelForwardingToken: "private-test-hop",
      })
      const port = await listen(app)
      const sockets = Array.from({ length: mode === "source" ? 3 : 5 }, () => connect(port, "127.0.0.1"))
      try {
        const refused = Promise.race(sockets.map(socket => once(socket, "data")))
        await Promise.all(sockets.map(async (socket, index) => {
          await once(socket, "connect")
          socket.write([
            "POST /api/v1/host/pair/redeem HTTP/1.1", `Host: 127.0.0.1:${port}`,
            "Content-Type: application/json", "Content-Length: 1048576",
            `${TUNNEL_FORWARDING_HEADER}: private-test-hop`,
            `X-Forwarded-For: 198.51.100.${mode === "source" ? 1 : index + 1}`,
            "", "{",
          ].join("\r\n"))
        }))
        const [raw] = await refused
        assert.match(String(raw), mode === "source" ? /^HTTP\/1.1 429/ : /^HTTP\/1.1 503/)
        const authenticated = await request(port, "POST", "/api/v1/host/commands/not-a-command", {
          token: "test-token", body: {},
        })
        assert.equal(authenticated.status, 404)
      } finally {
        sockets.forEach(socket => socket.destroy())
        await app.dispose()
      }
    })
  }

  it("rejects requests without a token and accepts a valid one", async () => {
    const app = createAppServer({ authToken: "test-token" })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const rejected = await request(port, "GET", "/api/v1/host/health")
    assert.equal(rejected.status, 401)

    const accepted = await request(port, "GET", "/api/v1/host/health", { token: "test-token" })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.ok, true)
    assert.equal(accepted.json.service, "ompiui-server")
  })

  it("dispose kills terminals before closing HTTP and disposes the supervisor only after real PTY exit", async () => {
    const app = createAppServer({ authToken: "test-token" })
    await listen(app)
    const order: string[] = []
    let exitPty!: () => void
    const realShutdown = app.terminals.shutdown.bind(app.terminals)
    app.terminals.shutdown = () => {
      order.push("terminals.kill")
      return realShutdown().then(() => new Promise<void>(resolve => {
        exitPty = () => { order.push("pty.exit"); resolve() }
      }))
    }
    const realSupervisorDispose = app.supervisor.dispose.bind(app.supervisor)
    app.supervisor.dispose = async () => { order.push("supervisor.dispose"); await realSupervisorDispose() }
    app.server.once("close", () => order.push("http.closed"))

    // dispose 是 async 箭头函数，每次调用返回新 Promise；只验证幂等语义，不比较引用。
    const disposed = app.dispose()
    const disposedAgain = app.dispose()
    while (!exitPty) await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(order, ["terminals.kill", "http.closed"])
    exitPty()
    await Promise.all([disposed, disposedAgain])
    assert.deepEqual(order, ["terminals.kill", "http.closed", "pty.exit", "supervisor.dispose"])
    assert.equal(order.filter(step => step === "terminals.kill").length, 1)
    assert.equal(order.filter(step => step === "supervisor.dispose").length, 1)
  })

  it("dispose logs a terminal exit failure and still releases the supervisor", async () => {
    const app = createAppServer({ authToken: "test-token" })
    await listen(app)
    const realShutdown = app.terminals.shutdown.bind(app.terminals)
    app.terminals.shutdown = async () => { await realShutdown(); throw new Error("pty stuck") }
    let supervisorDisposed = false
    const realSupervisorDispose = app.supervisor.dispose.bind(app.supervisor)
    app.supervisor.dispose = async () => { supervisorDisposed = true; await realSupervisorDispose() }
    const logged: unknown[][] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      await app.dispose()
    } finally {
      console.error = realError
    }
    assert.equal(supervisorDisposed, true)
    assert.ok(logged.some(args => args.some(arg => arg instanceof Error && arg.message === "pty stuck")))
  })

  it("protects fault report/status endpoints and reads them without opening a runtime", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-report-api-"))
    const app = createAppServer({ authToken: "report-token", faultReports: new FaultReportService(root, []) })
    const port = await listen(app)
    cleanups.push(async () => { await app.dispose(); rmSync(root, { recursive: true, force: true }) })
    assert.equal((await request(port, "GET", "/api/v1/host/diagnostics/report")).status, 401)
    assert.equal((await request(port, "GET", "/api/v1/host/diagnostics/status")).status, 401)
    const report = await request(port, "GET", "/api/v1/host/diagnostics/report", { token: "report-token" })
    assert.equal(report.status, 200)
    assert.equal(report.json.complete, false)
    const status = await request(port, "GET", "/api/v1/host/diagnostics/status", { token: "report-token" })
    assert.equal(status.status, 200)
    assert.ok(status.json.runId)
    assert.deepEqual(app.sessionHost.listAttachedIds(), [])
  })

  it("network reports the listening ephemeral port, not Host, forwarding headers or share config", async () => {
    const app = createAppServer({ authToken: "test-token", share: { host: "0.0.0.0", port: 8787 } })
    const port = await listen(app)
    cleanups.push(() => app.dispose())
    assert.notEqual(port, 8787)
    const unauthorized = await request(port, "GET", "/api/v1/host/network")
    assert.equal(unauthorized.status, 401)
    const network = await request(port, "GET", "/api/v1/host/network", {
      token: "test-token",
      headers: { host: "example.com:1234", "x-forwarded-port": "443", "x-forwarded-host": "example.com:443" },
    })
    assert.equal(network.status, 200)
    assert.equal(network.json.port, port)
    assert.equal(network.json.host, "127.0.0.1")
    assert.ok(Array.isArray(network.json.interfaces))
  })

  it("network reports the actual wildcard listener", async () => {
    const app = createAppServer({ authToken: "test-token", share: { host: "127.0.0.1", port: 8787 } })
    cleanups.push(() => app.dispose())
    await new Promise<void>(resolve => app.server.listen(0, "0.0.0.0", resolve))
    const address = app.server.address()
    assert.ok(address && typeof address === "object")
    const network = await request(address.port, "GET", "/api/v1/host/network", { token: "test-token" })
    assert.equal(network.status, 200)
    assert.equal(network.json.host, "0.0.0.0")
    assert.equal(network.json.port, address.port)
    assert.deepEqual(app.sessionHost.listAttachedIds(), [])
  })

  it("pairing ignores spoofed forwarding headers and preserves direct-client limits and token checks", async () => {
    const pairing = new PairingStore()
    const app = createAppServer({ authToken: "test-token", pairing, tunnelForwardingToken: "internal-only-token" })
    const port = await listen(app)
    cleanups.push(() => app.dispose())
    const invite = pairing.mint()
    for (let i = 0; i < MAX_PAIRING_FAILURES; i++) {
      const result = await request(port, "POST", "/api/v1/host/pair/redeem", {
        body: { code: "invalid" },
        headers: {
          "x-forwarded-for": `198.51.100.${i + 1}`,
          "x-real-ip": `198.51.100.${i + 1}`,
          forwarded: `for=198.51.100.${i + 1}`,
          ...(i % 2 ? { [TUNNEL_FORWARDING_HEADER]: "attacker-token" } : {}),
        },
      })
      assert.equal(result.status, i === MAX_PAIRING_FAILURES - 1 ? 429 : 400)
    }
    const blocked = await request(port, "POST", "/api/v1/host/pair/redeem", {
      body: { pair: `${invite.id}.${invite.secret}` },
      headers: { "x-forwarded-for": "203.0.113.99", [TUNNEL_FORWARDING_HEADER]: "new-attacker-token" },
    })
    assert.equal(blocked.status, 429)
    assert.match(blocked.json.message, /too many failed attempts/)
    assert.equal(invite.redeemed, false)
    const unauthenticated = await request(port, "GET", "/api/v1/host/pair/invite", {
      headers: { "x-forwarded-for": "203.0.113.99", [TUNNEL_FORWARDING_HEADER]: "internal-only-token" },
    })
    assert.equal(unauthenticated.status, 401, "even the internal marker is not API authorization")
    assert.equal((await request(port, "GET", "/api/v1/host/pair/invite", { token: "test-token" })).status, 200)
  })

  it("share prefers the configured public base URL over the LAN address", async () => {
    const app = createAppServer({
      authToken: "test-token",
      share: { host: "0.0.0.0", port: 8787, publicBaseUrl: "https://panel.example.com/" },
    })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const share = await request(port, "GET", "/api/v1/host/share", { token: "test-token" })
    assert.equal(share.status, 200)
    assert.equal(share.json.url, "https://panel.example.com")
    assert.equal(share.json.public, true)
    assert.equal(share.json.lan, true)
    assert.equal(
      share.json.link,
      `ompiui://connect?url=${encodeURIComponent("https://panel.example.com")}&token=${encodeURIComponent("test-token")}`,
    )
  })

  it("share falls back to a LAN address without a public base URL", async () => {
    const app = createAppServer({ authToken: "test-token", share: { host: "0.0.0.0", port: 8787 } })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const share = await request(port, "GET", "/api/v1/host/share", { token: "test-token" })
    assert.equal(share.status, 200)
    assert.ok(share.json.url.startsWith("http://"), `expected a plain LAN URL, got ${share.json.url}`)
    assert.equal(share.json.public, undefined)
  })

  it("serves workspaces, files and git through the host surface", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-http-host-"))
    writeFileSync(path.join(root, "hello.txt"), "hello ompiui", "utf8")
    mkdirSync(path.join(root, "src"))
    writeFileSync(path.join(root, "src", "index.ts"), "export const answer = 42\n", "utf8")
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const registry = await request(port, "GET", "/api/v1/host/registry")
    assert.equal(registry.status, 200)
    assert.ok(registry.json.commands.some((command: any) => command.name === "files.read"))
    assert.ok(registry.json.commands.some((command: any) => command.name === "git.status"))
    assert.ok(registry.json.commands.some((command: any) => command.name === "terminals.create"))

    const created = await request(port, "POST", "/api/v1/host/commands/workspaces.open", { body: { rootPath: root } })
    assert.equal(created.status, 200)
    const workspacePath = created.json.data.workspace.path as string

    const list = await request(port, "POST", "/api/v1/host/commands/workspaces.list")
    assert.equal(list.status, 200)
    assert.ok(list.json.data.workspaces.some((ws: any) => ws.path === workspacePath))

    const dir = await request(port, "POST", "/api/v1/host/commands/files.list", { body: { workspacePath, path: "" } })
    assert.equal(dir.status, 200)
    assert.ok(dir.json.data.entries.some((entry: any) => entry.name === "hello.txt"))

    const read = await request(port, "POST", "/api/v1/host/commands/files.read", { body: { workspacePath, path: "hello.txt" } })
    assert.equal(read.status, 200)
    assert.equal(read.json.data.content, "hello ompiui")
    const etag = read.json.data.etag as string
    assert.ok(etag)

    const written = await request(port, "POST", "/api/v1/host/commands/files.write", {
      body: { workspacePath, path: "hello.txt", content: "updated", ifMatch: etag },
    })
    assert.equal(written.status, 200, JSON.stringify(written.json))
    assert.equal(written.json.data.content, "updated")

    const stale = await request(port, "POST", "/api/v1/host/commands/files.write", {
      body: { workspacePath, path: "hello.txt", content: "stale write", ifMatch: etag },
    })
    assert.equal(stale.status, 409)

    const terminal = await request(port, "POST", "/api/v1/host/commands/terminals.create", {
      body: { workspacePath, title: "HTTP terminal", cwd: "" },
    })
    assert.equal(terminal.status, 200)
    const terminalId = terminal.json.data.id as string
    assert.equal(terminal.json.data.status, "running")

    const terminals = await request(port, "POST", "/api/v1/host/commands/terminals.list", { body: { workspacePath } })
    assert.equal(terminals.status, 200)
    assert.ok(terminals.json.data.terminals.some((item: any) => item.id === terminalId))

    const renamed = await request(port, "POST", "/api/v1/host/commands/terminals.update", {
      body: { workspacePath, terminalId, title: "Renamed terminal", rows: 30, cols: 100 },
    })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.json.data.title, "Renamed terminal")

    const removed = await request(port, "POST", "/api/v1/host/commands/terminals.remove", { body: { workspacePath, terminalId } })
    assert.equal(removed.status, 200)

    const search = await request(port, "POST", "/api/v1/host/commands/files.searchName", { body: { workspacePath, query: "index" } })
    assert.equal(search.status, 200)
    assert.ok(search.json.data.paths.some((p: string) => p.endsWith("index.ts")))

    const gitStatus = await request(port, "POST", "/api/v1/host/commands/git.status", { body: { workspacePath } })
    assert.equal(gitStatus.status, 200)

    const outside = await request(port, "POST", "/api/v1/host/commands/files.read", { body: { workspacePath, path: "../outside.txt" } })
    assert.ok([400, 403, 404].includes(outside.status))

    const oldWorkspaceRoute = await request(port, "GET", "/api/v1/host/workspaces")
    assert.equal(oldWorkspaceRoute.status, 404)
  })

  it("re-registers a real workspace when the in-memory registry is empty", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-http-reopen-"))
    writeFileSync(path.join(root, "after-restart.txt"), "ready", "utf8")
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const listedBefore = await request(port, "POST", "/api/v1/host/commands/workspaces.list")
    assert.equal(listedBefore.status, 200)
    assert.deepEqual(listedBefore.json.data.workspaces, [])

    const files = await request(port, "POST", "/api/v1/host/commands/files.list", {
      body: { workspacePath: root, path: "" },
    })
    assert.equal(files.status, 200)
    assert.ok(files.json.data.entries.some((entry: any) => entry.name === "after-restart.txt"))

    const listedAfter = await request(port, "POST", "/api/v1/host/commands/workspaces.list")
    assert.equal(listedAfter.status, 200)
    assert.equal(listedAfter.json.data.workspaces.length, 1)
  })

  it("serves catalog commands and reports unknown commands", async () => {
    const mockHome = mkdtempSync(path.join(tmpdir(), "ompiui-http-catalog-"))
    process.env.OMPIUI_MOCK_DIR = mockHome
    process.env.OMPIUI_DRIVER = "mock"
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(mockHome, { recursive: true, force: true })
    })

    const registry = await request(port, "GET", "/api/v1/pi/registry")
    assert.equal(registry.status, 200)
    assert.equal(registry.json.revision, 1)
    const modelsList = registry.json.globalCommands.find((command: any) => command.name === "models.list")
    assert.equal(modelsList?.queue, "immediate")
    assert.equal(modelsList?.idempotent, true)
    assert.ok(registry.json.globalCommands.some((command: any) => command.name === "session.open"))
    const controls = registry.json.sessionCommands.find((command: any) => command.name === "controls.get")
    assert.equal(controls?.queue, "immediate")
    assert.equal(controls?.idempotent, true)
    assert.ok(registry.json.sessionCommands.some((command: any) => command.name === "session.initialize"))
    const prompt = registry.json.sessionCommands.find((command: any) => command.name === "prompt")
    assert.equal(prompt?.paramsSchema.properties.text.type, "string")
    assert.equal(prompt?.streaming, true)

    const models = await request(port, "POST", "/api/v1/pi/commands/models.list")
    assert.equal(models.status, 200)
    assert.ok(models.json.data.some((model: any) => model.provider === "mock"))

    const settings = await request(port, "POST", "/api/v1/pi/commands/settings.get", { body: { cwd: mockHome } })
    assert.equal(settings.status, 200)

    const created = await request(port, "POST", "/api/v1/host/commands/workspaces.open", { body: { rootPath: mockHome } })
    assert.equal(created.status, 200)
    const settingsNow = await request(port, "POST", "/api/v1/pi/commands/settings.get", { body: { cwd: mockHome } })
    assert.equal(settingsNow.status, 200)
    assert.equal(settingsNow.json.data.workspacePath, mockHome)

    const opened = await request(port, "POST", "/api/v1/pi/commands/session.open", { body: { cwd: mockHome } })
    assert.equal(opened.status, 200)
    const sessionId = opened.json.data.sessionId as string

    const controlsResponse = await request(port, "POST", `/api/v1/pi/sessions/${sessionId}/commands/controls.get`)
    assert.equal(controlsResponse.status, 200)
    assert.equal(controlsResponse.json.data.sessionId, sessionId)
    const initialized = await request(port, "POST", `/api/v1/pi/sessions/${sessionId}/commands/session.initialize`)
    assert.equal(initialized.status, 200)
    assert.equal(initialized.json.data.isStreaming, false)
    for (const type of ["controls.get", "session.initialize"]) {
      const invalid = await request(port, "POST", `/api/v1/pi/sessions/${sessionId}/commands/${type}`, { body: { unexpected: true } })
      assert.equal(invalid.status, 400, type)
    }

    const allSessions = await request(port, "POST", "/api/v1/pi/commands/session.listAll")
    assert.equal(allSessions.status, 200)
    assert.ok(allSessions.json.data.some((session: any) => session.id === sessionId))

    const preview = await request(port, "POST", "/api/v1/pi/commands/session.preview", { body: { sessionId } })
    assert.equal(preview.status, 200)
    assert.equal(preview.json.data.state.sessionId, sessionId)
    assert.ok(Array.isArray(preview.json.data.branch.items))

    // Global commands receive their declared body directly. `params` belongs
    // to session.read itself, not an HTTP command envelope.
    const diskState = await request(port, "POST", "/api/v1/pi/commands/session.read", {
      body: { sessionId, query: "state.get", params: {} },
    })
    assert.equal(diskState.status, 200)
    assert.equal(diskState.json.data.sessionId, sessionId)
    const invalidEnvelope = await request(port, "POST", "/api/v1/pi/commands/session.read", {
      body: { params: { sessionId, query: "state.get" } },
    })
    assert.equal(invalidEnvelope.status, 400)

    for (const type of [
      "models.list",
      "settings.patch",
      "providers.logout",
      "modelRuntime.setApiKey",
      "packages.manage",
    ]) {
      const globalThroughSession = await request(
        port,
        "POST",
        `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/${type}`,
      )
      assert.equal(globalThroughSession.status, 404, type)
      assert.equal(globalThroughSession.json.code, "UNKNOWN_COMMAND", type)
    }

    for (const type of ["prompt", "state.get", "branch.get", "controls.get", "session.initialize"]) {
      const sessionThroughGlobal = await request(port, "POST", `/api/v1/pi/commands/${type}`)
      assert.equal(sessionThroughGlobal.status, 404, type)
      assert.equal(sessionThroughGlobal.json.code, "UNKNOWN_COMMAND", type)
    }

    const unknown = await request(port, "POST", "/api/v1/pi/commands/does.not.exist")
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.code, "UNKNOWN_COMMAND")

    const removedShortcut = await request(port, "GET", "/api/v1/pi/models")
    assert.equal(removedShortcut.status, 404)
  })

  it("health stays read-only and clears the CLI version when the worker is unavailable", async () => {
    const supervisor = new RuntimeSupervisor({
      workerEntry: new URL("./omp/worker-client-fixture.mjs", import.meta.url),
      worker: { env: { OMPIUI_FIXTURE_MODE: "hello-ok" }, execArgv: ["--import", "tsx"] },
    })
    const app = createAppServer({ authToken: "test-token", supervisor })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const cold = await request(port, "GET", "/api/v1/host/health", { token: "test-token" })
    assert.equal(cold.status, 200)
    assert.equal(cold.json.ompVersion, null)
    assert.equal(cold.json.workerReady, false)
    assert.equal(await supervisor.peekCatalogHandshake(), undefined)

    const hello = await supervisor.getCatalogHandshake()
    const ready = await request(port, "GET", "/api/v1/host/health", { token: "test-token" })
    assert.equal(ready.status, 200)
    assert.equal(ready.json.ompVersion, hello.ompVersion)
    assert.equal(ready.json.workerReady, true)

    await supervisor.dispose()
    const stopped = await request(port, "GET", "/api/v1/host/health", { token: "test-token" })
    assert.equal(stopped.status, 200)
    assert.equal(stopped.json.ompVersion, null)
    assert.equal(stopped.json.workerReady, false)
  })

  it("routes extension commands and tools natively through the runtime registry (mock driver)", async () => {
    const mockHome = mkdtempSync(path.join(tmpdir(), "ompiui-http-ext-"))
    process.env.OMPIUI_MOCK_DIR = mockHome
    process.env.OMPIUI_DRIVER = "mock"
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(mockHome, { recursive: true, force: true })
    })

    const opened = await request(port, "POST", "/api/v1/pi/commands/session.open", { body: { cwd: mockHome } })
    assert.equal(opened.status, 200)
    const sessionId = opened.json.data.sessionId as string

    // 扩展命令按名字路由：静态表未命中 → 查 Pi 运行时注册表 → 原生分发。
    const command = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/mock-command`)
    assert.equal(command.status, 202)
    assert.equal(command.json.command.type, "mock-command")

    // 注册表里没有的命令仍响亮 404。
    const unknown = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/does.not.exist`)
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.code, "UNKNOWN_COMMAND")

    // mock-command 执行后注册了 mock-dynamic-tool：轮询直到按名字可路由，
    // 证明命令真的执行了且注册表是 Pi 运行时自己更新的。
    let dynamic: { status: number } | undefined
    for (let attempt = 0; attempt < 40; attempt += 1) {
      dynamic = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/mock-dynamic-tool`, { body: { value: "v1" } })
      if (dynamic.status === 202) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(dynamic?.status, 202)

    // 工具参数 schema 来自 Pi 的工具定义：畸形入参响亮 400，合法入参可路由。
    const badTool = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/mock-tool`, { body: { echo: 42 } })
    assert.equal(badTool.status, 400)
    assert.equal(badTool.json.code, "INVALID_REQUEST")

    const goodTool = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/mock-tool`, { body: { echo: "hi" } })
    assert.equal(goodTool.status, 202)
  })
})
