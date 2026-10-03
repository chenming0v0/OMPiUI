import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { filterLanInterfaces, isTailscaleAddress } from "./network.ts"

describe("isTailscaleAddress", () => {
  it("recognizes the 100.64.0.0/10 CGNAT range", () => {
    assert.equal(isTailscaleAddress("100.64.0.1"), true)
    assert.equal(isTailscaleAddress("100.101.112.113"), true)
    assert.equal(isTailscaleAddress("100.127.255.254"), true)
    assert.equal(isTailscaleAddress("100.63.255.254"), false)
    assert.equal(isTailscaleAddress("100.128.0.1"), false)
    assert.equal(isTailscaleAddress("192.168.1.124"), false)
    assert.equal(isTailscaleAddress("not-an-ip"), false)
  })
})

describe("filterLanInterfaces", () => {
  const raw = {
    以太网: [
      { family: 4, address: "192.168.1.124", internal: false },
      { family: "IPv6", address: "fe80::1", internal: false },
      { family: 4, address: "127.0.0.1", internal: true },
    ],
    Tailscale: [{ family: 4, address: "10.1.2.3", internal: false }],
    loopback_pseudo: [{ family: 4, address: "100.77.88.99", internal: false }],
  }

  it("keeps only reachable IPv4 addresses and flags Tailscale ones", () => {
    const list = filterLanInterfaces(raw)
    assert.deepEqual(list, [
      { name: "以太网", address: "192.168.1.124", tailscale: false },
      // 名字不带 Tailscale 但地址在 CGNAT 段，也按 Tailscale 处理
      { name: "loopback_pseudo", address: "100.77.88.99", tailscale: true },
      { name: "Tailscale", address: "10.1.2.3", tailscale: true },
    ])
  })

  it("prefers the Tailscale label when an address has multiple names", () => {
    const list = filterLanInterfaces({
      a: [{ family: 4, address: "100.64.0.9", internal: false }],
      Tailscale: [{ family: 4, address: "100.64.0.9", internal: false }],
    })
    assert.equal(list.length, 1)
    assert.equal(list[0]!.name, "Tailscale")
  })

  it("drops interfaces without usable IPv4", () => {
    assert.deepEqual(filterLanInterfaces({ v6only: [{ family: 6, address: "::1", internal: false }] }), [])
    assert.deepEqual(filterLanInterfaces({}), [])
  })
})
