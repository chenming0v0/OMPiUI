import { createHash, randomUUID } from "node:crypto"
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const DEFAULT_STALE_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000

export interface DirectoryLock {
  release(): void
}

export async function acquireDirectoryLock(
  root: string,
  key: string,
  options: { staleMs?: number; timeoutMs?: number; busyCode?: "SESSION_BUSY" | "WORKSPACE_BUSY"; signal?: AbortSignal } = {},
): Promise<DirectoryLock> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lockRoot = path.resolve(root)
  const lockPath = path.join(lockRoot, `${createHash("sha256").update(key).digest("hex")}.lock`)
  const deadline = Date.now() + timeoutMs
  const checkCancelled = () => {
    if (options.signal?.aborted) {
      throw Object.assign(new Error("lock acquisition cancelled"), { code: "REQUEST_ABORTED" })
    }
  }

  checkCancelled()
  await mkdir(lockRoot, { recursive: true })
  while (true) {
    checkCancelled()
    const token = randomUUID()
    let created = false
    try {
      await mkdir(lockPath)
      created = true
      await writeFile(
        path.join(lockPath, "meta.json"),
        JSON.stringify({ token, key, pid: process.pid, createdAt: new Date().toISOString() }),
        { flag: "wx", mode: 0o600 },
      )
      const heartbeatPath = path.join(lockPath, "heartbeat")
      await writeFile(heartbeatPath, "", { flag: "wx", mode: 0o600 })
      checkCancelled()
      const timer = setInterval(() => {
        const now = new Date()
        void utimes(heartbeatPath, now, now).catch(() => undefined)
      }, Math.max(100, Math.floor(staleMs / 3)))
      timer.unref()
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          clearInterval(timer)
          try {
            const meta = JSON.parse(readFileSync(path.join(lockPath, "meta.json"), "utf8")) as { token?: unknown }
            if (meta.token !== token) return
            rmSync(lockPath, { recursive: true, force: true })
          } catch {
            // A stale-lock breaker or another cleanup may have removed it.
          }
        },
      }
    } catch (error) {
      if (created) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      if (await removeStaleLock(lockPath, staleMs)) continue
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`lock is busy: ${key}`), {
          code: options.busyCode ?? "SESSION_BUSY",
          retryable: true,
        })
      }
      try {
        await delay(25, undefined, { signal: options.signal })
      } catch (error) {
        checkCancelled()
        throw error
      }
    }
  }
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const heartbeatPath = path.join(lockPath, "heartbeat")
  const marker = `${lockPath}.breaker`
  let heartbeat: Awaited<ReturnType<typeof stat>> | undefined
  try {
    heartbeat = await stat(heartbeatPath)
  } catch {
    try {
      heartbeat = await stat(lockPath)
    } catch {
      return false
    }
  }
  // 先查 meta.json 里的 pid：若持有者进程已不存在，锁必死（进程崩溃/强杀
  // 后 heartbeat 停更，但 staleMs=60s 太久——SESSION_BUSY 要等满 60s 才
  // 恢复）。pid 检测让崩溃后的锁立即失效。
  const metaPid = readLockOwnerPid(lockPath)
  if (metaPid !== undefined && !isProcessAlive(metaPid)) {
    try {
      await mkdir(marker)
    } catch {
      return false
    }
    try {
      await rm(lockPath, { recursive: true, force: true })
      return true
    } finally {
      await rm(marker, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  if (Date.now() - heartbeat.mtimeMs <= staleMs) return false
  try {
    await mkdir(marker)
  } catch {
    return false
  }
  try {
    let latest: Awaited<ReturnType<typeof stat>>
    try {
      latest = await stat(heartbeatPath)
    } catch {
      latest = await stat(lockPath)
    }
    if (Date.now() - latest.mtimeMs > staleMs) {
      await rm(lockPath, { recursive: true, force: true })
      return true
    }
    return false
  } finally {
    await rm(marker, { recursive: true, force: true }).catch(() => undefined)
  }
}

function readLockOwnerPid(lockPath: string): number | undefined {
  try {
    const meta = JSON.parse(readFileSync(path.join(lockPath, "meta.json"), "utf8")) as { pid?: unknown }
    return typeof meta.pid === "number" && Number.isInteger(meta.pid) && meta.pid > 0 ? meta.pid : undefined
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
