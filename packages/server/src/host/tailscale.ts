import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { TailscaleInfo } from "@ompiui/protocol"

export function mapStatusJson(raw: unknown) {
  const body = raw as { BackendState?: string; AuthURL?: string; TailscaleIPs?: string[]; Version?: string; Self?: { DNSName?: string } } | null
  return {
    backendState: typeof body?.BackendState === "string" ? body.BackendState : null,
    authUrl: typeof body?.AuthURL === "string" && body.AuthURL.startsWith("https://login.tailscale.com/") ? body.AuthURL : null,
    ips: Array.isArray(body?.TailscaleIPs) ? body.TailscaleIPs.filter(ip => typeof ip === "string") : [],
    hostName: typeof body?.Self?.DNSName === "string" ? body.Self.DNSName.replace(/\.+$/, "") : null,
    version: typeof body?.Version === "string" ? body.Version.split("-")[0] : null,
  }
}

type Options = {
  dataDir: string
  log?: (line: string) => void
  embeddedBridgePath?: string
  launch?: (binary: string, args: string[], token: string) => ChildProcess
}

export class TailscaleManager {
  private child: ChildProcess | null = null
  private controlUrl: string | null = null
  private controlToken = ""
  private starting: Promise<boolean> | null = null
  private localPort: number | null = null
  private localHost = "127.0.0.1"
  private enabled = false
  private disposed = false
  private lastError: string | null = null
  private status: ReturnType<typeof mapStatusJson> = mapStatusJson(null)

  constructor(private readonly options: Options) {
    try {
      this.enabled = JSON.parse(readFileSync(this.settingsPath, "utf8")).enabled === true
    } catch {
      // 首次启用前不存在配置，旧安装器的数据也不自动启动。
    }
  }

  private get stateDir() { return join(this.options.dataDir, "tailscale", "tsnet") }
  private get settingsPath() { return join(this.stateDir, "ompiui.json") }

  resolveEmbeddedBridge(): string | null {
    const name = process.platform === "win32" ? "ompiui-tailscale-bridge.exe" : "ompiui-tailscale-bridge"
    // 显式路径不回退，便于诊断缺失资源及可重复测试。
    const explicit = this.options.embeddedBridgePath ?? process.env.OMPIUI_TAILSCALE_BRIDGE
    if (explicit) return existsSync(explicit) ? explicit : null
    const sourceRoot = fileURLToPath(new URL("../../", import.meta.url))
    return [
      join(dirname(process.execPath), "tailscale", name),
      join(process.cwd(), "tailscale", name),
      join(sourceRoot, "tailscale-bridge", "build", name),
    ].find(path => existsSync(path)) ?? null
  }

  getStatus(): TailscaleInfo {
    const binary = this.resolveEmbeddedBridge()
    const address = this.status.ips.find(ip => !ip.includes(":")) ?? this.status.ips[0]
    const host = address?.includes(":") ? `[${address}]` : address
    return {
      platform: process.platform,
      supported: ["win32", "linux", "darwin"].includes(process.platform),
      installed: binary !== null,
      mode: binary ? "embedded" : "unavailable",
      component: binary ? "tsnet" : null,
      usesSystemVpn: false,
      enabled: this.enabled,
      reachable: this.controlUrl !== null,
      cliPath: binary,
      installState: this.lastError ? "error" : "idle",
      installProgress: null,
      installError: this.lastError,
      lastError: this.lastError,
      backendState: this.child ? this.status.backendState ?? "Starting" : "Stopped",
      authUrl: this.status.backendState === "Running" ? null : this.status.authUrl,
      loginPending: this.child !== null && this.status.backendState !== "Running",
      ips: this.child ? this.status.ips : [],
      hostName: this.status.hostName,
      version: this.status.version,
      url: this.child && this.status.backendState === "Running" && host && this.localPort
        ? `http://${host}:${this.localPort}` : null,
    }
  }

