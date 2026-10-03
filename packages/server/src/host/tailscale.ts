/**
 * 内置 Tailscale 客户端管理。
 *
 * 手机远程的「Tailscale 直连」依赖电脑端有一个可用的 Tailscale。这里做到
 * 设置里一键化：
 * - Windows：从 pkgs.tailscale.com 下载官方 MSI，`msiexec /passive` 安装
 *   （弹一次 UAC），装完即系统服务，入站直连性能最好。
 * - Linux：下载官方 tgz 解压到数据目录，`tailscaled --tun=userspace-networking`
 *   以普通用户跑（免 root），CLI 走显式 socket。
 * - macOS：不提供内嵌安装（系统引导用户装官方 App），但会探测已装 CLI。
 *
 * 登录：`tailscale login` 的 stdout 里捕获 login.tailscale.com 授权链接，
 * 前端把它渲染成二维码——用户手机扫一下登录自己的 Tailscale 账号授权，
 * 电脑即加入其 Tailnet。授权完成后 `status` 变为 Running，我们收掉登录
 * 子进程并读出 Tailscale IP 供配对二维码使用。
 */

import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import type { TailscaleInfo } from "@ompiui/protocol"

export const PKGS_STABLE_URL = "https://pkgs.tailscale.com/stable/"
const LOGIN_URL_PATTERN = /https:\/\/login\.tailscale\.com\/[A-Za-z0-9/._-]+/
const STATUS_TIMEOUT_MS = 6_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const LOGIN_POLL_MS = 2_500
const LOGIN_MAX_MS = 10 * 60_000

export interface ResolvedDownload {
  version: string
  url: string
  file: string
  kind: "msi" | "tgz"
}

/** 从 stable 列表页 HTML 解析当前版本的下载地址（平台/架构匹配）。 */
export function resolveDownloadTarget(
  html: string,
  platform: NodeJS.Platform,
  arch: string,
): ResolvedDownload | null {
  if (platform === "win32") {
    const flavor = arch === "arm64" ? "arm64" : arch === "ia32" ? "x86" : "amd64"
    const match = html.match(new RegExp(`tailscale-setup-([0-9][0-9.]*)-${flavor}\\.msi`))
    if (!match) return null
    const file = `tailscale-setup-${match[1]}-${flavor}.msi`
    return { version: match[1], url: PKGS_STABLE_URL + file, file, kind: "msi" }
  }
  if (platform === "linux") {
    const flavor = arch === "arm64" ? "arm64" : arch === "armv7l" || arch === "arm" ? "arm" : "amd64"
    const match = html.match(new RegExp(`tailscale_([0-9][0-9.]*)_(${flavor})\\.tgz`))
    if (!match) return null
    const file = `tailscale_${match[1]}_${match[2]}.tgz`
    return { version: match[1], url: PKGS_STABLE_URL + file, file, kind: "tgz" }
  }
  return null
}

export interface MappedTailscaleStatus {
  backendState: string | null
  ips: string[]
  authUrl: string | null
  hostName: string | null
  version: string | null
}

/** `tailscale status --json` 的防御性解析：字段缺失/异型都回落 null。 */
export function mapStatusJson(raw: unknown): MappedTailscaleStatus {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const stringValue = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null)
  const self = (body.Self && typeof body.Self === "object" ? body.Self : {}) as Record<string, unknown>
  const dnsName = stringValue(self.DNSName)
  const version = stringValue(body.Version)
  return {
    backendState: stringValue(body.BackendState),
    ips: Array.isArray(body.TailscaleIPs) ? body.TailscaleIPs.filter((item): item is string => typeof item === "string") : [],
    authUrl: stringValue(body.AuthURL)?.startsWith("https://") ? (stringValue(body.AuthURL)) : null,
    hostName: dnsName ? dnsName.replace(/\.+$/, "") : null,
    version: version ? version.split("-")[0] : null,
  }
}

function execFileLine(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr })
        reject(error)
        return
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
    })
  })
}

export class TailscaleManager {
  private installState: TailscaleInfo["installState"] = "idle"
  private installProgress: number | null = null
  private installError: string | null = null
  private loginChild: ChildProcess | null = null
  private authUrl: string | null = null
  private daemonChild: ChildProcess | null = null
  private disposed = false

  constructor(private readonly options: { dataDir: string; log?: (line: string) => void }) {}

