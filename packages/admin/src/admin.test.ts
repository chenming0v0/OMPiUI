import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { adminTokenPath, loadAdminConfig, loadOrCreateAdminToken, saveAdminConfig, type AdminConfig } from "./config.ts"
import { AdminHttpServer } from "./server.ts"
import { ServiceManager } from "./manager.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test("admin token is generated once and stored privately", () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-")); roots.push(root)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root, OMPIUI_AUTH_TOKEN: "backend" }
  const first = loadOrCreateAdminToken(env)
  assert.equal(first, loadOrCreateAdminToken(env))
  assert.equal(readFileSync(adminTokenPath(env), "utf8").trim(), first)
})

test("management API requires its own bearer token", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-http-")); roots.push(root)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root }
  const config: AdminConfig = { ...loadAdminConfig(env), serverUrl: "http://127.0.0.1:1" }
  saveAdminConfig(config, env)
  const server = new AdminHttpServer(new ServiceManager({ config, env }), "admin-secret")
  await server.listen("127.0.0.1", 0)
  const base = server.address()!
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401)
    const response = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer admin-secret" } })
    assert.equal(response.status, 200)
    const body = await response.json() as { backendUrl: string }
    assert.equal(body.backendUrl, "http://127.0.0.1:1")
  } finally {
    await server.close()
  }
})
test("backend settings persist without exposing the tunnel key", () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-config-")); roots.push(root)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root }
  const manager = new ServiceManager({ env })
  manager.updateBackendSettings({
    serverUrl: "http://127.0.0.1:9900/",
    tunnelUrl: "wss://relay.example.com",
    tunnelKey: "secret-key",
    tunnelId: "node-1",
  })
  assert.deepEqual(manager.publicBackendSettings(), {
    serverUrl: "http://127.0.0.1:9900",
    host: "",
    port: "",
    publicBaseUrl: "",
    tunnelUrl: "wss://relay.example.com",
    tunnelId: "node-1",
    tunnelConfigured: "true",
  })
  assert.match(readFileSync(join(root, "admin.json"), "utf8"), /secret-key/)
})

test("start and stop manage a real child process", async t => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-spawn-")); roots.push(root)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root, OMPIUI_AUTH_TOKEN: "backend" }
  const config: AdminConfig = {
    ...loadAdminConfig(env),
    serverCommand: process.execPath,
    serverArgs: ["-e", "setInterval(() => {}, 1000)"],
    serverUrl: "http://127.0.0.1:1",
  }
  const manager = new ServiceManager({ config, env })
  t.after(() => manager.stop())
  await manager.start()
  assert.equal(manager.isRunning(), true)
  const started = await manager.status()
  assert.equal(typeof started.pid, "number")
  assert.notEqual(started.pid, null)

  await manager.stop()
  assert.equal(manager.isRunning(), false)
  const status = await manager.status()
  assert.equal(status.lifecycle, "stopped")
})

test("start refuses when the configured backend is already serving", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-external-")); roots.push(root)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root, OMPIUI_AUTH_TOKEN: "backend" }
  const backend = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ok: true, service: "ompiui-server" }))
  })
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", () => resolve()))
  const port = (backend.address() as AddressInfo).port
  try {
    const config: AdminConfig = { ...loadAdminConfig(env), serverUrl: `http://127.0.0.1:${port}` }
    const manager = new ServiceManager({ config, env })
    await assert.rejects(() => manager.start(), /already answering/)
  } finally {
    backend.close()
  }
})

test("start refuses when an unrelated backend answers 401 on the target address", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-foreign-")); roots.push(root)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root, OMPIUI_AUTH_TOKEN: "backend" }
  const stranger = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "missing or invalid admin token" }))
  })
  await new Promise<void>(resolve => stranger.listen(0, "127.0.0.1", () => resolve()))
  const port = (stranger.address() as AddressInfo).port
  try {
    const config: AdminConfig = { ...loadAdminConfig(env), serverUrl: `http://127.0.0.1:${port}` }
    const manager = new ServiceManager({ config, env })
    await assert.rejects(() => manager.start(), /already answering/)
  } finally {
    stranger.close()
  }
})

function holdArgs(dir: string): string[] {
  const code = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });`,
    `fs.writeFileSync(path.join(${JSON.stringify(dir)}, String(process.pid)), "");`,
    "setInterval(() => {}, 1000);",
  ].join("\n")
  return ["-e", code]
}

async function waitForPids(dir: string): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const names = readdirSync(dir).filter(name => /^\d+$/.test(name))
    if (names.length > 0) return names
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return []
}

function killPids(dir: string): void {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try { process.kill(Number(name), "SIGKILL") } catch { /* already gone */ }
  }
}

test("concurrent starts share one spawn and a failed start can run again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-concurrent-")); roots.push(root)
  const marks = join(root, "pids")
  mkdirSync(marks)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root, OMPIUI_AUTH_TOKEN: "backend" }
  const held = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(resolve => held.listen(0, "127.0.0.1", () => resolve()))
  const port = (held.address() as AddressInfo).port
  const manager = new ServiceManager({
    env,
    config: {
      ...loadAdminConfig(env),
      serverCommand: process.execPath,
      serverArgs: holdArgs(marks),
      serverUrl: `http://127.0.0.1:${port}`,
    },
  })
  t.after(async () => {
    await manager.stop()
    killPids(marks)
    await new Promise<void>(resolve => held.close(() => resolve()))
  })

  const failed = await Promise.allSettled([manager.start(), manager.start()])
  assert.equal(failed[0]?.status, "rejected")
  assert.equal(failed[1]?.status, "rejected")
  assert.equal(readdirSync(marks).length, 0)
  const blocked = await manager.status()
  assert.equal(blocked.lifecycle, "exited")
  assert.match(blocked.error ?? "", /already answering/)
  assert.notEqual(blocked.lifecycle, "starting")

  await new Promise<void>(resolve => held.close(() => resolve()))
  await Promise.all([manager.start(), manager.start()])
  const pids = await waitForPids(marks)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepEqual(readdirSync(marks).filter(name => /^\d+$/.test(name)), pids)
  assert.equal(pids.length, 1)
  assert.equal(manager.isRunning(), true)
  await manager.stop()
  assert.equal(manager.isRunning(), false)
  const pid = Number(pids[0])
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.throws(() => process.kill(pid, 0))
})

