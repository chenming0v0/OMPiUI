import { createHash, randomUUID } from "node:crypto"
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { isJsonObject, type JsonObject } from "@ompiui/protocol"
import { configuredSessionDirectory, legacyOmpSessionsRoot, nativeOmpSessionsRoot, registeredSessionDirectories } from "./omp-directories.js"

/** 旧版 OMPiUI 会话目录；新会话使用 OMP 原生目录。 */
export function managedSessionsRoot(): string {
  const dataDir = process.env.OMPIUI_DATA_DIR?.trim()
  return path.join(dataDir ? path.resolve(dataDir) : path.join(homedir(), ".ompiui"), "sessions")
}

/** 发现与路径校验共用原生、显式配置和旧别名历史目录；历史目录不决定默认写入位置。 */
export function ompSessionRoots(): string[] {
  const configured = configuredSessionDirectory()
  const roots = [configured, ...registeredSessionDirectories(), nativeOmpSessionsRoot(), legacyOmpSessionsRoot()].filter((root): root is string => Boolean(root))
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

const SESSION_BACKUP_LIMIT = 3
const SESSION_SNAPSHOT_NAME = /^(?:([a-f0-9]{64})|snapshot-([a-f0-9]{64})(?:-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})?)\.jsonl$/

function snapshotDigest(name: string): string | undefined {
  const match = SESSION_SNAPSHOT_NAME.exec(name)
  return match?.[1] ?? match?.[2]
}

function renameSessionSnapshot(temporary: string, directory: string, digest: string): string {
  // rename 不能排他发布：只使用全新的随机名字，不覆盖已有目录项。
  let name: string
  do {
    name = `snapshot-${digest}-${randomUUID()}.jsonl`
  } while (lstatSync(path.join(directory, name), { throwIfNoEntry: false }))
  renameSync(temporary, path.join(directory, name))
  return name
}

function ensureBackupDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!lstatSync(directory).isDirectory()) throw new Error("Invalid OMP session backup directory")
}

function snapshotMatches(file: string, content: Buffer): boolean {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size !== content.length) return false
  try {
    return readFileSync(file).equals(content)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function ensureSessionSnapshot(directory: string, content: Buffer): string {
  const digest = createHash("sha256").update(content).digest("hex")
  // 旧版本可能留下未写完的同名文件；保留它，改用另一个可去重的名字。
  const names = [`${digest}.jsonl`, `snapshot-${digest}.jsonl`]
  for (const name of names) {
    if (snapshotMatches(path.join(directory, name), content)) return name
  }
  // 不支持硬链接的文件系统使用随机快照名；同内容仍只复用经逐字节确认的一份。
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && !names.includes(entry.name) && snapshotDigest(entry.name) === digest &&
        snapshotMatches(path.join(directory, entry.name), content)) return entry.name
  }

  const temporary = path.join(directory, `.backup-${randomUUID()}.tmp`)
  const fd = openSync(temporary, "wx", 0o600)
  try {
    try {
      writeFileSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    for (const name of names) {
      const backup = path.join(directory, name)
      try {
        // 同目录硬链接一次发布完整内容，且不会覆盖已存在的目录项。
        linkSync(temporary, backup)
        return name
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EEXIST") {
          if (snapshotMatches(backup, content)) return name
        } else if (["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(code ?? "")) {
          return renameSessionSnapshot(temporary, directory, digest)
        } else {
          throw error
        }
      }
    }
    return renameSessionSnapshot(temporary, directory, digest)
  } finally {
    try { unlinkSync(temporary) } catch { /* 只尝试清理本次创建的临时文件。 */ }
  }
}

function pruneSessionSnapshots(directory: string, current: string): void {
  const candidates = readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isFile() || entry.name === current) return []
    const digest = snapshotDigest(entry.name)
    if (!digest) return []
    const file = path.join(directory, entry.name)
    const stat = lstatSync(file, { throwIfNoEntry: false })
    return stat?.isFile() ? [{ file, digest, stat }] : []
  })
  if (candidates.length < SESSION_BACKUP_LIMIT) return
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file))
  // 当前备份与最新两个候选只保留，不读正文；仅打算删除的候选才验哈希。
  for (const { file, digest, stat } of candidates.slice(SESSION_BACKUP_LIMIT - 1)) {
    try {
      if (createHash("sha256").update(readFileSync(file)).digest("hex") !== digest) continue
      const latest = lstatSync(file, { throwIfNoEntry: false })
      if (latest?.isFile() && latest.dev === stat.dev && latest.ino === stat.ino &&
          latest.size === stat.size && latest.ctimeMs === stat.ctimeMs && latest.mtimeMs === stat.mtimeMs) {
        unlinkSync(file)
      }
    } catch { /* 该条目清理失败不影响其他快照，下次恢复再尝试。 */ }
  }
}

/** 恢复前保存逐字节备份，不改原文件，也不把备份加入任务列表。 */
export function backupOmpSession(file: string): void {
  assertOmpSessionFile(file)
  const source = realpathSync(file)
  const content = readFileSync(source)
  const root = path.join(path.dirname(managedSessionsRoot()), "session-backups")
  const directory = path.join(root, createHash("sha256").update(source).digest("hex").slice(0, 24))
  ensureBackupDirectory(root)
  ensureBackupDirectory(directory)
  const current = ensureSessionSnapshot(directory, content)
  try { pruneSessionSnapshots(directory, current) } catch { /* 备份已就绪，下次恢复再尝试清理。 */ }
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
