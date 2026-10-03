/**
 * 手机远程的网卡列表：只暴露可从其他设备访问的 IPv4 地址，并识别
 * Tailscale 接口（名字带 tailscale，或地址落在 100.64.0.0/10 CGNAT 段）
 * ——配对二维码选它就是「局域网 / Tailscale」直连模式。
 */

import { networkInterfaces } from "node:os"

export interface LanInterface {
  name: string
  address: string
  tailscale: boolean
}

const TAILSCALE_INTERFACE_NAME = /tailscale/i

/** 100.64.0.0/10（CGNAT）段判定：Tailscale 分配的地址都在这里。 */
export function isTailscaleAddress(address: string): boolean {
  const parts = address.split(".").map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number]
  return a === 100 && b >= 64 && b <= 127
}

/** 纯过滤逻辑（便于测试）：从 os.networkInterfaces() 的原始结构挑可用项。 */
export function filterLanInterfaces(
  raw: Record<string, Array<{ family: string | number; address: string; internal: boolean } | undefined> | undefined>,
): LanInterface[] {
  const byAddress = new Map<string, LanInterface>()
  for (const [name, infos] of Object.entries(raw)) {
    for (const info of infos ?? []) {
      if (!info || info.internal) continue
      // Node 18+ 的 family 是数值（4/6），老版本是字符串 'IPv4'
      const isV4 = info.family === 4 || info.family === "IPv4"
      if (!isV4) continue
      const tailscale = TAILSCALE_INTERFACE_NAME.test(name) || isTailscaleAddress(info.address)
      const existing = byAddress.get(info.address)
      const namedTailscale = TAILSCALE_INTERFACE_NAME.test(name)
      // 同址多网卡时优先保留 Tailscale 语义：先看标记，再看名字可读性
      const preferNew = !existing ||
        (tailscale && !existing.tailscale) ||
        (namedTailscale && !TAILSCALE_INTERFACE_NAME.test(existing.name))
      if (preferNew) {
        byAddress.set(info.address, { name, address: info.address, tailscale })
      }
    }
  }
  return [...byAddress.values()].sort((left, right) => {
    if (left.tailscale !== right.tailscale) return left.tailscale ? 1 : -1
    return left.name.localeCompare(right.name)
  })
}

export function listLanInterfaces(): LanInterface[] {
  return filterLanInterfaces(networkInterfaces() as Parameters<typeof filterLanInterfaces>[0])
}
