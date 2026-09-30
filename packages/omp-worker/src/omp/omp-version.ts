import { spawn, spawnSync } from "node:child_process"

/**
 * OMP 版本探测与最低版本门禁。
 *
 * OMPiUI 的 RPC 面依赖 18.2.11 才有的命令（get_entries / get_tree /
 * get_available_thinking_levels）。更老的 omp 对未知命令返回不带 id 的
 * error response，请求方只能干等到超时（打开会话卡 ~150s）——所以拉起
 * 会话前先探测 `omp --version`，低于下限立刻报错让用户升级（issue #5）。
 */
export const MIN_OMP_VERSION = "18.2.11"

/** 从 `omp --version` 输出里提取 semver（容忍 "omp 18.4.4 (…)" 等前缀/尾注） */
export function parseOmpVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  return match?.[0] ?? null
}

/** 数值比较 major.minor.patch（prerelease/构建后缀不影响门禁判定） */
export function compareOmpVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split(".").map(Number)
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parts(a)
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parts(b)
  if (aMajor !== bMajor) return aMajor - bMajor
  if (aMinor !== bMinor) return aMinor - bMinor
  return aPatch - bPatch
}

export function isOmpVersionSupported(version: string): boolean {
  return compareOmpVersions(version, MIN_OMP_VERSION) >= 0
}

/** 低于最低版本时的用户可读错误（code=OMP_TOO_OLD） */
export function ompTooOldError(version: string): Error {
  return Object.assign(
    new Error(
      `OMP ${version} is too old for OMPiUI: omp >= ${MIN_OMP_VERSION} is required. ` +
      `Please upgrade the OMP CLI (npm/bun install -g @oh-my-pi/pi-coding-agent) and reopen the session.`,
    ),
    { code: "OMP_TOO_OLD" },
  )
}

// 同一 worker 生命周期内 omp 版本不会变（升级后 worker 会被重启），按 bin 缓存
const detected = new Map<string, string | null>()

/**
 * 同步探测（worker 启动时跑一次）：hello/registry 直接带真实版本，
 * 不用等首次会话打开。失败/无法解析返回 null —— 只影响展示，
 * 会话打开时另有异步探测兜底。
 */
export function detectOmpVersionSync(bin?: string, timeoutMs = 5_000): string | null {
  const key = bin?.trim() || "omp"
  if (detected.has(key)) return detected.get(key) ?? null
  let version: string | null = null
  try {
    // omp 是外部 CLI，参数是固定 flag；win32 上 shell:true 才能解析 PATH 里的 .cmd
    const probe = spawnSync(key, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: process.platform === "win32",
      windowsHide: true,
    })
    version = parseOmpVersion(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`)
  } catch {
    version = null
  }
  detected.set(key, version)
  return version
}

/** 异步探测（会话打开路径用；通常已被启动探测填充，直接命中缓存） */
export function detectOmpVersion(bin?: string, timeoutMs = 10_000): Promise<string | null> {
  const key = bin?.trim() || "omp"
  const cached = detected.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  return new Promise<string | null>(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(key, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
      })
    } catch {
      detected.set(key, null)
      resolve(null)
      return
    }
    let output = ""
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* best effort */ }
    }, timeoutMs)
    timer.unref()
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", chunk => { output += chunk })
    child.stderr?.on("data", chunk => { output += `\n${chunk}` })
    child.on("error", () => {
      clearTimeout(timer)
      detected.set(key, null)
      resolve(null)
    })
    child.on("exit", () => {
      clearTimeout(timer)
      const version = parseOmpVersion(output)
      detected.set(key, version)
      resolve(version)
    })
  })
}

/** 当前已探测到的版本；未探测/探测失败时回退到标定值 */
export function detectedOmpVersion(fallback: string, bin?: string): string {
  const key = bin?.trim() || "omp"
  return detected.get(key) ?? fallback
}
