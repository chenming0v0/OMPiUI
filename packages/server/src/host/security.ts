import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

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

export function requestHasAllowedOrigin(req: IncomingMessage, allowedOrigin?: string | null): boolean {
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
  // 配置了公网基址时放行它的 Origin：反向代理若把 Host 重写成上游地址
  // （localhost:8787），浏览器页面的 Origin（https://panel.example.com）和
  // Host 不再相等，同源分支放不了行——这里以运营者显式配置的基址为准。
  if (allowedOrigin) {
    try {
      return new URL(origin).origin === new URL(allowedOrigin).origin
    } catch {
      return false
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
