import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
  DEFAULT_TUNNEL_ID,
  generateTunnelKey,
  hashTunnelKey,
  isValidTunnelKey,
  loadRelayConfig,
  validateRelayConfig,
  writeInitialConfig,
} from "./config.ts"

describe("tunnel key helpers", () => {
  it("generates 43-char base64url keys with stable sha256 hashes", () => {
    const key = generateTunnelKey()
    assert.equal(key.length, 43)
    assert.match(key, /^[A-Za-z0-9_-]+$/)
    assert.ok(isValidTunnelKey(key))
    assert.equal(hashTunnelKey(key), hashTunnelKey(key))
    assert.notEqual(hashTunnelKey(key), hashTunnelKey(generateTunnelKey()))
  })

  it("rejects short or exotic keys", () => {
    assert.equal(isValidTunnelKey("short"), false)
    assert.equal(isValidTunnelKey("has spaces and is definitely long enough"), false)
  })
})

describe("validateRelayConfig", () => {
  const key = generateTunnelKey()

  it("fills defaults and normalizes fields", () => {
    const config = validateRelayConfig({ tunnels: [{ id: "Ompiui", key: ` ${key} ` }] })
    assert.equal(config.port, 8443)
    assert.equal(config.host, undefined)
    assert.deepEqual(config.tunnels, [{ id: "ompiui", key }])
  })

  it("accepts optional routing and tls blocks", () => {
    const config = validateRelayConfig({
      port: 443,
      host: "0.0.0.0",
      publicUrl: "https://relay.example.com/",
      domain: "Relay.Example.com",
      tls: { cert: "/certs/full.pem", key: "/certs/key.pem" },
      tunnels: [{ id: "pc1", key, host: "PC1.relay.example.com" }],
    })
    assert.equal(config.publicUrl, "https://relay.example.com")
    assert.equal(config.domain, "relay.example.com")
    assert.deepEqual(config.tunnels[0], { id: "pc1", key, host: "pc1.relay.example.com" })
  })

  it("rejects malformed configs with actionable messages", () => {
    assert.throws(() => validateRelayConfig(null), /top level/)
    assert.throws(() => validateRelayConfig({ tunnels: [] }), /non-empty array/)
    assert.throws(() => validateRelayConfig({ port: 70000, tunnels: [{ id: "a", key }] }), /port/)
    assert.throws(() => validateRelayConfig({ port: 8443, tunnels: [{ id: "Bad_Id", key }] }), /tunnels\[0\]\.id/)
    assert.throws(() => validateRelayConfig({ port: 8443, tunnels: [{ id: "a", key: "tiny" }] }), /tunnels\[0\]\.key/)
    assert.throws(
      () => validateRelayConfig({ port: 8443, tunnels: [{ id: "a", key }, { id: "a", key }] }),
      /duplicate tunnel id "a"/,
    )
    assert.throws(
      () => validateRelayConfig({ port: 8443, publicUrl: "ftp://x", tunnels: [{ id: "a", key }] }),
      /publicUrl/,
    )
    assert.throws(
      () => validateRelayConfig({ port: 8443, tls: { cert: "a" }, tunnels: [{ id: "a", key }] }),
      /tls\.cert and tls\.key/,
    )
  })
})

describe("writeInitialConfig / loadRelayConfig", () => {
  it("writes a config that loads back and refuses to overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-relay-test-"))
    const path = join(dir, "relay.config.json")
    try {
      const config = writeInitialConfig(path, { port: 9443, id: "mypc" })
      assert.equal(config.port, 9443)
      assert.equal(config.tunnels[0]!.id, "mypc")
      assert.equal(config.tunnels[0]!.key.length, 43)
      assert.ok(existsSync(path))
      const loaded = loadRelayConfig(path)
      assert.equal(loaded.tunnels[0]!.key, config.tunnels[0]!.key)
      assert.throws(() => writeInitialConfig(path), /refusing to overwrite/)
      assert.throws(() => loadRelayConfig(join(dir, "missing.json")), /not found/)
      // 文件内容是合法 JSON 且密钥为 43 字符
      const raw = JSON.parse(readFileSync(path, "utf8")) as { tunnels: Array<{ key: string }> }
      assert.equal(raw.tunnels[0]!.key.length, 43)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps the documented default tunnel id", () => {
    assert.equal(DEFAULT_TUNNEL_ID, "ompiui")
  })
})
