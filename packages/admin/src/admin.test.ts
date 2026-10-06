import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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

test("start and stop manage a real child process", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-spawn-")); roots.push(root)
  const env = { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_ADMIN_DATA_DIR: root, OMPIUI_AUTH_TOKEN: "backend" }
  const config: AdminConfig = {
    ...loadAdminConfig(env),
    serverCommand: process.execPath,
    serverArgs: ["-e", "setInterval(() => {}, 1000)"],
    serverUrl: "http://127.0.0.1:1",
  }
  const manager = new ServiceManager({ config, env })

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
