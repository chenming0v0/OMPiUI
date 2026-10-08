/**
 * 中转服务本体：一个 HTTP(S) 入口 + 每条隧道一条桌面端控制连接。
 *
 * 公网访客（浏览器/OMPiUI App）看到的就是一个普通 HTTP 服务；每个请求被
 * 翻译成控制连接上的一条虚拟连接（open → body 流 → head/响应体/end），
 * 桌面端对 127.0.0.1:port 重放请求并把响应字节流回来。WS upgrade（事件
 * 流/终端流）不走 ServerResponse：中转手工写 101 头后把两侧 socket 纯字
 * 节拼接，流量对中转是不透明的。
 *
 * 安全语义沿用 Pebrel：接入密钥只比对 SHA-256 摘要、重复接入拒绝、心跳
 * 探活、无存储转发（对端不在线的请求直接 502）。
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import type { Duplex } from "node:stream"
import { readFileSync } from "node:fs"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import {
  CONNECTIONS_PER_TUNNEL_MAX,
  CONTROL_MESSAGE_MAX,
  CONTROL_PATH,
  HEARTBEAT_INTERVAL_MS,
  FRAME_PAYLOAD_MAX,
  MESSAGE_RATE_BURST,
  MESSAGE_RATE_PER_SECOND,
  WIRE_VERSION,
  decodeFrameMessage,
  relayProblemBody,
  serializeRawHead,
  stripHopByHopHeaders,
  type ControlFrame,
} from "./protocol.ts"
import { BodySink } from "./sink.ts"
import { ResponseSink } from "./response-sink.ts"
import { hashTunnelKey, type RelayConfig, type RelayTunnelConfig } from "./config.ts"

export interface StartRelayOptions {
  config: RelayConfig
  /** 结构化日志；缺省 console.info。测试传空函数静音。 */
  log?: (line: string) => void
}

export interface RunningRelay {
  server: Server
  /** 实际监听端口（config.port）。 */
  port: number
  close(): Promise<void>
  onlineTunnelIds(): string[]
}

interface VirtualConn {
  kind: "request" | "upgrade"
  res?: ServerResponse
  socket?: Duplex
  headSent: boolean
  response: ResponseSink
  request: BodySink
}

interface TunnelSession {
  id: string
  ws: WebSocket
  conns: Map<number, VirtualConn>
  alive: boolean
  rateTokens: number
  rateLast: number
}

/** 返回值语义：session=路由命中且在线；"offline"=命中已配置隧道但不在线；undefined=无路由。 */
type PickedTunnel = TunnelSession | "offline" | undefined

