import { PROTOCOL_VERSION } from "@ompiui/protocol"
import { getDriverMode } from "@ompiui/omp-worker"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Server as HttpServer } from "node:http"
import type { TunnelStatus } from "@ompiui/protocol"
import { authTokenPath, ensureCursorSecretEnv, resolveAuthToken } from "./host/auth-token.ts"
import { enableFileLogging, logToFile, dataRoot } from "./logger.ts"
import { PairingStore } from "./host/pairing.ts"
import { TailscaleManager } from "./host/tailscale.ts"
import { RuntimeSupervisor } from "./omp/supervisor.ts"
import { TunnelClient } from "./tunnel/tunnel-client.ts"
import { createAppServer, firstLanAddress, normalizePublicBaseUrl } from "./http.ts"
import { shutdownAppServer } from "./shutdown.ts"
import { attachEventWebSocket } from "./ws.ts"

export interface TunnelConfig {
  /** 中转控制入口（ws:// 或 wss://），如 wss://relay.example.com。 */
  url: string
  /** 中转接入密钥（omp-relay init 生成）。 */
  key: string
  /** 隧道 ID，需与中转配置一致。 */
  id: string
}

export interface ServerConfig {
  host: string
  port: number
  shutdownTimeoutMs: number
  driver: ReturnType<typeof getDriverMode>
  webRoot: string | null
  authToken?: string
  /**
   * 对外展示的公网基址（OMPIUI_PUBLIC_BASE_URL / --public-base-url），已
   * 规范化（无结尾斜杠）。设置后分享链接、启动日志和 Origin 白名单都以它
   * 为准；仍需运营者自行部署反向代理/隧道把它指到本服务，并建议 HTTPS。
   */
  publicBaseUrl: string | null
  /**
   * 自建中转（反向隧道）：配置后 server 主动拨号到中转并保持连接，公网
   * 浏览器/OMPiUI App 经中转的公网地址访问本服务——无需公网 IP/端口转发。
   */
  tunnel: TunnelConfig | null
}

export interface ServerConfigOverrides {
  host?: string
  port?: number
  webRoot?: string | null
  authToken?: string
  shutdownTimeoutMs?: number
  publicBaseUrl?: string | null
  tunnelUrl?: string | null
  tunnelKey?: string | null
  tunnelId?: string | null
  /**
   * 是否以 self-spawn 方式孵化 worker（bun 打包的单文件 exe 无法 fork，
   * worker = 同一个 exe 加 --omp-worker 再拉一个自己）。由 bundle-entry
   * 显式传入，不再用 OMPIUI_WORKER_SELF 环境变量传递（避免泄漏到子进程）。
   */
  selfSpawnWorker?: boolean
}

export interface RunningOmpiUiServer {
  server: HttpServer
  config: ServerConfig
  stop(signal?: NodeJS.Signals): Promise<void>
}

export interface WebCliOptions extends ServerConfigOverrides {
  help: boolean
}

const DEFAULT_PORT = 8787
const DEFAULT_HOST = "127.0.0.1"
// 用户请求关闭就应秒关。旧值 10s 会让「有在途会话/连接」的优雅关闭被
// server.close() 呆等截止时间才排空，壳子关窗被一起冻结到 ~11s。健康连接
// 毫秒级排空不受影响；这里只限制忙会话/残留连接的强断窗口。
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 500

