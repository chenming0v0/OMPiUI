import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export interface AdminConfig {
  host: string
  port: number
  serverCommand: string
  serverArgs: string[]
  serverCwd: string
  serverEnv: Record<string, string>
  serverUrl: string
}

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 9898
const DEFAULT_SERVER_URL = "http://127.0.0.1:8787"

export function adminDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OMPIUI_ADMIN_DATA_DIR?.trim() || env.OMPIUI_DATA_DIR?.trim()
  return resolve(explicit || join(homedir(), ".ompiui"))
}

export function adminConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(adminDataDir(env), "admin.json")
}

export function adminTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(adminDataDir(env), "admin-token")
}

function defaultServerCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const configured = env.OMPIUI_SERVER_ENTRY?.trim()
  if (configured) return { command: process.execPath, args: [configured, "web"] }
  const entry = resolve(process.cwd(), "packages/server/dist/bundle-entry.js")
  return { command: process.execPath, args: [entry, "web"] }
}

export function defaultAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const server = defaultServerCommand(env)
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    serverCommand: server.command,
    serverArgs: server.args,
    serverCwd: process.cwd(),
    serverEnv: {},
    serverUrl: env.OMPIUI_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
  }
}

function validPort(value: unknown, fallback: number): number {
  const port = typeof value === "number" ? value : Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

function normalizeConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const defaults = defaultAdminConfig(env)
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const serverEnv = source.serverEnv && typeof source.serverEnv === "object"
    ? Object.fromEntries(Object.entries(source.serverEnv).filter(([key, item]) => /^[A-Z_][A-Z0-9_]*$/i.test(key) && typeof item === "string")) as Record<string, string>
    : defaults.serverEnv
  const configuredEntry = env.OMPIUI_SERVER_ENTRY?.trim()
  const configuredServer = configuredEntry ? { command: process.execPath, args: [configuredEntry, "web"] } : null
  const storedArgs = Array.isArray(source.serverArgs) && source.serverArgs.every(item => typeof item === "string")
    ? source.serverArgs as string[]
    : defaults.serverArgs
  const storedCommand = typeof source.serverCommand === "string" && source.serverCommand.trim() ? source.serverCommand : defaults.serverCommand
  const storedCwd = typeof source.serverCwd === "string" && source.serverCwd.trim() ? resolve(source.serverCwd) : defaults.serverCwd
  const storedServer = configuredServer ?? { command: storedCommand, args: storedArgs }
  return {
    host: typeof source.host === "string" && source.host.trim() ? source.host.trim() : defaults.host,
    port: validPort(source.port, defaults.port),
    serverCommand: storedServer.command,
    serverArgs: storedServer.args,
    serverCwd: storedCwd,
    serverEnv,
    serverUrl: typeof source.serverUrl === "string" && /^https?:\/\//i.test(source.serverUrl.trim()) ? source.serverUrl.trim().replace(/\/+$/, "") : defaults.serverUrl,
  }
}

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(adminConfigPath(env), "utf8")), env)
  } catch {
    return defaultAdminConfig(env)
  }
}

export function saveAdminConfig(config: AdminConfig, env: NodeJS.ProcessEnv = process.env): void {
  const file = adminConfigPath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(normalizeConfig(config, env), null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
  try { chmodSync(file, 0o600) } catch { /* Windows has no POSIX mode bits. */ }
}

export function loadOrCreateAdminToken(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OMPIUI_ADMIN_TOKEN?.trim()
  if (configured) return configured
  const file = adminTokenPath(env)
  try {
    const token = readFileSync(file, "utf8").trim()
    if (token) return token
  } catch { /* Generate below. */ }
  const token = randomBytes(32).toString("base64url")
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows has no POSIX mode bits. */ }
  return token
}

export function readBackendToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.OMPIUI_AUTH_TOKEN?.trim()
  if (configured) return configured
  try {
    const token = readFileSync(join(adminDataDir(env), "auth-token"), "utf8").trim()
    return token || undefined
  } catch {
    return undefined
  }
}