test("explicit empty overrides mask inherited env after reload and restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-empty-env-")); roots.push(root)
  const marker = join(root, "seen.json")
  const env = {
    ...process.env,
    OMPIUI_DATA_DIR: root,
    OMPIUI_ADMIN_DATA_DIR: root,
    OMPIUI_AUTH_TOKEN: "backend",
    OMPIUI_HOST: "0.0.0.0",
    OMPIUI_TUNNEL_URL: "wss://inherited.example/tunnel",
    OMPIUI_TUNNEL_KEY: "inherited-key",
    OMPIUI_PUBLIC_BASE_URL: "https://inherited.example",
  }
  const manager = new ServiceManager({ env })
  assert.equal(manager.publicBackendSettings().host, "0.0.0.0")
  assert.equal(manager.publicBackendSettings().tunnelUrl, "wss://inherited.example/tunnel")
  assert.equal(manager.publicBackendSettings().publicBaseUrl, "https://inherited.example")
  assert.equal(manager.publicBackendSettings().tunnelConfigured, "true")

  manager.updateBackendSettings({
    host: "",
    tunnelUrl: "",
    tunnelKey: "",
    publicBaseUrl: "",
  })
  assert.equal(manager.publicBackendSettings().host, "")
  assert.equal(manager.publicBackendSettings().tunnelUrl, "")
  assert.equal(manager.publicBackendSettings().publicBaseUrl, "")
  assert.equal(manager.publicBackendSettings().tunnelConfigured, "false")
  manager.updateBackendSettings({ port: "8787" })
  assert.equal(manager.publicBackendSettings().tunnelUrl, "")
  assert.equal(manager.publicBackendSettings().port, "8787")

  const saved = JSON.parse(readFileSync(join(root, "admin.json"), "utf8")) as { serverEnv: Record<string, string> }
  assert.equal(saved.serverEnv.OMPIUI_TUNNEL_URL, "")
  assert.equal(saved.serverEnv.OMPIUI_TUNNEL_KEY, "")
  assert.equal(saved.serverEnv.OMPIUI_PUBLIC_BASE_URL, "")
  assert.equal(saved.serverEnv.OMPIUI_HOST, "")

  const reloaded = new ServiceManager({ env })
  assert.equal(reloaded.publicBackendSettings().tunnelUrl, "")
  assert.equal(reloaded.publicBackendSettings().publicBaseUrl, "")
  assert.equal(reloaded.publicBackendSettings().host, "")
  assert.equal(reloaded.publicBackendSettings().tunnelConfigured, "false")
  assert.equal(reloaded.publicBackendSettings().port, "8787")

  const code = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
    "  tunnel: process.env.OMPIUI_TUNNEL_URL ?? null,",
    "  key: process.env.OMPIUI_TUNNEL_KEY ?? null,",
    "  publicBaseUrl: process.env.OMPIUI_PUBLIC_BASE_URL ?? null,",
    "  host: process.env.OMPIUI_HOST ?? null,",
    "}));",
    "setInterval(() => {}, 1000);",
  ].join("\n")
  const loaded = loadAdminConfig(env)
  const runner = new ServiceManager({
    env,
    config: {
      ...loaded,
      serverCommand: process.execPath,
      serverArgs: ["-e", code],
      serverUrl: "http://127.0.0.1:1",
    },
  })
  t.after(() => runner.stop())
  const readMarker = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { return JSON.parse(readFileSync(marker, "utf8")) as Record<string, string | null> } catch { /* not written yet */ }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error("child env was not recorded")
  }
  await runner.start()
  assert.deepEqual(await readMarker(), { tunnel: "", key: "", publicBaseUrl: "", host: "" })
  rmSync(marker)
  await runner.restart()
  assert.deepEqual(await readMarker(), { tunnel: "", key: "", publicBaseUrl: "", host: "" })
  await runner.stop()
})

test("status reports an unreachable backend without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-unreachable-")); roots.push(root)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root, OMPIUI_AUTH_TOKEN: "backend" }
  const config: AdminConfig = { ...loadAdminConfig(env), serverUrl: "http://127.0.0.1:1" }
  const manager = new ServiceManager({ config, env })

  const status = await manager.status()

  assert.equal(status.health, null)
  assert.match(status.healthError ?? "", /fetch failed|ECONNREFUSED|error/i)
  assert.equal(status.share, null)
  assert.equal(status.tunnel, null)
})
