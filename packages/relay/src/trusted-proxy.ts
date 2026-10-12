/**
 * 可信代理与访客 IP 解析(relay 专用)。
 *
 * 只有 TCP 对端属于显式配置的可信代理时才采纳 X-Forwarded-For:头部从右向左
 * 跳过可信代理跳,取第一个非可信地址作为访客。整条头只要有一个条目不是合法
 * IP 就整体作废(调用方回退为对端地址,不据此伪装访客)。未配置任何可信代理
 * 时永远不读取 XFF。
 */
import { isIP } from "node:net"

export interface TrustedNet {
  family: 4 | 6
  value: bigint
  prefix: number
}

export interface TrustedProxies {
  readonly nets: readonly TrustedNet[]
}

/** IPv4-mapped IPv6(::ffff:a.b.c.d)折叠为 IPv4;其余小写去空白。 */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  return mapped ? mapped[1]! : ip
}

function parseIpv4(ip: string): bigint | null {
  const octets = ip.split(".")
  if (octets.length !== 4) return null
  let value = 0n
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) return null
    value = (value << 8n) + BigInt(Number(octet))
  }
  return value
}

function parseIpv6(ip: string): bigint | null {
  let text = ip
  const tail4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail4) {
    const low = parseIpv4(tail4[1]!)
    if (low === null) return null
    text = `${text.slice(0, tail4.index)}${((low >> 16n) & 0xffffn).toString(16)}:${(low & 0xffffn).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (missing < 0) return null
  const groups = [...head, ...new Array<string>(missing).fill("0"), ...tail]
  if (groups.length !== 8) return null
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    value = (value << 16n) + BigInt(Number.parseInt(group, 16))
  }
  return value
}

function parseIp(ip: string): { family: 4 | 6; value: bigint } | null {
  const kind = isIP(ip)
  if (kind === 4) {
    const value = parseIpv4(ip)
    return value === null ? null : { family: 4, value }
  }
  if (kind === 6) {
    const value = parseIpv6(ip)
    return value === null ? null : { family: 6, value }
  }
  return null
}

/** 解析单个 IP 或 CIDR(如 127.0.0.1、10.0.0.0/8、::1、fd00::/8)。非法返回 null。 */
export function parseTrustedProxyEntry(input: string): TrustedNet | null {
  const [address, prefixText, extra] = input.trim().split("/")
  if (!address || extra !== undefined) return null
  const parsed = parseIp(normalizeIp(address))
  if (!parsed) return null
  const max = parsed.family === 4 ? 32 : 128
  let prefix = max
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > max) return null
    prefix = Number(prefixText)
  }
  return { ...parsed, prefix }
}

export function parseTrustedProxies(inputs: readonly string[]): TrustedProxies {
  const nets: TrustedNet[] = []
  for (const input of inputs) {
    const net = parseTrustedProxyEntry(input)
    if (net) nets.push(net)
  }
  return { nets }
}

export function isTrustedProxy(peer: string | undefined, trusted: TrustedProxies): boolean {
  if (!peer || trusted.nets.length === 0) return false
  const parsed = parseIp(normalizeIp(peer))
  if (!parsed) return false
  return trusted.nets.some(net => {
    if (net.family !== parsed.family) return false
    const shift = BigInt((parsed.family === 4 ? 32 : 128) - net.prefix)
    return (parsed.value >> shift) === (net.value >> shift)
  })
}

/**
 * 从 X-Forwarded-For 取访客 IP:整条头必须全部是合法 IP;从右向左跳过可信代理,
 * 返回第一个非可信地址。无法确定时返回 null(调用方使用对端地址)。
 */
export function resolveForwardedClient(header: string | string[] | undefined, trusted: TrustedProxies): string | null {
  if (typeof header !== "string") return null
  const hops = header.split(",").map(part => normalizeIp(part))
  if (hops.some(hop => !parseIp(hop))) return null
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = hops[index]!
    if (!isTrustedProxy(hop, trusted)) return hop
  }
  return null
}