  async detailStatus(): Promise<TailscaleInfo> {
    if (this.controlUrl) {
      try {
        const response = await this.request("/status")
        this.status = mapStatusJson(await response.json())
        this.lastError = null
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    }
    return this.getStatus()
  }

  /** 后端监听成功后才提供回环上游；只恢复用户曾启用的节点。 */
  async resume(localPort: number, bindHost = "127.0.0.1"): Promise<void> {
    this.localPort = localPort
    this.localHost = bindHost === "::" || bindHost === "::1" ? "::1"
      : bindHost === "0.0.0.0" || bindHost === "localhost" ? "127.0.0.1" : bindHost
    if (this.enabled) await this.startEmbedded()
  }

  /** 兼容旧接口名称，不再下载或安装系统客户端。 */
  async install(): Promise<void> {
    if (!this.resolveEmbeddedBridge()) {
      this.lastError = "当前构建缺少内嵌 Tailscale 组件，请安装完整 OMPiUI 包"
    }
  }

  async startLogin(): Promise<{ ok: boolean; error?: string }> {
    if (!await this.startEmbedded()) return { ok: false, error: this.lastError ?? "内嵌 Tailscale 启动失败" }
    this.enabled = true
    this.persistEnabled()
    const current = await this.detailStatus()
    if (current.backendState !== "Running" && !current.authUrl) {
      try {
        await this.request("/login", "POST")
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        return { ok: false, error: this.lastError }
      }
    }
    await this.detailStatus()
    return { ok: true }
  }

  async disconnect(): Promise<void> {
    this.enabled = false
    this.persistEnabled()
    await this.stopChild()
    this.status = mapStatusJson(null)
    this.lastError = null
  }

  private persistEnabled(): void {
    mkdirSync(this.stateDir, { recursive: true })
    writeFileSync(this.settingsPath, JSON.stringify({ enabled: this.enabled }), { mode: 0o600 })
  }

  private async request(path: string, method = "GET"): Promise<Response> {
    if (!this.controlUrl) throw new Error("内嵌 Tailscale 未启动")
    const response = await fetch(`${this.controlUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.controlToken}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`内嵌 Tailscale 状态接口失败 (${response.status})`)
    return response
  }

  async startEmbedded(): Promise<boolean> {
    if (this.disposed) return false
    if (this.starting) return this.starting
    if (this.child && this.controlUrl) return true
    const binary = this.resolveEmbeddedBridge()
    if (!binary || !this.localPort) {
      this.lastError = binary ? "后端尚未开始监听" : "当前构建缺少内嵌 Tailscale 组件"
      return false
    }
    // 内嵌网关只允许转发回环后端，非回环绑定不能偷偷暴露其他服务。
    if (!["127.0.0.1", "::1"].includes(this.localHost)) {
      this.lastError = "内嵌 Tailscale 需要后端监听 127.0.0.1、0.0.0.0 或 ::"
      return false
    }
    this.starting = this.launch(binary).finally(() => { this.starting = null })
    return this.starting
  }

  private launch(binary: string): Promise<boolean> {
    this.controlToken = randomBytes(32).toString("hex")
    const host = this.localHost.includes(":") ? `[${this.localHost}]` : this.localHost
    const args = [
      "--state-dir", this.stateDir,
      "--hostname", `ompiui-${hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48)}`,
      "--listen", `:${this.localPort}`,
      "--upstream", `http://${host}:${this.localPort}`,
    ]
    return new Promise<boolean>(resolve => {
      let child: ChildProcess
      try {
        child = this.options.launch?.(binary, args, this.controlToken) ?? spawn(binary, args, {
          stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
          env: { ...process.env, OMPIUI_BRIDGE_TOKEN: this.controlToken },
        })
      } catch (error) {
        this.lastError = String(error)
        resolve(false)
        return
      }
      this.child = child
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => {
        this.lastError = "内嵌 Tailscale 启动超时"
        child.stdin?.end()
        child.kill()
        finish(false)
      }, 30_000)
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout })
        lines.on("line", line => {
          try {
            const message = JSON.parse(line)
            const url = new URL(message.controlAddr)
            if (this.child === child && !this.disposed && message.event === "ready" && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port) {
              this.controlUrl = url.origin
              this.lastError = null
              finish(true)
            }
          } catch {
            this.options.log?.("[ompiui-tailscale] invalid bridge control message")
          }
        })
      }
      if (child.stderr) {
        createInterface({ input: child.stderr }).on("line", line => {
          this.options.log?.(`[ompiui-tailscale] ${line.replace(/https:\/\/login\.tailscale\.com\/\S+/g, "<redacted-login-url>")}`)
        })
      }
      child.once("error", error => {
        this.lastError = error.message
        if (this.child === child) { this.child = null; this.controlUrl = null }
        finish(false)
      })
      child.once("exit", code => {
        if (this.child === child) {
          this.child = null
          this.controlUrl = null
          this.status = mapStatusJson(null)
          if (this.enabled && !this.disposed) this.lastError = `内嵌 Tailscale 已退出 (${code ?? "signal"})，请重新连接`
        }
        finish(false)
      })
    })
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    if (!child) return
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    this.child = null
    this.controlUrl = null
    child.stdin?.end()
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000)
    await exited
    clearTimeout(timer)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stopChild()
  }
}
