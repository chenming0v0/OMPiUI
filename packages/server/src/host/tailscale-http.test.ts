import assert from "node:assert/strict"
import { it } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAppServer } from "../http.ts"
import { TailscaleManager } from "./tailscale.ts"

it("protects node management with the existing backend token and exposes disconnected state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ompiui-tsnet-http-"))
  const manager = new TailscaleManager({ dataDir: dir, embeddedBridgePath: join(dir, "not-bundled") })
  const app = createAppServer({ authToken: "private-backend-token", tailscale: manager })
  try {
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve))
    const address = app.server.address()
    assert.ok(address && typeof address === "object")
    const origin = `http://127.0.0.1:${address.port}`
    for (const path of ["login", "disconnect", "install", "route", "discover"]) {
      const response = await fetch(`${origin}/api/v1/host/tailscale/${path}`, { method: "POST" })
      assert.equal(response.status, 401)
    }
    const headers = { authorization: "Bearer private-backend-token" }
    const login = await fetch(`${origin}/api/v1/host/tailscale/login`, { method: "POST", headers })
    assert.equal(login.status, 409)
    const disconnect = await fetch(`${origin}/api/v1/host/tailscale/disconnect`, { method: "POST", headers })
    assert.equal(disconnect.status, 200)
    const status = await fetch(`${origin}/api/v1/host/tailscale`, { headers }).then(response => response.json())
    assert.equal(status.usesSystemVpn, false)
    assert.equal(status.enabled, false)
    assert.equal(status.url, null)
    const invalidMethod = await fetch(`${origin}/api/v1/host/tailscale/disconnect`, { headers })
    assert.equal(invalidMethod.status, 405)
  } finally {
    await manager.dispose()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

it("offers outbound routes and discovery only to clients on this computer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ompiui-tsnet-http-"))
  const manager = new TailscaleManager({ dataDir: dir, embeddedBridgePath: join(dir, "not-bundled") })
  const app = createAppServer({ authToken: "private-backend-token", tailscale: manager })
  try {
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve))
    const address = app.server.address()
    assert.ok(address && typeof address === "object")
    const base = `http://127.0.0.1:${address.port}/api/v1/host/tailscale`
    const headers = { authorization: "Bearer private-backend-token", "content-type": "application/json" }
    const body = JSON.stringify({ origin: "http://100.101.2.9:8787" })

    // 节点未登录：不开路由，调用方据此改走系统网络。
    const route = await fetch(`${base}/route`, { method: "POST", headers, body })
    assert.equal(route.status, 409)
    const missingOrigin = await fetch(`${base}/route`, { method: "POST", headers, body: "{}" })
    assert.equal(missingOrigin.status, 400)
    const discover = await fetch(`${base}/discover`, { method: "POST", headers })
    assert.equal(discover.status, 409)
    assert.match((await discover.json()).message, /node is stopped/)

    // 经 Tailnet 网关或隧道转进来的请求带转发头，不能让远端借本机节点向外连。
    for (const path of ["route", "discover"]) {
      const forwarded = await fetch(`${base}/${path}`, { method: "POST", headers: { ...headers, "x-forwarded-for": "100.101.2.9" }, body })
      assert.equal(forwarded.status, 403)
    }
    assert.equal((await fetch(`${base}/route`, { headers })).status, 405)
  } finally {
    await manager.dispose()
    await app.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
