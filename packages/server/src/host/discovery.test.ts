import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { advertiseDevice, discoveryAddresses } from "./discovery.ts"
import type { LanInterface } from "./network.ts"
import type { ServiceConfig, Service } from "bonjour-service"

const info = { marker: "ompiui", discoveryVersion: 1, displayName: "My computer", instanceId: "a".repeat(32), port: 9191, pairing: true } as const
const interfaces: LanInterface[] = [
  { name: "Wi-Fi", address: "192.168.1.10", tailscale: false },
  { name: "Ethernet", address: "10.0.0.5", tailscale: false },
  { name: "tailscale", address: "100.64.0.1", tailscale: true },
]
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe("device advertisement", () => {
  it("announces only addresses permitted by the existing listener", () => {
    assert.deepEqual(discoveryAddresses("127.0.0.1", interfaces), [])
    assert.deepEqual(discoveryAddresses("::1", interfaces), [])
    assert.deepEqual(discoveryAddresses("0.0.0.0", interfaces), ["192.168.1.10", "10.0.0.5"])
    assert.deepEqual(discoveryAddresses("192.168.1.10", interfaces), ["192.168.1.10"])
    assert.deepEqual(discoveryAddresses("100.64.0.1", interfaces), [])
  })

  it("publishes the actual port and minimal metadata without other adapter addresses", async () => {
    const calls: Array<{ address: string; config: ServiceConfig; service: Service }> = []
    let withdrawn = 0
    let destroyed = 0
    const advertisement = advertiseDevice("0.0.0.0", info, {
      interfaces: () => interfaces,
      createPublisher: address => ({
        publish: config => {
          const service = { host: config.host, records: () => [
            { name: config.host, type: "A", data: "100.64.0.1", ttl: 120 },
            { name: config.host, type: "AAAA", data: "::1", ttl: 120 },
            { name: config.name, type: "SRV", data: { port: config.port }, ttl: 4500 },
          ] } as Service
          calls.push({ address, config, service })
          return service
        }, unpublishAll: callback => { withdrawn++; callback?.() }, destroy: () => { destroyed++ },
      }),
    })
    cleanups.push(advertisement.stop)
    assert.equal(calls.length, 2)
    for (const call of calls) {
      assert.equal(call.config.port, 9191)
      assert.deepEqual(Object.keys(call.config.txt!).sort(), ["discoveryVersion", "displayName", "instanceId", "marker", "pairing", "port"])
      assert.deepEqual(call.service.records().filter(record => record.type === "A").map(record => record.data), [call.address])
      assert.equal(call.service.records().some(record => record.type === "AAAA"), false)
      assert.ok(call.service.records().every(record => record.ttl <= 120))
    }
    await advertisement.stop()
    await advertisement.stop()
    assert.equal(withdrawn, 2)
    assert.equal(destroyed, 2)
  })

  it("withdraws vanished interfaces and publishes new ones", async () => {
    let addresses = interfaces.slice(0, 1)
    const published: string[] = []
    const destroyed: string[] = []
    const advertisement = advertiseDevice("0.0.0.0", info, {
      interfaces: () => addresses, intervalMs: 10,
      createPublisher: address => ({
        publish: config => { published.push(address); return { host: config.host, records: () => [] } as unknown as Service },
        unpublishAll: callback => callback?.(), destroy: () => { destroyed.push(address) },
      }),
    })
    cleanups.push(advertisement.stop)
    addresses = interfaces.slice(1, 2)
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.deepEqual(published, ["192.168.1.10", "10.0.0.5"])
    assert.deepEqual(destroyed, ["192.168.1.10"])
  })

  it("keeps advertisement failure nonfatal and does not retry every timer tick", async () => {
    let attempts = 0
    const errors: unknown[] = []
    const advertisement = advertiseDevice("192.168.1.10", info, {
      interfaces: () => interfaces, intervalMs: 10,
      createPublisher: () => { attempts++; throw new Error("multicast blocked") }, log: error => errors.push(error),
    })
    cleanups.push(advertisement.stop)
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(attempts, 1)
    assert.equal(errors.length, 1)
  })
})
