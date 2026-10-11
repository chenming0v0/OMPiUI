import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { managedSessionsRoot } from "./managed-sessions.js"

const RUNTIME_POLICY = "autoResume: false\ntask:\n  maxRecursionDepth: 1\n"

/** 最后加载的进程级配置；不修改用户的官方终端设置或第一层并发上限。 */
export function runtimePolicyArgs(): string[] {
  const file = join(dirname(managedSessionsRoot()), "runtime-config", "runtime-policy.yml")
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (!existsSync(file) || readFileSync(file, "utf8") !== RUNTIME_POLICY) {
    writeFileSync(file, RUNTIME_POLICY, { mode: 0o600 })
  }
  return ["--config", file]
}
