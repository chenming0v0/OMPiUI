import { Bonjour, type ServiceConfig } from "bonjour-service"
import { isIP } from "node:net"
import type { EventEmitter } from "node:events"
import type { DeviceDiscoveryInfo } from "@ompiui/protocol"
import { listLanInterfaces, type LanInterface } from "./network.ts"

export function discoveryAddresses(host: string, interfaces: LanInterface[]): string[] {
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return []
  return interfaces.filter(item => !item.tailscale && isIP(item.address) === 4 &&
    !item.address.startsWith("127.") && !item.address.startsWith("169.254.") && item.address !== "0.0.0.0" &&
    (["0.0.0.0", "::"].includes(host) || host === item.address)).map(item => item.address)
}

type Publisher = Pick<Bonjour, "publish" | "unpublishAll" | "destroy">
type Options = {
  interfaces?: () => LanInterface[]
  createPublisher?: (address: string, onError: (error: Error) => void) => Publisher
  log?: (error: unknown) => void
  intervalMs?: number
}

/** One multicast membership per reachable interface; never announce other adapters. */
export function advertiseDevice(host: string, info: DeviceDiscoveryInfo, options: Options = {}): { stop(): Promise<void> } {
  const publishers = new Map<string, Publisher>()
  const failed = new Set<string>()
  const interfaces = options.interfaces ?? listLanInterfaces
  const log = options.log ?? (() => {})
  const create = options.createPublisher ?? ((address, onError) => {
    const publisher = new Bonjour({ interface: address, bind: "0.0.0.0" } as Partial<ServiceConfig>, onError)
    // The library's callback covers response errors, but not socket errors.
    const mdns = (publisher as unknown as { server: { mdns: EventEmitter } }).server.mdns
    mdns.on("error", onError)
    mdns.on("warning", onError)
    return publisher
  })
  let stopped = false
  const withdraw = async (publisher: Publisher) => {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 250)
      publisher.unpublishAll(() => { clearTimeout(timeout); resolve() })
    }).catch(log)
    publisher.destroy()
  }
  const refresh = () => {
    if (stopped) return
    try {
      const addresses = new Set(discoveryAddresses(host, interfaces()))
      for (const [address, publisher] of publishers) {
        if (addresses.has(address)) continue
        publishers.delete(address)
        failed.delete(address)
        void withdraw(publisher)
      }
      for (const address of failed) if (!addresses.has(address)) failed.delete(address)
      for (const address of addresses) {
        if (publishers.has(address) || failed.has(address)) continue
        let publisher: Publisher | undefined
        try {
          publisher = create(address, error => {
            log(error)
            failed.add(address)
            const active = publishers.get(address)
            publishers.delete(address)
            if (active) void withdraw(active)
          })
          const suffix = address.replaceAll(".", "-")
          const service = publisher.publish({
            name: `OMPiUI-${info.instanceId.slice(0, 12)}-${suffix}`, type: "ompiui", port: info.port,
            host: `ompiui-${info.instanceId}-${suffix}.local`, disableIPv6: true,
            txt: { marker: info.marker, discoveryVersion: String(info.discoveryVersion), displayName: info.displayName,
              instanceId: info.instanceId, port: String(info.port), pairing: "true" },
          })
          const records = service.records.bind(service)
          // bonjour-service normally appends all OS addresses. Restrict address
          // records before its asynchronous probe registers/announces the service.
          service.records = () => [...records().filter(record => record.type !== "A" && record.type !== "AAAA")
            .map(record => ({ ...record, ttl: Math.min(record.ttl, 120) })),
            { name: service.host, type: "A", ttl: 120, data: address }]
          publishers.set(address, publisher)
        } catch (error) {
          failed.add(address)
          log(error)
          publisher?.destroy()
        }
      }
    } catch (error) { log(error) }
  }
  refresh()
  const timer = setInterval(refresh, options.intervalMs ?? 5_000)
  timer.unref()
  return { async stop() {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    await Promise.all([...publishers.values()].map(withdraw))
    publishers.clear()
  } }
}
