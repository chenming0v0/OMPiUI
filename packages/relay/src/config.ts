/**
 * 中转配置：relay.config.json 的读取、校验与 init 生成。
 *
 * 接入密钥沿用 Pebrel 的做法：43 字符 base64url（32 字节随机），服务端
 * 只存 SHA-256 摘要用于 timing-safe 比较——配置文件本身是唯一的明文落点，
 * 文档要求 chmod 600。
 */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

export interface RelayTunnelConfig {
  /** 隧道 ID：桌面端 x-ompiui-tunnel 头携带；也用作子域路由的标签。 */
  id: string
  /** 接入密钥（明文存配置文件，服务端运行时只保留摘要）。 */
  key: string
  /** 可选：把该隧道的公网流量绑定到一个主机名（如 pc1.relay.example.com）。 */
  host?: string
}

export interface RelayConfig {
  /** 监听端口。 */
  port: number
  /** 绑定地址；默认 127.0.0.1（反代场景），直连暴露需显式设 0.0.0.0/::。 */
  host?: string
  /** 对外宣传的入口 URL（无结尾斜杠）；缺省时用控制连接的 Host 推导。 */
  publicUrl?: string
  /** 可选：子域路由后缀，Host 为 <id>.<domain> 的流量路由到对应隧道。 */
  domain?: string
  /** 可选：内置 TLS；否则建议 Caddy/nginx 在前面终结 TLS。 */
  tls?: { cert: string; key: string }
  tunnels: RelayTunnelConfig[]
}

export const DEFAULT_RELAY_PORT = 8443
export const DEFAULT_RELAY_HOST = "127.0.0.1"
export const DEFAULT_TUNNEL_ID = "ompiui"
export const TUNNEL_KEY_LENGTH = 43

const TUNNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export function generateTunnelKey(): string {
  return randomBytes(32).toString("base64url")
}

export function hashTunnelKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex")
}

export function isValidTunnelKey(key: string): boolean {
  return key.length >= 16 && /^[A-Za-z0-9_-]+$/.test(key)
}

/** 读 + 校验；错误消息面向运维（直接指到 relay.config.json 的字段）。 */
export function loadRelayConfig(path: string): RelayConfig {
  if (!existsSync(path)) {
    throw new Error(`relay config not found: ${path} (run "omp-relay init" to create one)`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`relay config is not valid JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateRelayConfig(raw, path)
}

export function validateRelayConfig(raw: unknown, source = "relay.config.json"): RelayConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: top level must be an object`)
  }
  const body = raw as Record<string, unknown>
  const port = body.port === undefined ? DEFAULT_RELAY_PORT : Number(body.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source}: port must be an integer from 1 to 65535`)
  }
  const host = body.host === undefined ? undefined : String(body.host).trim() || undefined
  const normalizedPublicUrl = body.publicUrl === undefined ? null : normalizePublicUrl(String(body.publicUrl))
  if (body.publicUrl !== undefined && !normalizedPublicUrl) {
    throw new Error(`${source}: publicUrl must be an http(s) URL without trailing slash`)
  }
  const publicUrl = normalizedPublicUrl ?? undefined
  const domain = body.domain === undefined ? undefined : String(body.domain).trim().toLowerCase() || undefined
  if (body.domain !== undefined && !domain) {
    throw new Error(`${source}: domain must be a non-empty hostname`)
  }
  let tls: RelayConfig["tls"]
  if (body.tls !== undefined && body.tls !== null) {
    if (typeof body.tls !== "object" || Array.isArray(body.tls)) {
      throw new Error(`${source}: tls must be an object with cert/key file paths`)
    }
    const rawTls = body.tls as Record<string, unknown>
    const cert = typeof rawTls.cert === "string" ? rawTls.cert.trim() : ""
    const keyPath = typeof rawTls.key === "string" ? rawTls.key.trim() : ""
    if (!cert || !keyPath) throw new Error(`${source}: tls.cert and tls.key must be file paths`)
    tls = { cert, key: keyPath }
  }
  if (!Array.isArray(body.tunnels) || body.tunnels.length === 0) {
    throw new Error(`${source}: tunnels must be a non-empty array`)
  }
  const tunnels: RelayTunnelConfig[] = body.tunnels.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`${source}: tunnels[${index}] must be an object`)
    const item = entry as Record<string, unknown>
    const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : ""
    if (!TUNNEL_ID_PATTERN.test(id)) {
      throw new Error(`${source}: tunnels[${index}].id must match ${TUNNEL_ID_PATTERN.source}`)
    }
    const key = typeof item.key === "string" ? item.key.trim() : ""
    if (!isValidTunnelKey(key)) {
      throw new Error(`${source}: tunnels[${index}].key must be at least 16 base64url characters (use "omp-relay init" to generate)`)
    }
    const host = item.host === undefined || item.host === null || item.host === ""
      ? undefined
      : String(item.host).trim().toLowerCase()
    return host ? { id, key, host } : { id, key }
  })
  const ids = new Set<string>()
  for (const tunnel of tunnels) {
    if (ids.has(tunnel.id)) throw new Error(`${source}: duplicate tunnel id "${tunnel.id}"`)
    ids.add(tunnel.id)
  }
  return { port, host, publicUrl, domain, tls, tunnels }
}

/** init：生成只含一条隧道的初始配置；文件已存在时拒绝覆盖。 */
export function writeInitialConfig(path: string, options: { port?: number; id?: string; key?: string } = {}): RelayConfig {
  if (existsSync(path)) {
    throw new Error(`refusing to overwrite existing config: ${path}`)
  }
  const config: RelayConfig = {
    port: options.port ?? DEFAULT_RELAY_PORT,
    host: DEFAULT_RELAY_HOST,
    tunnels: [{ id: (options.id ?? DEFAULT_TUNNEL_ID).toLowerCase(), key: options.key ?? generateTunnelKey() }],
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  return config
}

/** 配置的 publicUrl 规范化：去斜杠/哈希，只认 http(s)。 */
function normalizePublicUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname)
  } catch {
    return null
  }
}
