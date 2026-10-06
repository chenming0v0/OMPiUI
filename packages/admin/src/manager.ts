import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { loadAdminConfig, readBackendToken, saveAdminConfig, type AdminConfig } from "./config.ts"

export interface BackendSettings {
  serverUrl?: string
  host?: string
  port?: string
  publicBaseUrl?: string
  tunnelUrl?: string
  tunnelKey?: string
  tunnelId?: string
  driver?: "omp" | "mock"
}


export type ServiceLifecycle = "stopped" | "starting" | "running" | "exited"

/** 后端 HTTP 探测结果：ok=false 时带原因，供 TUI/Web 展示而不是静默吞掉。 */
export type BackendProbe = { ok: true; body: unknown } | { ok: false; error: string }

export interface ServiceStatus {
  lifecycle: ServiceLifecycle
  pid: number | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  backendUrl: string
  health: unknown | null
  healthError: string | null
  share: unknown | null
  tunnel: unknown | null
  error: string | null
}

export class ServiceManager {
  private readonly env: NodeJS.ProcessEnv
  private config: AdminConfig
  private child: ChildProcess | undefined
  private lifecycle: ServiceLifecycle = "stopped"
  private exitCode: number | null = null
  private signal: NodeJS.Signals | null = null
  private error: string | null = null
  private stopping = false

  constructor(options: { config?: AdminConfig; env?: NodeJS.ProcessEnv } = {}) {
    this.env = options.env ?? process.env
    this.config = options.config ?? loadAdminConfig(this.env)
  }

  getConfig(): AdminConfig { return this.config }
  backendToken(): string | undefined {
    return readBackendToken({ ...this.env, ...this.config.serverEnv })
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed)
  }

  async start(): Promise<void> {
    if (this.isRunning()) return
    if (this.lifecycle === "starting") return
    // 后端已在别处运行（例如上一个管理器退出后遗留的进程）时，这里再 spawn
    // 只会撞端口后退出；提前给出可行动的错误而不是神秘崩溃。401 说明有服务
    // 在听但令牌不同，同样视为已被占用。
    const external = await this.probeBackend("/api/v1/host/health")
    if (external.ok || external.error.includes("HTTP 401")) {
      throw new Error(
        `backend already answering at ${this.config.serverUrl}; this manager did not start it — stop that process first or configure another OMPIUI_PORT`,
      )
    }
    const [entry] = this.config.serverArgs
    if (entry && entry.endsWith(".js") && !existsSync(entry)) {
      throw new Error(`backend entry does not exist: ${entry}; run the build first or set OMPIUI_SERVER_ENTRY`)
    }
    this.error = null
    this.exitCode = null
    this.signal = null
    this.stopping = false
    this.lifecycle = "starting"
    const child = spawn(this.config.serverCommand, this.config.serverArgs, {
      cwd: this.config.serverCwd,
      env: { ...this.env, ...this.config.serverEnv },
      stdio: "inherit",
      shell: false,
    })
    this.child = child
    child.once("spawn", () => { this.lifecycle = "running" })
    child.once("error", error => {
      this.error = error.message
      this.lifecycle = "exited"
    })
    child.once("exit", (code, signal) => {
      this.exitCode = code
      this.signal = signal
      // 主动 stop 的退出不是崩溃：标记成 stopped，UI 不显示成异常退出。
      this.lifecycle = this.stopping ? "stopped" : "exited"
      if (this.child === child) this.child = undefined
    })
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve() }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const cleanup = () => {
        child.off("spawn", onSpawn)
        child.off("error", onError)
      }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.lifecycle = "stopped"
      return
    }
    this.stopping = true
    const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()) })
    child.kill("SIGTERM")
    const graceTimer = new Promise<false>(resolve => {
      const handle = setTimeout(() => resolve(false), 5_000)
      handle.unref?.()
    })
    const graceful = await Promise.race([exited.then(() => true), graceTimer])
    if (!graceful && child.exitCode === null) {
      child.kill("SIGKILL")
      await exited
    }
    if (this.child === child) this.lifecycle = "stopped"
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  updateBackendSettings(settings: BackendSettings): void {
    const nextEnv = { ...this.config.serverEnv }
    const setOrDelete = (key: string, value: string | undefined) => {
      if (value === undefined) return
      if (value.trim()) nextEnv[key] = value.trim()
      else delete nextEnv[key]
    }
    setOrDelete("OMPIUI_HOST", settings.host)
    setOrDelete("OMPIUI_PORT", settings.port)
    setOrDelete("OMPIUI_PUBLIC_BASE_URL", settings.publicBaseUrl)
    setOrDelete("OMPIUI_TUNNEL_URL", settings.tunnelUrl)
    setOrDelete("OMPIUI_TUNNEL_KEY", settings.tunnelKey)
    setOrDelete("OMPIUI_TUNNEL_ID", settings.tunnelId)
    setOrDelete("OMPIUI_DRIVER", settings.driver)
    if (settings.serverUrl !== undefined) {
      const serverUrl = settings.serverUrl.trim().replace(/\/+$/, "")
      if (!/^https?:\/\//i.test(serverUrl)) throw new Error("serverUrl must be an http(s) URL")
      this.config.serverUrl = serverUrl
    }
    this.config.serverEnv = nextEnv
    saveAdminConfig(this.config, this.env)
  }

  publicBackendSettings(): Record<string, string> {
    const env = this.config.serverEnv
    return {
      serverUrl: this.config.serverUrl,
      host: env.OMPIUI_HOST ?? "",
      port: env.OMPIUI_PORT ?? "",
      publicBaseUrl: env.OMPIUI_PUBLIC_BASE_URL ?? "",
      tunnelUrl: env.OMPIUI_TUNNEL_URL ?? "",
      tunnelId: env.OMPIUI_TUNNEL_ID ?? "",
      tunnelConfigured: env.OMPIUI_TUNNEL_URL && env.OMPIUI_TUNNEL_KEY ? "true" : "false",
    }
  }

  private async probeBackend(pathname: string): Promise<BackendProbe> {
    const backendEnv = { ...this.env, ...this.config.serverEnv }
    const token = readBackendToken(backendEnv)
    if (!token) return { ok: false, error: "backend access token is not configured yet" }
    try {
      const response = await fetch(`${this.config.serverUrl}${pathname}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) return { ok: false, error: `backend returned HTTP ${response.status}` }
      return { ok: true, body: await response.json() as unknown }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async status(): Promise<ServiceStatus> {
    const running = this.isRunning()
    const healthProbe = await this.probeBackend("/api/v1/host/health")
    const shareProbe = healthProbe.ok ? await this.probeBackend("/api/v1/host/share") : null
    const tunnelProbe = healthProbe.ok ? await this.probeBackend("/api/v1/host/tunnel") : null
    return {
      lifecycle: running ? "running" : this.lifecycle,
      pid: this.child?.pid ?? null,
      exitCode: this.exitCode,
      signal: this.signal,
      backendUrl: this.config.serverUrl,
      health: healthProbe.ok ? healthProbe.body : null,
      healthError: healthProbe.ok ? null : healthProbe.error,
      share: shareProbe?.ok ? shareProbe.body : null,
      tunnel: tunnelProbe?.ok ? tunnelProbe.body : null,
      error: this.error,
    }
  }
}