  private get installDir(): string {
    return join(this.options.dataDir, "tailscale")
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /** 数据目录里解压出来的便携 CLI（Linux tgz 路径）。 */
  private resolvePortableCli(): string | null {
    const dir = this.installDir
    if (!existsSync(dir)) return null
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(dir, entry.name, process.platform === "win32" ? "tailscale.exe" : "tailscale")
      if (existsSync(candidate)) return candidate
    }
    const flat = join(dir, process.platform === "win32" ? "tailscale.exe" : "tailscale")
    return existsSync(flat) ? flat : null
  }

  resolveCli(): string | null {
    if (process.platform === "win32") {
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files"
      const installed = join(programFiles, "Tailscale", "tailscale.exe")
      return existsSync(installed) ? installed : null
    }
    if (process.platform === "darwin") {
      const installed = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
      return existsSync(installed) ? installed : null
    }
    const portable = this.resolvePortableCli()
    if (portable) return portable
    for (const candidate of ["/usr/local/bin/tailscale", "/usr/bin/tailscale"]) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  getStatus(): TailscaleInfo {
    const supported = process.platform === "win32" || process.platform === "linux"
    const cli = this.resolveCli()
    return {
      platform: process.platform,
      supported,
      installed: cli !== null,
      reachable: false,
      cliPath: cli,
      installState: this.installState,
      installProgress: this.installProgress,
      installError: this.installError,
      backendState: null,
      authUrl: this.authUrl,
      loginPending: this.loginChild !== null,
      ips: [],
      hostName: null,
      version: null,
    }
  }

  /** CLI 的同步探测（可能命中文件系统），详细状态由 status() 异步补充。 */
  async detailStatus(): Promise<TailscaleInfo & { reachable: boolean }> {
    const base = this.getStatus()
    if (!base.installed || !base.cliPath) return { ...base, reachable: false }
    const args: string[] = []
    const sock = this.embeddedSocketArgs()
    if (sock) args.push("--socket", sock)
    args.push("status", "--json")
    try {
      const { stdout } = await execFileLine(base.cliPath, args, STATUS_TIMEOUT_MS)
      const mapped = mapStatusJson(JSON.parse(stdout))
      return {
        ...base,
        reachable: true,
        backendState: mapped.backendState,
        ips: mapped.ips,
        hostName: mapped.hostName,
        version: mapped.version,
        // status 里直接带了未完成的授权链接时优先用它
        authUrl: this.authUrl ?? mapped.authUrl,
      }
    } catch {
      return { ...base, reachable: false }
    }
  }

  private embeddedSocketArgs(): string | null {
    if (process.platform !== "linux" || !this.daemonChild) return null
    return join(this.installDir, "tailscaled.sock")
  }

  /** 一键下载安装（Windows: MSI + msiexec /passive；Linux: tgz 解压）。 */
  async install(): Promise<void> {
    if (process.platform !== "win32" && process.platform !== "linux") {
      this.installError = "此平台不支持内嵌安装，请从 tailscale.com 官网安装"
      this.installState = "error"
      return
    }
    if (this.installState === "downloading" || this.installState === "installing") return
    this.installError = null
    this.installProgress = null
    this.log("[ompiui-tailscale] downloading stable release metadata")
    try {
      const response = await fetch(PKGS_STABLE_URL, { redirect: "follow", signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`pkgs.tailscale.com responded ${response.status}`)
      const html = await response.text()
      const target = resolveDownloadTarget(html, process.platform, process.arch)
      if (!target) throw new Error("stable 列表里没有匹配当前平台/架构的安装包")
      const dir = this.installDir
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, target.file)
      this.installState = "downloading"
      this.log(`[ompiui-tailscale] downloading ${target.url}`)
      await this.download(target.url, filePath, progress => {
        this.installProgress = progress
      })
      this.installState = "installing"
      this.installProgress = null
      if (target.kind === "msi") {
        this.log("[ompiui-tailscale] running MSI install (a UAC prompt will appear)")
        try {
          await execFileLine("msiexec", ["/i", filePath, "/passive", "/norestart"], INSTALL_TIMEOUT_MS)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException & { code?: string | number }).code
          rmSync(filePath, { force: true })
          if (String(code) === "1602") throw new Error("安装被取消")
          throw new Error(`MSI 安装失败（退出码 ${code ?? "unknown"}）；需要管理员权限`)
        }
        rmSync(filePath, { force: true })
      } else {
        await execFileLine("tar", ["-xzf", filePath, "-C", dir], 120_000)
        rmSync(filePath, { force: true })
      }
      this.installState = "done"
      this.log("[ompiui-tailscale] install finished")
    } catch (error) {
      this.installState = "error"
      this.installError = error instanceof Error ? error.message : String(error)
      this.log(`[ompiui-tailscale] install failed: ${this.installError}`)
    }
  }

