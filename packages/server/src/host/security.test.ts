import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import { describe, it } from "node:test"
import { pairingClientKey, requestHasAllowedOrigin, TUNNEL_FORWARDING_HEADER } from "./security.ts"

function reqWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe("pairingClientKey", () => {
  const token = "private-per-start-token"
  const request = (peer: string, headers: IncomingMessage["headers"]): IncomingMessage =>
    ({ socket: { remoteAddress: peer }, headers }) as IncomingMessage

  it("requires both loopback and the private marker, not just forwarding headers", () => {
    const headers = { [TUNNEL_FORWARDING_HEADER]: token, "x-forwarded-for": "198.51.100.7" }
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(pairingClientKey(request(peer, headers), token), "relay:198.51.100.7")
      assert.equal(pairingClientKey(request(peer, headers)), peer)
      assert.equal(pairingClientKey(request(peer, headers), "different-start-token"), peer)
      assert.equal(pairingClientKey(request(peer, { "x-forwarded-for": "198.51.100.7" }), token), peer)
    }
    assert.equal(pairingClientKey(request("192.0.2.5", headers), token), "192.0.2.5")
  })

  it("accepts only a single relay IP and rejects ambiguous headers", () => {
    for (const forwarded of [undefined, "", "not-an-ip", "198.51.100.7, 192.0.2.5", ["198.51.100.7"]]) {
      assert.equal(pairingClientKey(request("127.0.0.1", {
        [TUNNEL_FORWARDING_HEADER]: token,
        "x-forwarded-for": forwarded,
      }), token), "127.0.0.1")
    }
    assert.equal(pairingClientKey(request("127.0.0.1", {
      [TUNNEL_FORWARDING_HEADER]: [token, token],
      "x-forwarded-for": "198.51.100.7",
    }), token), "127.0.0.1")
    assert.equal(pairingClientKey(request("127.0.0.1", {
      [TUNNEL_FORWARDING_HEADER]: token,
      "x-forwarded-for": "2001:db8::5",
    }), token), "relay:2001:db8::5")
  })
})

describe("requestHasAllowedOrigin", () => {
  it("allows same-origin LAN requests and local origins", () => {
    assert.equal(requestHasAllowedOrigin(reqWith({ origin: "http://192.168.1.5:8787", host: "192.168.1.5:8787" })), true)
    assert.equal(requestHasAllowedOrigin(reqWith({ origin: "http://localhost:5173", host: "127.0.0.1:8787" })), true)
    // 无 Origin 头（curl / 同源 GET 导航）不受限
    assert.equal(requestHasAllowedOrigin(reqWith({})), true)
  })

  it("rejects cross-site origins", () => {
    assert.equal(requestHasAllowedOrigin(reqWith({ origin: "https://evil.example", host: "192.168.1.5:8787" })), false)
    assert.equal(requestHasAllowedOrigin(reqWith({ origin: "https://192.168.1.5.evil.io", host: "192.168.1.5:8787" })), false)
  })

  it("allows the configured public base URL origin even when the proxy rewrites Host", () => {
    // 反代把 Host 重写成上游（localhost:8787），浏览器页面的 Origin 仍是对外域名
    assert.equal(
      requestHasAllowedOrigin(
        reqWith({ origin: "https://panel.example.com", host: "localhost:8787" }),
        "https://panel.example.com",
      ),
      true,
    )
  })

  it("matches the public origin exactly, not by prefix", () => {
    assert.equal(
      requestHasAllowedOrigin(
        reqWith({ origin: "https://panel.example.com.evil.io", host: "localhost:8787" }),
        "https://panel.example.com",
      ),
      false,
    )
    assert.equal(
      requestHasAllowedOrigin(
        reqWith({ origin: "https://panel.example.com:8443", host: "localhost:8787" }),
        "https://panel.example.com",
      ),
      false,
    )
  })
})
