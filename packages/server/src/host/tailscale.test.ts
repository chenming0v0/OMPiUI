import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mapStatusJson, resolveDownloadTarget } from "./tailscale.ts"

const LISTING = `
<tr><td><a href="tailscale-setup-1.102.4-amd64.msi">tailscale-setup-1.102.4-amd64.msi</a></td></tr>
<tr><td><a href="tailscale-setup-1.102.4-arm64.msi">tailscale-setup-1.102.4-arm64.msi</a></td></tr>
<tr><td><a href="tailscale-setup-1.102.4-x86.msi">tailscale-setup-1.102.4-x86.msi</a></td></tr>
<tr><td><a href="tailscale_1.102.4_amd64.tgz">tailscale_1.102.4_amd64.tgz</a></td></tr>
<tr><td><a href="tailscale_1.102.4_arm64.tgz">tailscale_1.102.4_arm64.tgz</a></td></tr>
`

describe("resolveDownloadTarget", () => {
  it("picks the Windows MSI for the current arch", () => {
    assert.deepEqual(resolveDownloadTarget(LISTING, "win32", "x64"), {
      version: "1.102.4",
      url: "https://pkgs.tailscale.com/stable/tailscale-setup-1.102.4-amd64.msi",
      file: "tailscale-setup-1.102.4-amd64.msi",
      kind: "msi",
    })
    assert.equal(resolveDownloadTarget(LISTING, "win32", "arm64")?.file, "tailscale-setup-1.102.4-arm64.msi")
    assert.equal(resolveDownloadTarget(LISTING, "win32", "ia32")?.file, "tailscale-setup-1.102.4-x86.msi")
  })

  it("picks the Linux tarball for the current arch", () => {
    assert.deepEqual(resolveDownloadTarget(LISTING, "linux", "x64"), {
      version: "1.102.4",
      url: "https://pkgs.tailscale.com/stable/tailscale_1.102.4_amd64.tgz",
      file: "tailscale_1.102.4_amd64.tgz",
      kind: "tgz",
    })
    assert.equal(resolveDownloadTarget(LISTING, "linux", "arm64")?.file, "tailscale_1.102.4_arm64.tgz")
    assert.equal(resolveDownloadTarget(LISTING, "linux", "armv7l"), null)
  })

  it("returns null for unsupported platforms and unknown listings", () => {
    assert.equal(resolveDownloadTarget(LISTING, "darwin", "arm64"), null)
    assert.equal(resolveDownloadTarget("<html></html>", "win32", "x64"), null)
  })
})

describe("mapStatusJson", () => {
  it("maps a full tailscale status payload", () => {
    const mapped = mapStatusJson({
      Version: "1.102.4-tc1234-abcd",
      BackendState: "Running",
      AuthURL: "",
      TailscaleIPs: ["100.101.1.2", "fd7a:115c:a1e0::1"],
      Self: { DNSName: "my-pc.tail scale.ts.net." },
    })
    assert.equal(mapped.backendState, "Running")
    assert.deepEqual(mapped.ips, ["100.101.1.2", "fd7a:115c:a1e0::1"])
    assert.equal(mapped.authUrl, null)
    assert.equal(mapped.hostName, "my-pc.tail scale.ts.net")
    assert.equal(mapped.version, "1.102.4")
  })

  it("keeps https auth URLs and survives malformed payloads", () => {
    const mapped = mapStatusJson({
      BackendState: "NeedsLogin",
      AuthURL: "https://login.tailscale.com/a/abc123",
      TailscaleIPs: "oops",
    })
    assert.equal(mapped.backendState, "NeedsLogin")
    assert.equal(mapped.authUrl, "https://login.tailscale.com/a/abc123")
    assert.deepEqual(mapped.ips, [])

    const junk = mapStatusJson("not an object")
    assert.equal(junk.backendState, null)
    assert.deepEqual(junk.ips, [])
    assert.deepEqual(mapStatusJson(null).ips, [])
  })
})