export function resolveServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ServerConfigOverrides = {},
): ServerConfig {
  const port = overrides.port === undefined
    ? parsePort(env.OMPIUI_PORT ?? String(DEFAULT_PORT))
    : parsePort(String(overrides.port))
  const host = overrides.host ?? (env.OMPIUI_HOST?.trim() || DEFAULT_HOST)
  const requestedShutdownTimeout = overrides.shutdownTimeoutMs ?? Number(env.OMPIUI_SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS)
  const shutdownTimeoutMs = Number.isFinite(requestedShutdownTimeout) && requestedShutdownTimeout > 0
    ? requestedShutdownTimeout
    : DEFAULT_SHUTDOWN_TIMEOUT_MS
  const explicitWebRoot = overrides.webRoot === undefined ? env.OMPIUI_WEB_ROOT?.trim() : overrides.webRoot
  const rawPublicBaseUrl = overrides.publicBaseUrl !== undefined
    ? overrides.publicBaseUrl
    : env.OMPIUI_PUBLIC_BASE_URL?.trim() || null
  const publicBaseUrl = normalizePublicBaseUrl(rawPublicBaseUrl)
  if (rawPublicBaseUrl && !publicBaseUrl) {
    console.warn(
      `[ompiui-server] ignoring invalid public base URL: ${String(rawPublicBaseUrl).trim()} ` +
        "(expected an http(s) URL, e.g. https://panel.example.com)",
    )
  }
  const tunnel = resolveTunnelConfig(
    overrides.tunnelUrl !== undefined ? overrides.tunnelUrl : env.OMPIUI_TUNNEL_URL?.trim() || null,
    overrides.tunnelKey !== undefined ? overrides.tunnelKey : env.OMPIUI_TUNNEL_KEY?.trim() || null,
    overrides.tunnelId !== undefined ? overrides.tunnelId : env.OMPIUI_TUNNEL_ID?.trim() || null,
  )

  return {
    host,
    port,
    shutdownTimeoutMs,
    driver: getDriverMode(env),
    webRoot: explicitWebRoot === null ? null : explicitWebRoot || resolveWebRoot() || null,
    authToken: overrides.authToken,
    publicBaseUrl,
    tunnel,
  }
}

/**
 * 隧道配置三件套：url + key 都在才算配置（id 可省，默认 ompiui）。单项缺
 * 失或 URL 协议不对时给出可操作的告警并整体禁用——半配置状态下静默不启
 * 动会让用户以为穿透已生效。
 */
function resolveTunnelConfig(rawUrl: string | null, rawKey: string | null, rawId: string | null): TunnelConfig | null {
  const url = rawUrl?.trim().replace(/\/+$/, "") || null
  const key = rawKey?.trim() || null
  const id = rawId?.trim() || "ompiui"
  if (!url && !key) return null
  if (!url || !key) {
    console.warn("[ompiui-server] relay tunnel disabled: both OMPIUI_TUNNEL_URL and OMPIUI_TUNNEL_KEY are required")
    return null
  }
  if (!/^wss?:\/\//i.test(url)) {
    console.warn(`[ompiui-server] ignoring invalid tunnel URL: ${url} (expected ws:// or wss://, e.g. wss://relay.example.com)`)
    return null
  }
  return { url, key, id }
}

export function parseWebArgs(args: string[]): WebCliOptions {
  const options: WebCliOptions = { help: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }
    if (arg === "--api-only") {
      options.webRoot = null
      continue
    }
    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
    if (name === "--host") options.host = value
    else if (name === "--port") options.port = parsePort(value)
    else if (name === "--web-root") options.webRoot = value
    else if (name === "--public-base-url") options.publicBaseUrl = value
    else if (name === "--tunnel-url") options.tunnelUrl = value
    else if (name === "--tunnel-key") options.tunnelKey = value
    else if (name === "--tunnel-id") options.tunnelId = value
    else throw new Error(`unknown web option: ${arg}`)
  }
  return options
}

export function printWebHelp(): void {
  console.info(`Usage: omp-worker web [options]

Options:
  --host <host>       Listen address (default: 127.0.0.1)
  --port <port>       Listen port (default: 8787)
  --web-root <path>   Serve a specific web build directory
  --api-only          Disable SPA hosting while keeping the same service
  --public-base-url <url>  Public entry URL (e.g. https://panel.example.com)
                      used for share links and logs; a reverse proxy or
                      tunnel must forward it to this server (HTTPS advised)
  --tunnel-url <url>    Self-hosted relay control URL (wss://relay.example.com)
  --tunnel-key <key>    Relay access key (from "omp-relay init")
  --tunnel-id <id>      Tunnel id registered at the relay (default: ompiui)
  -h, --help          Show this help`)
}