  private async download(url: string, filePath: string, onProgress: (ratio: number) => void): Promise<void> {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) })
    if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`)
    const total = Number(response.headers.get("content-length") ?? 0)
    const out = createWriteStream(filePath)
    let received = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!out.write(value as unknown as Uint8Array)) {
        await new Promise<void>(resolve => out.once("drain", resolve))
      }
      if (total > 0) onProgress(Math.min(1, received / total))
    }
    await new Promise<void>((resolve, reject) => {
      out.on("error", reject)
      out.end(resolve)
    })
    if (total > 0) onProgress(1)
  }

  /**
   * 发起登录：优先用 status --json 自带的 AuthURL；否则跑 `tailscale login`
   * 捕获授权链接。登录子进程在授权完成（Running）或超时后收掉。
   */
  async startLogin(): Promise<{ ok: boolean; error?: string }> {
    const cli = this.resolveCli()
    if (!cli) return { ok: false, error: "Tailscale 尚未安装" }
    if (this.loginChild) return { ok: true }
    const detail = await this.detailStatus()
    if (detail.backendState === "Running") return { ok: true }
    if (detail.authUrl) {
      this.authUrl = detail.authUrl
      return { ok: true }
    }
    // 便携 CLI（Linux tgz）需要先把 userspace daemon 拉起来
    if (process.platform === "linux" && cli.startsWith(this.installDir)) {
      const started = await this.ensureEmbeddedDaemon()
      if (!started) return { ok: false, error: "tailscaled 启动失败" }
    }
    const args: string[] = []
    const sock = this.embeddedSocketArgs()
    if (sock) args.push("--socket", sock)
    args.push("login")
    const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    this.loginChild = child
    this.log("[ompiui-tailscale] waiting for login authorization")
    const capture = (chunk: Buffer | string) => {
      const match = LOGIN_URL_PATTERN.exec(String(chunk))
      if (match && !this.authUrl) {
        this.authUrl = match[0]
        this.log(`[ompiui-tailscale] login URL ready: ${this.authUrl}`)
      }
    }
    child.stdout?.on("data", capture)
    child.stderr?.on("data", capture)
    child.on("exit", () => {
      if (this.loginChild === child) this.loginChild = null
    })
    const startedAt = Date.now()
    const poll = setInterval(() => {
      void (async () => {
        if (this.disposed) {
          clearInterval(poll)
          return
        }
        const status = await this.detailStatus()
        if (status.backendState === "Running" || Date.now() - startedAt > LOGIN_MAX_MS) {
          clearInterval(poll)
          this.killLogin()
          if (status.backendState === "Running") this.authUrl = null
        }
      })().catch(() => undefined)
    }, LOGIN_POLL_MS)
    poll.unref?.()
    return { ok: true }
  }

  private killLogin(): void {
    if (this.loginChild) {
      try {
        this.loginChild.kill()
      } catch {
        // 已退出
      }
      this.loginChild = null
    }
  }

  private async ensureEmbeddedDaemon(): Promise<boolean> {
    if (this.daemonChild && this.daemonChild.exitCode === null) return true
    const dir = this.installDir
    const cli = this.resolveCli()
    if (!cli) return false
    const tailscaled = join(dir, basename(cli).replace(/tailscale$/, "tailscaled"))
    if (!existsSync(tailscaled)) return false
    mkdirSync(dir, { recursive: true })
    const child = spawn(
      tailscaled,
      [
        "--tun=userspace-networking",
        `--statedir=${dir}`,
        `--socket=${join(dir, "tailscaled.sock")}`,
      ],
      { stdio: "ignore", windowsHide: true },
    )
    this.daemonChild = child
    await new Promise(resolve => setTimeout(resolve, 1_200))
    return child.exitCode === null
  }

  dispose(): void {
    this.disposed = true
    this.killLogin()
    if (this.daemonChild) {
      try {
        this.daemonChild.kill()
      } catch {
        // 已退出
      }
      this.daemonChild = null
    }
  }
}
