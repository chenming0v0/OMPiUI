import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { mapStatusJson, TailscaleManager } from "./tailscale.ts"

const fixture = fileURLToPath(new URL("./fixtures/tailscale-bridge.mjs", import.meta.url))
function manager(dataDir: string, running = false, state = "NeedsLogin") {
  return new TailscaleManager({
    dataDir, embeddedBridgePath: fixture,
    launch: (_binary, args, token) => spawn(process.execPath, [fixture, ...args, "--state", state, ...(running ? ["--running"] : [])], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, OMPIUI_BRIDGE_TOKEN: token },
    }),
  })
}

describe("embedded Tailscale lifecycle", () => {
  for (const state of ["Starting", "NoState", "NeedsMachineAuth"]) {
    it(`preserves the existing identity when reconnecting during ${state}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "ompiui-tsnet-restore-"))
      const node = manager(dir, false, state)
      try {
        await node.resume(8787)
        assert.deepEqual(await node.startLogin(), { ok: true, authUrl: null })
        assert.deepEqual(await node.startLogin(), { ok: true, authUrl: null })
        assert.equal((await node.detailStatus()).backendState, state)
      } finally { await node.dispose(); rmSync(dir, { recursive: true, force: true }) }
    })
  }
  it('passes discovery identity and opt-out without changing the application port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ompiui-discovery-tsnet-'))
    let captured: string[] = []
    const node = new TailscaleManager({ dataDir: dir, embeddedBridgePath: fixture,
      discovery: { displayName: 'My computer', instanceId: 'a'.repeat(32), enabled: false },
      launch: (_binary, args, token) => {
        captured = args
        return spawn(process.execPath, [fixture, ...args], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, OMPIUI_BRIDGE_TOKEN: token },
        })
      },
    })
    try {
      await node.resume(9292)
      await node.startLogin()
      assert.equal(captured[captured.indexOf('--listen') + 1], ':9292')
      assert.equal(captured[captured.indexOf('--discovery-id') + 1], 'a'.repeat(32))
      assert.equal(captured[captured.indexOf('--discovery-name') + 1], 'My computer')
      assert.ok(captured.includes('--discovery-disabled'))
    } finally { await node.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it("does not install a client or spawn a node before explicit enable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompiui-tsnet-"))
    const node = manager(dir)
    try {
      await node.resume(8787)
      assert.equal(node.getStatus().enabled, false)
      assert.equal(node.getStatus().reachable, false)
      assert.equal(node.getStatus().mode, "embedded")
      assert.equal(node.getStatus().usesSystemVpn, false)
      await node.install()
      assert.equal(node.getStatus().reachable, false)
    } finally { await node.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it("handles split ready messages, official login, persistence and disconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompiui-tsnet-"))
    const node = manager(dir)
    try {
      await node.resume(9191)
      assert.deepEqual(await node.startLogin(), { ok: true, authUrl: "https://login.tailscale.com/a/test-node" })
      const status = await node.detailStatus()
      assert.equal(status.authUrl, "https://login.tailscale.com/a/test-node")
      assert.equal(status.backendState, "NeedsLogin")
      assert.equal(status.url, null)
      assert.equal(status.usesSystemVpn, false)
      assert.equal(JSON.parse(readFileSync(join(dir, "tailscale", "tsnet", "ompiui.json"), "utf8")).enabled, true)
      await node.disconnect()
      assert.equal(node.getStatus().enabled, false)
      assert.equal(node.getStatus().reachable, false)
      assert.equal(node.getStatus().authUrl, null)
      assert.equal(JSON.parse(readFileSync(join(dir, "tailscale", "tsnet", "ompiui.json"), "utf8")).enabled, false)
    } finally { await node.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it("restores an enabled node at the actual backend port without reauthorization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompiui-tsnet-"))
    const first = manager(dir, true)
    try {
      await first.resume(8787)
      await first.startLogin()
      await first.dispose()
      const restored = manager(dir, true)
      try {
        await restored.resume(9292)
        const status = await restored.detailStatus()
        assert.equal(status.enabled, true)
        assert.equal(status.url, "http://100.101.2.3:9292")
        assert.equal(status.authUrl, null)
        assert.equal(status.hostName, "ompiui.example.ts.net")
      } finally { await restored.dispose() }
    } finally { await first.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it("reports a missing bundled core and never falls back to an installed system client", async () => {
    const node = new TailscaleManager({ dataDir: tmpdir(), embeddedBridgePath: join(tmpdir(), "missing-tsnet-bridge") })
    await node.resume(8787)
    assert.equal((await node.startLogin()).ok, false)
    assert.equal(node.getStatus().installed, false)
    assert.equal(node.getStatus().mode, "unavailable")
    assert.equal(node.getStatus().usesSystemVpn, false)
    await node.dispose()
  })

  it("requires a loopback-reachable backend rather than advertising a broken gateway", async () => {
    const node = manager(tmpdir())
    await node.resume(8787, "192.168.1.5")
    assert.equal((await node.startLogin()).ok, false)
    assert.match(node.getStatus().lastError ?? "", /127\.0\.0\.1/)
    await node.dispose()
  })

  it("opens no outbound route and reports the sign-in requirement until the node is running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompiui-tsnet-outbound-"))
    const node = manager(dir)
    try {
      await node.resume(8787)
      assert.equal(await node.openRoute("http://100.101.2.9:8787"), null)
      await assert.rejects(node.discover(), /node is stopped/)
      await node.startLogin()
      assert.equal(await node.openRoute("http://100.101.2.9:8787"), null)
      await assert.rejects(node.discover(), /requires Running state \(current: NeedsLogin\)/)
    } finally { await node.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it("routes Tailnet origins through the running node and lists its OMPiUI peers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompiui-tsnet-outbound-"))
    const node = manager(dir, true)
    try {
      await node.resume(8787)
      await node.startLogin()
      assert.equal(await node.openRoute("http://100.101.2.9:8787"), "http://127.0.0.1:45001")
      await assert.rejects(node.openRoute("http://192.168.1.2:8787"), { code: "INVALID_REQUEST" })
      assert.deepEqual(await node.discover(), [{
        marker: "ompiui", discoveryVersion: 1, displayName: "Desk", instanceId: "b".repeat(32),
        port: 8787, pairing: true, address: "100.101.2.9",
      }])
      await node.disconnect()
      assert.equal(await node.openRoute("http://100.101.2.9:8787"), null)
    } finally { await node.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("Tailscale status mapping", () => {
  it("maps native payloads and keeps https authorization links from any control server", () => {
    assert.deepEqual(mapStatusJson({
      BackendState: "Running", TailscaleIPs: ["100.101.1.2"], Version: "1.104.1-build",
      AuthURL: "https://headscale.example.com/auth", Self: { DNSName: "my-pc.example.ts.net." },
    }), {
      backendState: "Running", ips: ["100.101.1.2"], version: "1.104.1",
      authUrl: "https://headscale.example.com/auth", hostName: "my-pc.example.ts.net",
    })
    assert.equal(mapStatusJson({ AuthURL: "http://headscale.example.com/auth" }).authUrl, null)
    assert.equal(mapStatusJson({ AuthURL: "https://user@login.tailscale.com/auth" }).authUrl, null)
    assert.equal(mapStatusJson(null).backendState, null)
  })
})