export async function startOmpiUiServer(
  overrides: ServerConfigOverrides = {},
  options: { installSignalHandlers?: boolean } = {},
): Promise<RunningOmpiUiServer> {
  // 文件日志必须在任何 console 输出之前启用（含 resolveServerConfig 的
  // 警告），且要在 worker spawn 之前——worker 的 stderr 是 inherit 到
  // server 的，启用后它的输出也会落盘。
  enableFileLogging()
  const config = resolveServerConfig(process.env, overrides)
  const authToken = config.authToken ?? resolveAuthToken()
  // 分页光标密钥持久化并注入环境，保证 worker 重启后客户端旧光标仍有效
  // （必须在任何 worker spawn 之前完成）。
  ensureCursorSecretEnv()
  // POST /api/v1/host/shutdown 的钩子：createAppServer 返回后才定义 stop()，
  // 用可变引用延迟绑定 —— HTTP 请求只能发生在 listen 之后，届时 stop 已就位。
  let shutdownHook: (() => Promise<void>) | undefined
  // 隧道客户端在 listen 成功后启动；它的公网入口（relay 上报）要喂给
  // Origin 白名单和 share 链接，所以用可变引用 + getter 动态取。
  let tunnelClient: TunnelClient | undefined
  const getTunnelStatus = (): TunnelStatus | null => {
    if (tunnelClient) return tunnelClient.getStatus()
    if (!config.tunnel) return null
    return {
      enabled: true,
      state: "connecting",
      relayUrl: config.tunnel.url,
      tunnelId: config.tunnel.id,
      publicUrl: null,
      lastError: null,
      reconnectAttempts: 0,
    }
  }
  // 手机远程：一次性配对 + 内置 Tailscale（与 server 同生命周期）
  const pairing = new PairingStore()
  const tailscale = new TailscaleManager({ dataDir: dataRoot(), log: line => { console.info(line); logToFile(line) } })
  const app = createAppServer({
    authToken,
    share: { host: config.host, port: config.port, publicBaseUrl: config.publicBaseUrl },
    getPublicBaseUrl: () => getTunnelStatus()?.publicUrl ?? null,
    getTunnelStatus,
    pairing,
    tailscale,
    staticRoot: config.webRoot ?? undefined,
    onShutdown: () => shutdownHook?.(),
    supervisor: new RuntimeSupervisor({
      worker: { selfSpawn: overrides.selfSpawnWorker },
    }),
  })
  const eventServer = attachEventWebSocket(app.server, {
    eventHub: app.eventHub,
    authToken,
    allowedOrigins: () => [config.publicBaseUrl, getTunnelStatus()?.publicUrl ?? null],
    terminalManager: app.terminals,
    onSubscribe: send => {
      const snapshot = app.sessionHost.getActivitySnapshot()
      if (Object.keys(snapshot.sessions).length > 0) {
        send({
          channel: "event",
          event: {
            protocolVersion: PROTOCOL_VERSION,
            stream: { kind: "server", id: "server" },
            channel: "sessions.activity",
            cursor: app.eventHub.getCursor({ kind: "server", id: "server" }),
            eventId: `activity-snapshot-${Date.now()}`,
            timestamp: new Date().toISOString(),
            payload: snapshot as never,
          },
        })
      }
    },
  })

  // 后台预热共享 catalog worker，与 listen 并行：SDK 冷启动要秒级，预热每
  // 提前一点，首个 catalog 命令/会话 attach 就少等一点；预热失败不影响服
  // 务（真正用到时会重新孵化）。health 走只读快照保持毫秒级响应。
  void app.supervisor.getCatalogHandshake().catch(() => undefined)

  let listening = false
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (listening) {
          console.error("[ompiui-server] server error", error)
          return
        }
        if (error.code === "EADDRINUSE") {
          rejectListen(new Error(`${config.host}:${config.port} is already in use; use --port or OMPIUI_PORT`))
        } else {
          rejectListen(error)
        }
      }
      app.server.once("error", onError)
      app.server.listen(config.port, config.host, () => {
        listening = true
        app.server.removeListener("error", onError)
        resolveListen()
      })
    })
  } catch (error) {
    await shutdownAppServer(app.server, eventServer, { timeoutMs: config.shutdownTimeoutMs, cleanup: () => app.dispose() }).catch(() => undefined)
    throw error
  }
  app.server.on("error", error => console.error("[ompiui-server] server error", error))

  console.info(`[ompiui-server] listening http://${config.host}:${config.port}`)
  logToFile(`[ompiui-server] listening http://${config.host}:${config.port} (pid=${process.pid})`)
  console.info(`[ompiui-server] events ws://${config.host}:${config.port}/api/v1/events`)
  console.info(`[ompiui-server] terminal stream ws://${config.host}:${config.port}/api/v1/host/terminals/:terminalId/stream`)
  console.info(`[ompiui-server] driver=${config.driver}${config.driver === "omp" ? " (OMP agent runtime)" : " (no LLM)"}`)
  console.info(
    config.authToken
      ? "[ompiui-server] auth token configured by launcher"
      : process.env.OMPIUI_AUTH_TOKEN
      ? "[ompiui-server] auth token from OMPIUI_AUTH_TOKEN"
      : `[ompiui-server] auth token at ${authTokenPath()}`,
  )
  const lanHost = config.host === "0.0.0.0" || config.host === "::" ? firstLanAddress() ?? config.host : config.host
  if (config.webRoot) console.info(`[ompiui-server] web client: ${config.publicBaseUrl ?? `http://${lanHost}:${config.port}`}/?token=${encodeURIComponent(authToken)}`)
  if (config.tunnel) {
    console.info(`[ompiui-server] relay tunnel: dialing ${config.tunnel.url} (tunnel id "${config.tunnel.id}") — the public entry is logged once connected`)
    logToFile(`[ompiui-server] relay tunnel dialing ${config.tunnel.url} (id=${config.tunnel.id})`)
    tunnelClient = new TunnelClient({
      relayUrl: config.tunnel.url,
      key: config.tunnel.key,
      tunnelId: config.tunnel.id,
      localPort: config.port,
      onStatus: status => {
        if (status.state === "connected" && status.publicUrl) {
          console.info(`[ompiui-tunnel] public entry ${status.publicUrl} (relay ${status.relayUrl}, id ${status.tunnelId})`)
          logToFile(`[ompiui-tunnel] connected; public entry ${status.publicUrl}`)
        } else if (status.state === "reconnecting" && status.lastError) {
          console.warn(`[ompiui-tunnel] ${status.lastError}; retrying with backoff`)
        } else if (status.state === "disabled") {
          console.info("[ompiui-tunnel] tunnel stopped")
        }
      },
    })
    tunnelClient.start()
  }
  if (config.publicBaseUrl) {
    console.info(
      `[ompiui-server] public sharing via ${config.publicBaseUrl} — a reverse proxy/tunnel must forward it to ` +
        `http://${config.host}:${config.port} (HTTPS strongly recommended); ` +
        "anyone holding the link can read the workspace, open terminals, run commands and drive the agent",
    )
  } else if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost") {
    console.info(`[ompiui-server] LAN sharing enabled at http://${lanHost}:${config.port}`)
  }

  let stopped = false
  const stop = async (signal?: NodeJS.Signals): Promise<void> => {
    if (stopped) return
    stopped = true
    if (signal) console.info(`[ompiui-server] received ${signal}, shutting down`)
    // 先断隧道：中转不再往这边送新请求，然后才排空/关闭 HTTP 服务
    tunnelClient?.stop()
    tailscale.dispose()
    await shutdownAppServer(app.server, eventServer, {
      timeoutMs: config.shutdownTimeoutMs,
      onTimeout: () => console.error(`[ompiui-server] shutdown exceeded ${config.shutdownTimeoutMs}ms; closing active HTTP connections`),
      cleanup: () => app.dispose(),
    })
  }
  shutdownHook = stop

  if (options.installSignalHandlers !== false) {
    process.once("SIGINT", () => { void stop("SIGINT").catch(error => { console.error("[ompiui-server] shutdown failed", error); process.exitCode = 1 }) })
    process.once("SIGTERM", () => { void stop("SIGTERM").catch(error => { console.error("[ompiui-server] shutdown failed", error); process.exitCode = 1 }) })

    // 未捕获异常 = 进程级错误，必须退出（Node 事件循环状态已不可信），
    // 但不能直接崩——否则监听 socket 和活动连接僵死，Windows 上留下孤儿
    // TCP 实体占住端口（与 taskkill /F 同一类问题）。先走 stop() 优雅
    // 关闭再退出，日志里带堆栈便于定位死因。
    process.once("uncaughtException", error => {
      console.error("[ompiui-server] uncaught exception; shutting down gracefully:", error)
      stop().finally(() => process.exit(1))
    })
    // 单个请求/事件的异步疏忽不应杀死整个服务：记录并继续。
    process.on("unhandledRejection", reason => {
      console.error(`[ompiui-server] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
    })
  }

  return { server: app.server, config, stop }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`OMPIUI_PORT must be an integer from 1 to 65535, received: ${value}`)
  }
  return port
}

function resolveWebRoot(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(dirname(process.execPath), "web"),
    join(moduleDir, "../../app/dist"),
    resolve(process.cwd(), "packages/app/dist"),
  ]
  return candidates.find(candidate => existsSync(join(candidate, "index.html")))
}
