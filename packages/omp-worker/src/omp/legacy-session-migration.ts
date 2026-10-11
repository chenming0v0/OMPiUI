import { randomUUID } from "node:crypto"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync } from "node:fs"
import path from "node:path"
import { managedSessionDirectory, managedSessionsRoot } from "./managed-sessions.js"
import { nativeOmpSessionDirectory } from "./omp-directories.js"

export interface LegacySessionMigration {
  source: string
  destination: string
  sessions: number
  entries: string[]
  headerlessFiles: string[]
  alreadyMigrated: boolean
  backup?: string
}

function pathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** 显式维护操作的只读预检。浏览、刷新和 runtime 启动不调用迁移。 */
export function planLegacySessionMigration(cwd: string, ompVersion: string): LegacySessionMigration {
  const source = managedSessionDirectory(cwd)
  const destination = nativeOmpSessionDirectory(cwd, ompVersion)
  const plan: LegacySessionMigration = { source, destination, sessions: 0, entries: [], headerlessFiles: [], alreadyMigrated: false }
  if (!existsSync(source)) return plan
  if (lstatSync(source).isSymbolicLink()) {
    if (!existsSync(destination) || pathKey(realpathSync(source)) !== pathKey(realpathSync(destination))) {
      throw new Error(`Legacy session directory points to an unexpected location: ${source}`)
    }
    return { ...plan, alreadyMigrated: true }
  }
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw new Error(`Native session directory must not be a link: ${destination}`)
  }
  plan.entries = readdirSync(source)
  for (const name of plan.entries) {
    if (existsSync(path.join(destination, name))) throw new Error(`Migration conflict; no files changed: ${path.join(destination, name)}`)
    if (!name.endsWith(".jsonl")) continue
    const lines = readFileSync(path.join(source, name), "utf8").split(/\r?\n/)
    const header = lines.filter(line => line.trim()).map(line => JSON.parse(line)).find(entry => entry.type === "session")
    // 旧异常退出可能只留下 session_exit；原样保留，但不计入可恢复会话。
    if (!header) {
      plan.headerlessFiles.push(name)
      continue
    }
    if (typeof header.cwd !== "string" || pathKey(header.cwd) !== pathKey(cwd)) {
      throw new Error(`Session belongs to a different workspace or has an invalid header: ${name}`)
    }
    plan.sessions++
  }
  return plan
}

/**
 * 在会话已停止写入时显式执行。保留身份和全部伴随文件，旧路径通过目录链接继续访问原文件。
 * 不用逐文件硬链接：OMP 原子替换 JSONL 后，硬链接会变成两个不再同步的文件。
 */
export function migrateLegacySessions(cwd: string, ompVersion: string): LegacySessionMigration {
  const plan = planLegacySessionMigration(cwd, ompVersion)
  if (plan.alreadyMigrated || plan.entries.length === 0) return plan
  mkdirSync(plan.destination, { recursive: true })
  if (statSync(plan.source).dev !== statSync(plan.destination).dev) {
    throw new Error("Legacy and native sessions must be on the same filesystem for this migration")
  }
  const backup = path.join(path.dirname(managedSessionsRoot()), "session-migration-backups", randomUUID())
  cpSync(plan.source, backup, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
  const moved: string[] = []
  try {
    for (const name of plan.entries) {
      // 备份完成后再次检查，避免覆盖维护期间新出现的文件。
      if (existsSync(path.join(plan.destination, name))) throw new Error(`Migration conflict: ${name}`)
      renameSync(path.join(plan.source, name), path.join(plan.destination, name))
      moved.push(name)
    }
    rmdirSync(plan.source)
    symlinkSync(plan.destination, plan.source, process.platform === "win32" ? "junction" : "dir")
  } catch (error) {
    mkdirSync(plan.source, { recursive: true })
    for (const name of moved.reverse()) renameSync(path.join(plan.destination, name), path.join(plan.source, name))
    throw error
  }
  return { ...plan, backup }
}