const TUNNEL_ID_HOSTNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export function startRelay(options: StartRelayOptions): Promise<RunningRelay> {
  const { config } = options
  const log = options.log ?? ((line: string) => console.info(line))
  const keyHashes = new Map<string, string>()
  for (const tunnel of config.tunnels) keyHashes.set(tunnel.id, hashTunnelKey(tunnel.key))

  const tunnels = new Map<string, TunnelSession>()
  let nextConnId = 1
  let heartbeat: NodeJS.Timeout | undefined

  const useTls = Boolean(config.tls)
  const server = useTls
    ? createHttpsServer({
        cert: readFileSync(config.tls!.cert),
        key: readFileSync(config.tls!.key),
      })
    : createHttpServer()
  const wss = new WebSocketServer({ noServer: true, maxPayload: CONTROL_MESSAGE_MAX })

  server.on("request", handleRequest)
  server.on("upgrade", handleUpgrade)
  server.on("clientError", (error, socket) => {
    // 畸形 HTTP 直接断，避免默认的裸文本响应泄漏内部细节
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n")
    void error
  })

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart)
    server.listen(config.port, config.host ?? "127.0.0.1", () => {
      server.removeListener("error", rejectStart)
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : config.port
      heartbeat = setInterval(() => {
        for (const session of tunnels.values()) {
          if (!session.alive) {
            session.ws.terminate()
            continue
          }
          session.alive = false
          session.ws.ping()
        }
      }, HEARTBEAT_INTERVAL_MS)
      heartbeat.unref()
      log(`[omp-relay] listening ${useTls ? "https" : "http"}://${config.host ?? "127.0.0.1"}:${port}`)
      if (!useTls) {
        log('[omp-relay] TLS is off — put Caddy/nginx (HTTPS) in front, or set "tls" in the config for direct exposure')
      }
      log(`[omp-relay] tunnels configured: ${config.tunnels.map(tunnel => tunnel.id).join(", ")}`)
      resolveStart({
        server,
        port,
        close: () => closeRelay(),
        onlineTunnelIds: () => [...tunnels.keys()],
      })
    })
  })

  async function closeRelay(): Promise<void> {
    if (heartbeat) clearInterval(heartbeat)
    for (const session of [...tunnels.values()]) disposeSession(session)
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      // 残留的访客/upgrade 连接直接断，保证 close() 可确定性返回
      server.closeAllConnections()
    })
  }

  // ---------- 控制通道（桌面端拨入） ----------

  function handleControlUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://relay.invalid")
    const tunnelId = (url.searchParams.get("tunnel") ?? req.headers["x-ompiui-tunnel"] ?? "")
      .toString()
      .trim()
      .toLowerCase()
    const authorization = req.headers.authorization ?? ""
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? ""
    const tunnel = config.tunnels.find(item => item.id === tunnelId)
    // 比较十六进制摘要（等长 64 字节，timing-safe）；未知隧道与坏密钥走同一
    // 条拒绝路径，不区分（避免探测隧道 ID）
    const digestHex = createHash("sha256").update(bearer, "utf8").digest("hex")
    const expectedHex = keyHashes.get(tunnelId) ?? hashTunnelKey("\u0000-invalid-\u0000")
    if (!tunnel || !timingSafeEqual(Buffer.from(digestHex, "utf8"), Buffer.from(expectedHex, "utf8"))) {
      rejectUpgrade(socket, 401, "Unauthorized")
      return
    }
    if (tunnels.has(tunnel.id)) {
      // Pebrel 同语义：先到先得，重复接入拒绝（防止新连接顶掉正在服务的旧连接）
      rejectUpgrade(socket, 409, "Tunnel already connected")
      return
    }
    wss.handleUpgrade(req, socket, head, ws => registerSession(ws, tunnel, req.headers.host ?? ""))
  }

  function registerSession(ws: WebSocket, tunnel: RelayTunnelConfig, controlHost: string): void {
    const session: TunnelSession = {
      id: tunnel.id,
      ws,
      conns: new Map(),
      alive: true,
      rateTokens: MESSAGE_RATE_BURST,
      rateLast: Date.now(),
    }
    tunnels.set(tunnel.id, session)
    log(`[omp-relay] tunnel "${tunnel.id}" connected (public entry: ${publicUrlFor(tunnel, controlHost)})`)
    sendControl(session, {
      type: "ready",
      v: WIRE_VERSION,
      tunnel: tunnel.id,
      publicUrl: publicUrlFor(tunnel, controlHost),
    })
    ws.on("pong", () => {
      session.alive = true
    })
    ws.on("message", (data: RawData, isBinary: boolean) => {
      try {
        handleTunnelMessage(session, data, isBinary)
      } catch (error) {
        log(`[omp-relay] tunnel "${session.id}" message error: ${error instanceof Error ? error.message : String(error)}`)
        session.ws.terminate()
      }
    })
    const drop = () => disposeSession(session)
    ws.on("close", drop)
    ws.on("error", drop)
  }

  function disposeSession(session: TunnelSession): void {
    if (!tunnels.has(session.id)) return
    tunnels.delete(session.id)
    for (const [connId, conn] of session.conns) {
      forgetConnection(session, connId)
      conn.res?.destroy()
      conn.socket?.destroy()
    }
    session.conns.clear()
    try {
      session.ws.terminate()
    } catch {
      // 已断开的连接 terminate 会抛，忽略
    }
    log(`[omp-relay] tunnel "${session.id}" disconnected (${tunnels.size} online)`)
  }

  function handleTunnelMessage(session: TunnelSession, data: RawData, isBinary: boolean): void {
    if (session.ws.readyState !== WebSocket.OPEN) return
    if (isBinary) {
      const raw = toBuffer(data)
      if (raw.length > FRAME_PAYLOAD_MAX + 4) {
        session.ws.terminate()
        return
      }
      const frame = decodeFrameMessage(raw)
      // 协议违例（帧头非法）直接断线，桌面端会退避重连
      if (!frame) {
        session.ws.terminate()
        return
      }
      deliverBody(session, frame.connId, frame.payload)
      return
    }
    const text = toBuffer(data).toString("utf8")
    if (text.length > CONTROL_MESSAGE_MAX) {
      session.ws.terminate()
      return
    }
    let frame: ControlFrame
    try {
      frame = JSON.parse(text) as ControlFrame
    } catch {
      session.ws.terminate()
      return
    }
    switch (frame.type) {
      case "head": {
        const conn = session.conns.get(frame.c)
        if (!conn || conn.headSent) return
        conn.headSent = true
        if (conn.kind === "request") {
          conn.res!.writeHead(frame.s, stripHopByHopHeaders(frame.h))
        } else {
          // upgrade 响应绕过 ServerResponse 直写 socket：101 头必须原样透传
          conn.response.write(serializeRawHead(frame.s, stripHopByHopHeaders(frame.h, true)))
        }
        return
      }
      case "end": {
        const conn = session.conns.get(frame.c)
        if (!conn) return
        // Keep the connection counted until all queued bytes have drained.
        conn.response.end()
        return
      }
      case "fail": {
        const conn = session.conns.get(frame.c)
        if (!conn) return
        forgetConnection(session, frame.c)
        if (conn.kind === "request" && !conn.headSent) {
          sendProblem(conn.res!, 502, "TUNNEL_UPSTREAM_FAILED", frame.e ?? "the computer behind the tunnel refused the connection")
        } else {
          conn.res?.destroy()
          conn.socket?.destroy()
        }
        return
      }
      case "close": {
        const conn = session.conns.get(frame.c)
        if (!conn) return
        forgetConnection(session, frame.c)
        conn.res?.destroy()
        conn.socket?.destroy()
        return
      }
      default:
        // 未知控制帧：忽略（向前兼容）
        return
    }
  }

  function deliverBody(session: TunnelSession, connId: number, payload: Buffer): void {
    session.conns.get(connId)?.response.write(payload)
  }

  function forgetConnection(session: TunnelSession, connId: number): VirtualConn | undefined {
    const conn = session.conns.get(connId)
    if (!conn) return
    session.conns.delete(connId)
    conn.response.dispose()
    conn.request.dispose()
    return conn
  }

  function abortConnection(session: TunnelSession, connId: number): void {
    const conn = forgetConnection(session, connId)
    if (!conn) return
    sendControl(session, { type: conn.kind === "request" ? "abort" : "close", c: connId })
    conn.res?.destroy()
    conn.socket?.destroy()
  }

  // ---------- 公网访客（HTTP + WS upgrade） ----------

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const pathname = safePathname(req)
    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      res.end("ok")
      return
    }
    const picked = pickTunnel(hostOf(req))
    const session = typeof picked === "object" ? picked : undefined
    if (!session) {
      if (picked === "offline") {
        sendProblem(res, 502, "TUNNEL_OFFLINE", "the tunnel is configured but the computer is not connected")
      } else {
        sendProblem(res, 404, "TUNNEL_NO_ROUTE", "no tunnel is bound to this host")
      }
      return
    }
    if (session.conns.size >= CONNECTIONS_PER_TUNNEL_MAX) {
      sendProblem(res, 503, "TUNNEL_BUSY", "the tunnel has reached its concurrent connection limit")
      return
    }
    if (!allowMessage(session)) {
      sendProblem(res, 429, "TUNNEL_RATE_LIMITED", "too many requests for this tunnel")
      return
    }
    forwardRequest(session, req, res)
  }

  function forwardRequest(session: TunnelSession, req: IncomingMessage, res: ServerResponse): void {
    const connId = nextConnId++
    const sink = new BodySink(session.ws)
    const response = new ResponseSink(res, () => abortConnection(session, connId), () => forgetConnection(session, connId))
    const conn: VirtualConn = { kind: "request", res, headSent: false, response, request: sink }
    session.conns.set(connId, conn)
    sendControl(session, {
      type: "open",
      c: connId,
      m: req.method ?? "GET",
      u: req.url ?? "/",
      h: withForwardedHeaders(stripHopByHopHeaders(req.headers), req),
    })
    req.on("data", (chunk: Buffer) => {
      if (session.conns.has(connId)) sink.write(connId, chunk, req)
    })
    req.on("end", () => {
      if (session.conns.has(connId)) sendControl(session, { type: "reqEnd", c: connId })
    })
    const abort = () => {
      // 访客中途断开：通知桌面端终止上游请求，避免本地连接悬挂
      abortConnection(session, connId)
    }
    req.on("aborted", abort)
    req.on("error", abort)
    res.on("error", abort)
    res.on("close", () => {
      if (res.writableEnded) return
      abort()
    })
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = safePathname(req)
    if (pathname === CONTROL_PATH) {
      handleControlUpgrade(req, socket, head)
      return
    }
    const picked = pickTunnel(hostOf(req))
    const session = typeof picked === "object" ? picked : undefined
    if (!session || session.conns.size >= CONNECTIONS_PER_TUNNEL_MAX) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n")
      socket.destroy()
      return
    }
    const connId = nextConnId++
    const sink = new BodySink(session.ws)
    const response = new ResponseSink(socket, () => abortConnection(session, connId), () => {
      forgetConnection(session, connId)
      socket.destroy()
    })
    const conn: VirtualConn = { kind: "upgrade", socket, headSent: false, response, request: sink }
    session.conns.set(connId, conn)
    // upgrade 的 connection/upgrade 头必须保留给 101 握手
    sendControl(session, {
      type: "open",
      c: connId,
      m: req.method ?? "GET",
      u: req.url ?? "/",
      h: withForwardedHeaders(stripHopByHopHeaders(req.headers, true), req),
    })
    if (head.length > 0) sink.write(connId, head, null)
    socket.on("data", (chunk: Buffer) => {
      if (session.conns.has(connId)) sink.write(connId, chunk, socket)
    })
    socket.on("error", () => {
      // 由 close 统一清理
    })
    socket.on("close", () => {
      abortConnection(session, connId)
    })
    socket.resume()
  }

  // ---------- 路由 / 工具 ----------

  function pickTunnel(requestHost: string): PickedTunnel {
    const explicitRouting = Boolean(config.domain) || config.tunnels.some(tunnel => tunnel.host)
    for (const tunnel of config.tunnels) {
      if (tunnel.host && tunnel.host === requestHost) {
        return tunnels.get(tunnel.id) ?? "offline"
      }
    }
    if (config.domain && requestHost.endsWith(`.${config.domain}`)) {
      const id = requestHost.slice(0, requestHost.length - config.domain.length - 1)
      if (TUNNEL_ID_HOSTNAME_PATTERN.test(id) && config.tunnels.some(tunnel => tunnel.id === id)) {
        return tunnels.get(id) ?? "offline"
      }
    }
    // 单隧道兜底只属于「没做任何显式路由」的个人部署：一旦运维配置了
    // host/domain 绑定，未匹配的 Host 不能被静默转发到别的隧道。
    if (!explicitRouting) {
      if (tunnels.size === 1) return tunnels.values().next().value
      if (tunnels.size === 0) return "offline"
    }
    return undefined
  }

  function publicUrlFor(tunnel: RelayTunnelConfig, controlHost: string): string | null {
    const base = config.publicUrl
    const routedHost = tunnel.host ?? (config.domain ? `${tunnel.id}.${config.domain}` : undefined)
    if (!routedHost && base) return base
    if (!routedHost && !controlHost) return null
    const url = new URL(base ?? `${useTls ? "https" : "http"}://${controlHost || routedHost}`)
    // publicUrl describes the externally reachable scheme/port (possibly a
    // reverse proxy); routing changes only its hostname, not that endpoint.
    if (routedHost) url.hostname = routedHost
    return url.origin
  }

  function allowMessage(session: TunnelSession): boolean {
    const now = Date.now()
    const elapsed = Math.max(0, now - session.rateLast) / 1000
    session.rateLast = now
    session.rateTokens = Math.min(MESSAGE_RATE_BURST, session.rateTokens + elapsed * MESSAGE_RATE_PER_SECOND)
    if (session.rateTokens < 1) return false
    session.rateTokens -= 1
    return true
  }

  function withForwardedHeaders(headers: Record<string, string>, req: IncomingMessage): Record<string, string> {
    const result = { ...headers }
    if (req.socket.remoteAddress) result["x-forwarded-for"] = req.socket.remoteAddress
    result["x-forwarded-proto"] = useTls ? "https" : "http"
    if (req.headers.host) result["x-forwarded-host"] = String(req.headers.host)
    return result
  }

  function sendControl(session: TunnelSession, frame: ControlFrame): void {
    if (session.ws.readyState !== WebSocket.OPEN) return
    session.ws.send(JSON.stringify(frame))
  }
}


function sendProblem(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.destroyed || res.writableEnded) return
  const body = relayProblemBody(code, message)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  socket.destroy()
}

function safePathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://relay.invalid").pathname
  } catch {
    return "/"
  }
}

function hostOf(req: IncomingMessage): string {
  return String(req.headers.host ?? "").trim().toLowerCase().replace(/:\d+$/, "")
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data as ArrayBuffer)
}
