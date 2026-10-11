import { existsSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { OMP_SDK_VERSION } from "./constants.js"
import { compareOmpVersions } from "./omp-version.js"

/** 对齐官方 OMP 的 profile、PI_CODING_AGENT_DIR 和已迁移的 XDG 目录。 */
export function ompAgentDirectory(): string {
  const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE
  if (profile && profile !== "default") return path.join(homedir(), ".omp", "profiles", profile, "agent")
  const override = process.env.OMP_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim()
  return override ? path.resolve(override.replace(/^~(?=[\\/]|$)/, homedir())) : path.join(homedir(), ".omp", "agent")
}

export function nativeOmpSessionsRoot(): string {
  const agent = ompAgentDirectory()
  const defaultAgent = path.join(homedir(), ".omp", "agent")
  const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE
  const profileAgent = profile && profile !== "default" ? path.join(homedir(), ".omp", "profiles", profile, "agent") : defaultAgent
  if ((process.platform === "linux" || process.platform === "darwin") && agent === profileAgent && process.env.XDG_DATA_HOME) {
    const xdgRoot = path.join(process.env.XDG_DATA_HOME, "omp", ...(profile && profile !== "default" ? ["profiles", profile] : []))
    if (existsSync(xdgRoot)) return path.join(xdgRoot, "sessions")
  }
  return path.join(agent, "sessions")
}

/** 对齐 OMP 18.x session-paths 的真实路径及 home/tmp/绝对路径编码；只计算，不迁移。 */
export function nativeOmpSessionDirectory(cwd: string, ompVersion: string = OMP_SDK_VERSION): string {
  const canonical = (value: string) => existsSync(value) ? realpathSync(value) : path.resolve(value)
  const resolved = canonical(cwd)
  const roots: Array<readonly [string, string]> = [[homedir(), "-"], [tmpdir(), "-tmp"]]
  // OMP 18.5.0 起先匹配 tmp（上游 47b1156），旧版本仍先匹配 home。
  if (compareOmpVersions(ompVersion, "18.5.0") >= 0) roots.reverse()
  for (const [root, prefix] of roots) {
    const relative = path.relative(canonical(root), resolved)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      const encoded = relative.replace(/[/\\:]/g, "-")
      return path.join(nativeOmpSessionsRoot(), encoded ? `${prefix}${prefix.endsWith("-") ? "" : "-"}${encoded}` : prefix)
    }
  }
  return path.join(nativeOmpSessionsRoot(), `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)
}
