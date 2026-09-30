import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import { describe, it } from "node:test"
import { requestHasAllowedOrigin } from "./security.ts"

function reqWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

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
