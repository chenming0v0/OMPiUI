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
    for (const path of ["login", "disconnect", "install"]) {
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
