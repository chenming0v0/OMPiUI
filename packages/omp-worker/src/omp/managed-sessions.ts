import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { isJsonObject, type JsonObject } from "@ompiui/protocol"

/** Web-owned sessions never share a writable file with an independently running TUI. */
export function managedSessionsRoot(): string {
  const dataDir = process.env.OMPIUI_DATA_DIR?.trim()
  return path.join(dataDir ? path.resolve(dataDir) : path.join(homedir(), ".ompiui"), "sessions")
}

export function managedSessionDirectory(cwd: string): string {
  const resolved = path.resolve(cwd).replace(/\\/g, "/")
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved
  return path.join(managedSessionsRoot(), createHash("sha256").update(key).digest("hex").slice(0, 24))
}

export function isManagedSessionFile(file: string): boolean {
  try {
    const relative = path.relative(realpathSync(managedSessionsRoot()), realpathSync(file))
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  } catch {
    return false
  }
}

export function readOnlySessionError(): Error {
  return Object.assign(new Error("This is an external OMP session. Viewing it is read-only; continue in a separate WebUI session to send messages. The original TUI session is never opened by another writer."), { code: "SESSION_READ_ONLY" })
}

export function assertManagedSessionFile(file: string): void {
  if (!isManagedSessionFile(file)) throw readOnlySessionError()
}

/** Copy first; assign a new identity before any RPC process can open the result. */
export function copySessionFile(source: string, directory: string): JsonObject {
  const lines = readFileSync(source, "utf8").split("\n")
  const sessionId = randomUUID()
  const timestamp = new Date().toISOString()
  let header: JsonObject | undefined
  const copied: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const entry: unknown = JSON.parse(line)
    if (!isJsonObject(entry)) continue
    if (entry.type === "session") {
      header = { ...entry, id: sessionId, timestamp, parentSession: source }
      copied.push(JSON.stringify(header))
    } else {
      copied.push(line)
    }
  }
  if (!header || typeof header.cwd !== "string") {
    throw Object.assign(new Error("Session header is missing or invalid"), { code: "INVALID_REQUEST" })
  }
  mkdirSync(directory, { recursive: true })
  const sessionFile = path.join(directory, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`)
  writeFileSync(sessionFile, `${copied.join("\n")}\n`, { encoding: "utf8", flag: "wx" })
  return { sessionId, sessionFile, cwd: header.cwd }
}
