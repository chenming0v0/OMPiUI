import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { adminDataDir, adminTokenPath } from "./config.ts"

/** Proves a management API is the process that spawned the backend. */
export const OWNER_NONCE_HEADER = "x-ompiui-owner-nonce"

export interface OwnerRecord {
  pid: number
  host: string
  port: number
  nonce: string
}

export type OwnerControlAction = "stop" | "restart"

export type OwnerControlResult =
  | { ok: true }
  | { ok: false; message: string }

export function ownerRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${adminDataDir(env)}/owner.json`
}

export function createOwnerNonce(): string {
  return randomBytes(32).toString("base64url")
}

/** Existence check only. Signal 0 never terminates the process. */
export function ownerPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function nonceEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function validRecord(value: unknown): OwnerRecord | null {
  if (!value || typeof value !== "object") return null
  const source = value as Record<string, unknown>
  const { pid, port, host, nonce } = source
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (typeof host !== "string" || host.trim() !== host || !host) return null
  if (typeof nonce !== "string" || !nonce) return null
  return { pid, port, host, nonce }
}

export function readOwnerRecord(env: NodeJS.ProcessEnv = process.env): OwnerRecord | null {
  try {
    return validRecord(JSON.parse(readFileSync(ownerRecordPath(env), "utf8")))
  } catch {
    return null
  }
}

export function writeOwnerRecord(record: OwnerRecord, env: NodeJS.ProcessEnv = process.env): void {
  const file = ownerRecordPath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
  try { chmodSync(file, 0o600) } catch { /* Windows has no POSIX mode bits. */ }
}

/** Removes the record only when `nonce` matches, so a newer owner is left alone. */
export function removeOwnerRecord(env: NodeJS.ProcessEnv, nonce: string): void {
  const current = readOwnerRecord(env)
  if (current && !nonceEqual(current.nonce, nonce)) return
  rmSync(ownerRecordPath(env), { force: true })
}

function readAdminToken(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.OMPIUI_ADMIN_TOKEN?.trim()
  if (configured) return configured
  try {
    const token = readFileSync(adminTokenPath(env), "utf8").trim()
    return token || undefined
  } catch {
    return undefined
  }
}

function discardRecord(env: NodeJS.ProcessEnv, message: string): OwnerControlResult {
  rmSync(ownerRecordPath(env), { force: true })
  return { ok: false, message }
}

function impossible(action: OwnerControlAction, detail: string): OwnerControlResult {
  return { ok: false, message: `${action} is not possible: ${detail}` }
}

function loopbackBase(record: OwnerRecord): string | null {
  if (record.host === "127.0.0.1" || record.host === "localhost" || record.host === "0.0.0.0") {
    return `http://127.0.0.1:${record.port}`
  }
  if (record.host === "::1" || record.host === "::") return `http://[::1]:${record.port}`
  return null
}

interface OwnerIdentity {
  pid: number
  nonce: string
}

/**
 * Ask the live owning manager to stop or restart. Connects only to loopback
 * and only after the process proves it still holds this record's nonce.
 * Never signals a PID except for the existence probe above.
 */
export async function controlOwnedBackend(
  action: OwnerControlAction,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OwnerControlResult> {
  const file = ownerRecordPath(env)
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, message: "nothing managed is running" }
    }
    return discardRecord(env, "nothing managed is running; removed stale owner metadata")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return discardRecord(env, "nothing managed is running; removed stale owner metadata")
  }
  const record = validRecord(parsed)
  if (!record) return discardRecord(env, "nothing managed is running; removed stale owner metadata")
  if (!ownerPidAlive(record.pid)) {
    removeOwnerRecord(env, record.nonce)
    return { ok: false, message: "nothing managed is running; removed stale owner metadata" }
  }
  const token = readAdminToken(env)
  if (!token) return impossible(action, "admin token is not available")
  // Never dial the recorded host. A local bind is reached on loopback; anything
  // else is refused so a tampered record cannot be sent the admin token.
  const base = loopbackBase(record)
  if (!base) return impossible(action, `owner address ${record.host} is not local`)
  const identity = await readIdentity(base, token)
  if (!identity.ok) return impossible(action, identity.detail)
  if (identity.body.pid !== record.pid || !nonceEqual(identity.body.nonce, record.nonce)) {
    return impossible(action, "the process on the recorded admin port is not the recorded owner")
  }
  try {
    const response = await fetch(`${base}/api/service/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, [OWNER_NONCE_HEADER]: record.nonce },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null
      return impossible(action, body?.error ?? `owner returned HTTP ${response.status}`)
    }
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return impossible(action, `owner accepted identity but ${action} failed (${detail})`)
  }
}

async function readIdentity(
  base: string,
  token: string,
): Promise<{ ok: true; body: OwnerIdentity } | { ok: false; detail: string }> {
  try {
    const response = await fetch(`${base}/api/owner`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    })
    if (response.status === 401) return { ok: false, detail: "the admin token was rejected" }
    if (!response.ok) return { ok: false, detail: `owning manager did not prove ownership (HTTP ${response.status})` }
    const body = await response.json() as { pid?: unknown; nonce?: unknown }
    if (typeof body.pid !== "number" || typeof body.nonce !== "string") {
      return { ok: false, detail: "owning manager did not prove ownership" }
    }
    return { ok: true, body: { pid: body.pid, nonce: body.nonce } }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: `owning manager is not reachable at ${base} (${detail})` }
  }
}
