import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { loadAdminConfig, readBackendToken, saveAdminConfig, type AdminConfig } from "./config.ts"
import { removeOwnerRecord, writeOwnerRecord, type OwnerRecord } from "./lifecycle.ts"

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
  private starting: Promise<void> | undefined
  private startEpoch = 0
  private retain = 0
  private idleQueued = false
  private idleWaiters: Array<() => void> = []
  private owner: OwnerRecord | null = null

  constructor(options: { config?: AdminConfig; env?: NodeJS.ProcessEnv } = {}) {
    this.env = options.env ?? process.env
    this.config = options.config ?? loadAdminConfig(this.env)
  }

  getConfig(): AdminConfig { return this.config }
  backendToken(): string | undefined {
    return readBackendToken(this.backendEnv())
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed)
  }

  /** True until the child has actually exited. `killed` alone is still in-flight. */
  private childAlive(): boolean {
    return Boolean(this.child && this.child.exitCode === null)
  }

  /**
   * Foreground `start` waits here. A remote restart holds the process across the
   * gap between stop and the next spawn; a real stop lets it return.
   */
  untilIdle(): Promise<void> {
    if (this.retain === 0 && !this.starting && !this.childAlive()) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.push(resolve) })
  }

  /**
   * Remember the management API this process is serving. The record is written
   * only after a backend is actually spawned, and removed when that child exits.
   */
  attachOwner(endpoint: { host: string; port: number; nonce: string }): void {
    this.owner = { pid: process.pid, host: endpoint.host, port: endpoint.port, nonce: endpoint.nonce }
    if (this.isRunning()) this.publishOwner()
  }

  detachOwner(): void {
    this.withdrawOwner()
    this.owner = null
  }

  start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.childAlive()) return Promise.resolve()
    const epoch = ++this.startEpoch
    this.lifecycle = "starting"
    this.error = null
    // The shared attempt is published before probeBackend can run, so overlapping
    // callers await one spawn instead of each slipping past an unset flag.
    const attempt = this.launch(epoch).catch(error => {
      if (epoch !== this.startEpoch) return
      this.error = error instanceof Error ? error.message : String(error)
      if (this.lifecycle === "starting") this.lifecycle = "exited"
      throw error
    })
    let published: Promise<void> | undefined
    published = attempt.finally(() => {
      if (this.starting === published) this.starting = undefined
      this.pokeIdle()
    })
    this.starting = published
    return published
  }

  private async launch(epoch: number): Promise<void> {
    // 后端已在别处运行（例如上一个管理器退出后遗留的进程）时，这里再 spawn
    // 只会撞端口后退出；提前给出可行动的错误而不是神秘崩溃。401 说明有服务
    // 在听但令牌不同，同样视为已被占用。
    const external = await this.probeBackend("/api/v1/host/health")
    if (epoch !== this.startEpoch) {
      if (this.lifecycle === "starting") this.lifecycle = "stopped"
      return
    }
    if (external.ok || external.error.includes("HTTP 401")) {
      throw new Error(
        `backend already answering at ${this.config.serverUrl}; this manager did not start it — stop that process first or configure another OMPIUI_PORT`,
      )
    }
    const [entry] = this.config.serverArgs
    if (entry && entry.endsWith(".js") && !existsSync(entry)) {
      throw new Error(`backend entry does not exist: ${entry}; run the build first or set OMPIUI_SERVER_ENTRY`)
    }
    if (epoch !== this.startEpoch) {
      if (this.lifecycle === "starting") this.lifecycle = "stopped"
      return
    }
    this.exitCode = null
    this.signal = null
    this.stopping = false
    const child = spawn(this.config.serverCommand, this.config.serverArgs, {
      cwd: this.config.serverCwd,
      env: this.backendEnv(),
      stdio: "inherit",
      shell: false,
    })
    this.child = child
    child.once("spawn", () => {
      if (this.child !== child) return
      if (epoch !== this.startEpoch) {
        child.kill("SIGTERM")
        return
      }
      this.lifecycle = "running"
      this.publishOwner()
    })
    child.once("error", error => {
      if (this.child !== child) return
      this.error = error.message
      this.lifecycle = "exited"
      this.child = undefined
      this.withdrawOwner()
      this.pokeIdle()
    })
    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.exitCode = code
        this.signal = signal
        // 主动 stop 的退出不是崩溃：标记成 stopped，UI 不显示成异常退出。
        this.lifecycle = this.stopping ? "stopped" : "exited"
        this.child = undefined
        this.withdrawOwner()
      }
      this.pokeIdle()
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
    this.startEpoch += 1
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.lifecycle = "stopped"
      this.withdrawOwner()
      this.pokeIdle()
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
    if (this.child === undefined || this.child === child) this.lifecycle = "stopped"
    this.withdrawOwner()
    this.pokeIdle()
  }

  async restart(): Promise<void> {
    this.retain += 1
    try {
      await this.stop()
      await this.start()
    } finally {
      this.retain -= 1
      this.pokeIdle()
    }
  }

  updateBackendSettings(settings: BackendSettings): void {
    const nextEnv = { ...this.config.serverEnv }
    const set = (key: string, value: string | undefined) => {
      if (value === undefined) return
      // An explicit empty value masks the inherited environment. Omitting a
      // setting leaves it unchanged; deleting it would silently re-enable it.
      nextEnv[key] = value.trim()
    }
    set("OMPIUI_HOST", settings.host)
    set("OMPIUI_PORT", settings.port)
    set("OMPIUI_PUBLIC_BASE_URL", settings.publicBaseUrl)
    set("OMPIUI_TUNNEL_URL", settings.tunnelUrl)
    set("OMPIUI_TUNNEL_KEY", settings.tunnelKey)
    set("OMPIUI_TUNNEL_ID", settings.tunnelId)
    set("OMPIUI_DRIVER", settings.driver)
    if (settings.serverUrl !== undefined) {
      const serverUrl = settings.serverUrl.trim().replace(/\/+$/, "")
      if (!/^https?:\/\//i.test(serverUrl)) throw new Error("serverUrl must be an http(s) URL")
      this.config.serverUrl = serverUrl
    }
    this.config.serverEnv = nextEnv
    saveAdminConfig(this.config, this.env)
  }

  publicBackendSettings(): Record<string, string> {
    const env = this.backendEnv()
    return {
      serverUrl: this.config.serverUrl,
      host: env.OMPIUI_HOST ?? "",
      port: env.OMPIUI_PORT ?? "",
      publicBaseUrl: env.OMPIUI_PUBLIC_BASE_URL ?? "",
      tunnelUrl: env.OMPIUI_TUNNEL_URL ?? "",
      tunnelId: env.OMPIUI_TUNNEL_ID ?? "",
      tunnelConfigured: env.OMPIUI_TUNNEL_URL?.trim() && env.OMPIUI_TUNNEL_KEY?.trim() ? "true" : "false",
    }
  }

  private backendEnv(): NodeJS.ProcessEnv {
    return { ...this.env, ...this.config.serverEnv }
  }

  private pokeIdle(): void {
    if (this.idleQueued) return
    this.idleQueued = true
    // Let the stop/restart HTTP response finish before foreground `start` closes.
    setImmediate(() => {
      this.idleQueued = false
      if (this.retain > 0 || this.starting || this.childAlive()) return
      const waiters = this.idleWaiters.splice(0)
      for (const waiter of waiters) waiter()
    })
  }

  private publishOwner(): void {
    if (!this.owner || !this.isRunning()) return
    writeOwnerRecord({ ...this.owner, pid: process.pid }, this.env)
  }

  private withdrawOwner(): void {
    if (!this.owner) return
    removeOwnerRecord(this.env, this.owner.nonce)
  }

  private async probeBackend(pathname: string): Promise<BackendProbe> {
    const backendEnv = this.backendEnv()
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
