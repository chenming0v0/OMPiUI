import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { isJsonObject, type JsonObject } from "@ompiui/protocol"
import { configuredSessionDirectory, nativeOmpSessionsRoot, registeredSessionDirectories } from "./omp-directories.js"

/** 旧版 OMPiUI 会话目录；新会话使用 OMP 原生目录。 */
export function managedSessionsRoot(): string {
  const dataDir = process.env.OMPIUI_DATA_DIR?.trim()
  return path.join(dataDir ? path.resolve(dataDir) : path.join(homedir(), ".ompiui"), "sessions")
}

/** 官方终端共享的会话根集合:配置的 PI_CODING_AGENT_SESSION_DIR、OMPIUI_OMP_SESSION_DIRS 登记目录与原生目录,去重。 */
export function ompSessionRoots(): string[] {
  const configured = configuredSessionDirectory()
  const roots = [configured, ...registeredSessionDirectories(), nativeOmpSessionsRoot()].filter((root): root is string => Boolean(root))
  return [...new Set(roots.map(root => path.resolve(root)))]
}

/** 新会话与 UI 默认写入的根:配置目录优先,否则原生目录。 */
export function ompSessionsRoot(): string {
  return configuredSessionDirectory() ?? nativeOmpSessionsRoot()
}

/** 文件所属的 OMP 会话根;不在任何已知根内时回退到主根(调用方另行校验)。 */
export function ompSessionRootFor(file: string): string {
  return ompSessionRoots().find(root => isWithinRoot(file, root)) ?? ompSessionsRoot()
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

function isWithinRoot(file: string, root: string): boolean {
  try {
    const relative = path.relative(realpathSync(root), realpathSync(file))
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  } catch {
    return false
  }
}

/** 同时允许原生 OMP 与旧版 OMPiUI 目录，realpath 校验防止链接越界。 */
export function isOmpSessionFile(file: string): boolean {
  return ompSessionRoots().some(root => isWithinRoot(file, root)) || isWithinRoot(file, managedSessionsRoot())
}

export function assertOmpSessionFile(file: string): void {
  if (!file.endsWith(".jsonl") || !isOmpSessionFile(file)) {
    throw Object.assign(new Error("Session file is outside the OMP session directories"), { code: "PATH_OUTSIDE_WORKSPACE" })
  }
}

/** 接管前保存逐字节备份，不改原文件，也不把备份加入任务列表。 */
export function backupOmpSession(file: string): void {
  assertOmpSessionFile(file)
  const content = readFileSync(file)
  const directory = path.join(path.dirname(managedSessionsRoot()), "session-backups",
    createHash("sha256").update(realpathSync(file)).digest("hex").slice(0, 24))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const backup = path.join(directory, `${createHash("sha256").update(content).digest("hex")}.jsonl`)
  try {
    writeFileSync(backup, content, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
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
