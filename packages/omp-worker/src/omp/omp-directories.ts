import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

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
