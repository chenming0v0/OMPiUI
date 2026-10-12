import { existsSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { OMP_SDK_VERSION } from "./constants.js"
import { compareOmpVersions } from "./omp-version.js"

/** 对齐官方 OMP:官方 CLI 只读取 PI_CODING_AGENT_DIR(不读 OMP_AGENT_DIR),因此它是权威变量。 */
export function ompAgentDirectory(): string {
  const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE
  if (profile && profile !== "default") return path.join(homedir(), ".omp", "profiles", profile, "agent")
  const override = process.env.PI_CODING_AGENT_DIR?.trim() || process.env.OMP_AGENT_DIR?.trim()
  return override ? path.resolve(override.replace(/^~(?=[\\/]|$)/, homedir())) : path.join(homedir(), ".omp", "agent")
}

/**
 * OMPiUI 拉起的 omp 子进程环境。OMP_AGENT_DIR 只是 OMPiUI 侧别名:仅当 PI_CODING_AGENT_DIR 未设置时
 * 译成 PI_CODING_AGENT_DIR,保证子进程与 ompAgentDirectory() 算出同一目录。
 */
export function ompChildEnv(): Record<string, string> {
  const alias = process.env.OMP_AGENT_DIR?.trim()
  return alias && !process.env.PI_CODING_AGENT_DIR?.trim() ? { PI_CODING_AGENT_DIR: alias } : {}
}

/** 官方 CLI 的 PI_CODING_AGENT_SESSION_DIR:会话扁平落在该目录(无 cwd 子目录)。未设置返回 undefined。 */
export function configuredSessionDirectory(): string | undefined {
  const value = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
  return value ? path.resolve(value.replace(/^~(?=[\\/]|$)/, homedir())) : undefined
}

/**
 * 显式登记的额外官方会话目录(OMPIUI_OMP_SESSION_DIRS,按系统路径分隔符分隔),用于官方 CLI `--session-dir`
 * 等自定义目录。只读取这些登记目录,不扫描全盘;发现、打开、路径校验共用同一集合。
 */
export function registeredSessionDirectories(): string[] {
  const raw = process.env.OMPIUI_OMP_SESSION_DIRS?.trim()
  if (!raw) return []
  return raw
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => path.resolve(item.replace(/^~(?=[\\/]|$)/, homedir())))
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
  // OMP 18.4.0 起只展开工作目录的 Windows 短路径；home/tmp 仍按原拼写分类。
  const resolved = process.platform === "win32" && compareOmpVersions(ompVersion, "18.4.0") >= 0 && existsSync(cwd)
    ? realpathSync.native(cwd)
    : canonical(cwd)
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
