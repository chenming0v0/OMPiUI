import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { isIP } from "node:net"

/** Private to the embedded tunnel's loopback hop; never sent to the relay. */
export const TUNNEL_FORWARDING_HEADER = "x-ompiui-internal-tunnel"

/** Only the per-start authenticated loopback hop may supply a relay client IP. */
export function pairingClientKey(req: IncomingMessage, tunnelForwardingToken?: string): string {
  const peer = req.socket.remoteAddress ?? "unknown"
  const marker = req.headers[TUNNEL_FORWARDING_HEADER]
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1"
  if (!loopback || !tunnelForwardingToken || typeof marker !== "string" ||
      !timingSafeTokenEquals(marker, tunnelForwardingToken)) return peer

  // The relay overwrites XFF with its public socket's single IP, never a chain.
  const forwarded = req.headers["x-forwarded-for"]
  return typeof forwarded === "string" && isIP(forwarded)
    ? `relay:${forwarded}`
    : peer
}

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i

export const MAX_JSON_BODY_BYTES = 1024 * 1024
export const MAX_PROMPT_BODY_BYTES = 24 * 1024 * 1024

/** Browser clients must originate from a local PiUI/Vite page. */
export function isAllowedLocalOrigin(origin: string | undefined): boolean {
  return origin === undefined || LOCAL_ORIGIN.test(origin) || isTauriOrigin(origin)
}

function isTauriOrigin(origin: string): boolean {
  return origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost"
}

/**
 * 额外放行的 Origin 集合：可以是单个基址、一组基址，或返回基址数组的
 * getter（自建中转隧道连上后才会知道公网入口，必须动态取）。
 */
export type AllowedOrigins =
  | string
  | null
  | undefined
  | readonly (string | null | undefined)[]
  | (() => string | null | undefined | readonly (string | null | undefined)[])

export function requestHasAllowedOrigin(req: IncomingMessage, allowedOrigins?: AllowedOrigins): boolean {
  const origin = req.headers.origin
  if (typeof origin !== "string") return true
  if (isAllowedLocalOrigin(origin)) return true
  // 同源的 LAN 访问（手机浏览器打开 http://192.168.x.x:8787 后页面内 fetch）
  // Origin 的 host 必然等于请求的 Host，放行；跨站请求仍然拒绝
  const host = req.headers.host
  if (typeof host === "string") {
    try {
      if (new URL(origin).host === host) return true
    } catch {
      return false
    }
  }
  // 配置了公网入口时放行它的 Origin：反向代理/隧道若把 Host 重写成上游
  // 地址（localhost:8787），浏览器页面的 Origin（https://panel.example.com）
  // 和 Host 不再相等，同源分支放不了行——以运营者声明的公网入口为准。
  const candidates = typeof allowedOrigins === "function" ? allowedOrigins() : allowedOrigins
  const list = candidates === undefined || candidates === null
    ? []
    : Array.isArray(candidates)
      ? candidates
      : [candidates]
  for (const candidate of list) {
    if (!candidate) continue
    try {
      if (new URL(origin).origin === new URL(candidate).origin) return true
    } catch {
      // 单个非法配置只跳过自身，不牵连其它条目
      continue
    }
  }
  return false
}

/**
 * `token` is null only when a caller deliberately runs without authentication,
 * which is limited to tests. Callers that pass a token always require it: an
 * absent token used to mean "allow everyone", so simply not configuring one
 * left the API open to every local process.
 */
export function requestHasValidToken(req: IncomingMessage, token: string | null): boolean {
  if (token === null) return true
  const authorization = req.headers.authorization
  return typeof authorization === "string" && timingSafeTokenEquals(authorization, `Bearer ${token}`)
}

/** Compares without leaking length or position through timing. */
export function timingSafeTokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
