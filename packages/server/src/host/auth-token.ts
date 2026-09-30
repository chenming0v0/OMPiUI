import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * OMPiUI's own state lives here, separate from `~/.omp/agent`, which belongs
 * to OMP and is shared with the CLI.
 *
 * The PiUI-era default was `~/.piui`; secrets there are migrated once by
 * readMigratedSecret and the old directory is never written again.
 */
export function ompiuiDataDir(): string {
  const override = process.env.OMPIUI_DATA_DIR?.trim()
  return override ? path.resolve(override) : path.join(homedir(), ".ompiui")
}

export function authTokenPath(): string {
  return path.join(ompiuiDataDir(), "auth-token")
}

/**
 * Read a persisted secret, migrating it from the pre-rename `~/.piui`
 * location on first access: the legacy value is copied to the new path
 * (exclusive create) so tokens stay stable for existing clients and later
 * reads skip the legacy lookup entirely. A OMPIUI_DATA_DIR override means the
 * caller owns an explicit location with no legacy state to inherit.
 */
function readMigratedSecret(name: string): string | undefined {
  const file = path.join(ompiuiDataDir(), name)
  const existing = readTokenFile(file)
  if (existing) return existing
  if (process.env.OMPIUI_DATA_DIR?.trim()) return undefined

  const legacy = readTokenFile(path.join(homedir(), ".piui", name))
  if (!legacy) return undefined
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // Exclusive create, so two servers starting together cannot both migrate.
    writeFileSync(file, `${legacy}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  } catch {
    /* EEXIST means the concurrent migration won; fall through to re-read. */
  }
  return readTokenFile(file) ?? legacy
}

/**
 * The server binds to loopback, but that only keeps other machines out: every
 * local process, including a browser running untrusted script, can still reach
 * it. Since the API reads and writes workspace files and runs bash, it needs a
 * shared secret rather than an open port.
 *
 * The token is persisted so restarting the server does not invalidate clients
 * that already read it. Delete the file to rotate.
 */
export function resolveAuthToken(): string {
  const fromEnv = process.env.OMPIUI_AUTH_TOKEN?.trim()
  if (fromEnv) return fromEnv

  const migrated = readMigratedSecret("auth-token")
  if (migrated) return migrated

  const token = randomBytes(32).toString("base64url")
  const file = authTokenPath()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    // Exclusive create, so two servers starting together cannot each believe
    // they own a different token.
    writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    return readTokenFile(file) ?? token
  }
}

function readTokenFile(file: string): string | undefined {
  try {
    const value = readFileSync(file, "utf8").trim()
    return value || undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export function cursorSecretPath(): string {
  return path.join(ompiuiDataDir(), "cursor-secret")
}

/**
 * 分页光标的 HMAC 密钥，持久化到磁盘并在启动时注入 worker 环境。
 * worker 进程重启（空闲回收后重新 attach 会话）会重新生成各自的随机密钥，
 * 导致客户端旧光标全部 400（invalid pagination cursor）。持久化密钥让
 * 光标跨 worker 重启仍然有效。删除文件即可轮换。
 */
export function resolveCursorSecret(): string {
  const fromEnv = process.env.OMPIUI_CURSOR_SECRET?.trim()
  if (fromEnv) return fromEnv

  const migrated = readMigratedSecret("cursor-secret")
  if (migrated) return migrated

  const secret = randomBytes(32).toString("base64url")
  const file = cursorSecretPath()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    // Exclusive create, so two servers starting together cannot each believe
    // they own a different secret.
    writeFileSync(file, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    return secret
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    return readTokenFile(file) ?? secret
  }
}

/** 确保光标密钥已注入环境——必须在任何 worker spawn 之前调用。 */
export function ensureCursorSecretEnv(): string {
  const secret = resolveCursorSecret()
  process.env.OMPIUI_CURSOR_SECRET = secret
  return secret
}
