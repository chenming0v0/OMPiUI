export const DEVICE_DISCOVERY_VERSION = 1
export const DEVICE_DISCOVERY_SERVICE = "ompiui"
export const DEVICE_DISCOVERY_PORT = 18787

export interface DeviceDiscoveryInfo {
  marker: "ompiui"
  discoveryVersion: typeof DEVICE_DISCOVERY_VERSION
  displayName: string
  instanceId: string
  port: number
  pairing: true
}

export interface DiscoveredDevice extends DeviceDiscoveryInfo {
  address: string
  network: "lan" | "tailscale"
}

/** Discovery identifies an endpoint, never authorizes it. Keep credentials out. */
export function parseDeviceDiscoveryInfo(value: unknown): DeviceDiscoveryInfo | null {
  if (!value || typeof value !== "object") return null
  const info = value as Record<string, unknown>
  if (info.marker !== "ompiui" || info.discoveryVersion !== DEVICE_DISCOVERY_VERSION || info.pairing !== true ||
      typeof info.displayName !== "string" || !info.displayName.trim() || info.displayName.length > 128 || /[\x00-\x1f\x7f]/.test(info.displayName) ||
      typeof info.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(info.instanceId) ||
      typeof info.port !== "number" || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return null
  return { marker: "ompiui", discoveryVersion: DEVICE_DISCOVERY_VERSION, displayName: info.displayName,
    instanceId: info.instanceId, port: info.port, pairing: true }
}
