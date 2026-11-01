import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseDeviceDiscoveryInfo } from "./device-discovery.ts"

const info = { marker: "ompiui", discoveryVersion: 1, displayName: "电脑", instanceId: "a".repeat(32), port: 9191, pairing: true }
describe("discovery contract", () => {
  it("keeps only discovery metadata, never copied credentials", () => {
    assert.deepEqual(parseDeviceDiscoveryInfo({ ...info, token: "secret", code: "12345678", pair: "id.secret", url: "file:///tmp" }), info)
  })
  for (const change of [{ marker: "other" }, { discoveryVersion: 2 }, { displayName: "" }, { displayName: "x".repeat(129) },
    { displayName: "bad\nname" }, { instanceId: "session" }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { pairing: false }]) {
    it(`rejects malformed metadata ${JSON.stringify(change)}`, () => assert.equal(parseDeviceDiscoveryInfo({ ...info, ...change }), null))
  }
})
