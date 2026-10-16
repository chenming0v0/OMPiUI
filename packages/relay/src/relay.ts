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

import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  CONNECTIONS_PER_TUNNEL_MAX,
  CONTROL_MESSAGE_MAX,
  CONTROL_PATH,
  HEARTBEAT_INTERVAL_MS,
  FRAME_PAYLOAD_MAX,
  BACKPRESSURE_HIGH_WATER,
  BACKPRESSURE_LOW_WATER,
  MESSAGE_RATE_BURST,
  MESSAGE_RATE_PER_SECOND,
  WIRE_VERSION,
  allocateConnectionId,
  decodeFrameMessage,
  relayProblemBody,
  serializeRawHead,
  stripHopByHopHeaders,
  type ControlFrame,
} from "./protocol.ts";
import {
  isTrustedProxy,
  parseTrustedProxies,
  resolveForwardedClient,
} from "./trusted-proxy.ts";
import { BodySink } from "./sink.ts";
import { DataRateLimit } from "./data-rate-limit.ts";
import { ResponseSink } from "./response-sink.ts";
import {
  hashTunnelKey,
  type RelayConfig,
  type RelayTunnelConfig,
} from "./config.ts";

export interface StartRelayOptions {
  config: RelayConfig;
  /** 结构化日志；缺省 console.info。测试传空函数静音。 */
  log?: (line: string) => void;
  connectionIdleTimeoutMs?: number;
}

export interface RunningRelay {
  server: Server;
  /** 实际监听端口（config.port）。 */
  port: number;
  close(): Promise<void>;
  onlineTunnelIds(): string[];
  tunnelStatus(): Array<{ id: string; online: boolean; connections: number }>;
  disconnectTunnel(id: string): boolean;
}

interface VirtualConn {
  kind: "request" | "upgrade";
  res?: ServerResponse;
  socket?: Duplex;
  openSent: boolean;
  headSent: boolean;
  response: ResponseSink;
  request: BodySink;
  upload: DataRateLimit;
  download: DataRateLimit;
  source: string;
  lastActivity: number;
  counted: boolean;
  requestStream?: IncomingMessage | Duplex;
  uploadEnded: boolean;
  pendingTimer?: NodeJS.Timeout;
  createdAt: number;
  progressBytes: number;
  progressSampleAt: number;
  progressSampleBytes: number;
}

interface TunnelSession {
  id: string;
  ws: WebSocket;
  conns: Map<number, VirtualConn>;
  alive: boolean;
  rateTokens: number;
  rateLast: number;
  upload: DataRateLimit;
  download: DataRateLimit;
  control: DataRateLimit;
  controlOut: DataRateLimit;
  cleanupOut: DataRateLimit;
  controlQueue: Array<{ data: string; bytes: number; cleanup: boolean; frame: ControlFrame }>;
  controlQueuedBytes: number;
  controlFlushTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

/** 返回值语义：session=路由命中且在线；"offline"=命中已配置隧道但不在线；undefined=无路由。 */
type PickedTunnel = TunnelSession | "offline" | undefined;

const TUNNEL_ID_HOSTNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PENDING_CONNECTIONS_MAX = CONNECTIONS_PER_TUNNEL_MAX;
const PENDING_CONNECTION_TTL_MS = 10_000;
const CONTROL_QUEUE_MAX_BYTES = 1024 * 1024;
const MAX_CONNECTION_LIFETIME_MS = 30 * 60_000;
const MIN_PROGRESS_WINDOW_MS = 60_000;
const MIN_PROGRESS_BYTES = 1024;

export function startRelay(options: StartRelayOptions): Promise<RunningRelay> {
  const { config } = options;
  const log = options.log ?? ((line: string) => console.info(line));
  const keyHashes = new Map<string, string>();
  for (const tunnel of config.tunnels)
    keyHashes.set(tunnel.id, hashTunnelKey(tunnel.key));
  const trustedProxies = parseTrustedProxies(config.trustedProxies ?? []);

  const tunnels = new Map<string, TunnelSession>();
  let nextConnId = 1;
  let heartbeat: NodeJS.Timeout | undefined;

  const useTls = Boolean(config.tls);
  const server = useTls
    ? createHttpsServer({
        cert: readFileSync(config.tls!.cert),
        key: readFileSync(config.tls!.key),
      })
    : createHttpServer();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: CONTROL_MESSAGE_MAX,
    autoPong: false,
    // 隧道协议要求每条消息恰好一帧，拒绝 continuation 重组绕过计量。
    maxFragments: 1,
  });

  server.on("request", handleRequest);
  server.on("upgrade", handleUpgrade);
  server.on("clientError", (error, socket) => {
    // 畸形 HTTP 直接断，避免默认的裸文本响应泄漏内部细节
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
      );
    void error;
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(config.port, config.host ?? "127.0.0.1", () => {
      server.removeListener("error", rejectStart);
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : config.port;
      heartbeat = setInterval(() => {
        for (const session of tunnels.values()) {
          if (!session.alive) {
            session.ws.terminate();
            continue;
          }
          session.alive = false;
          session.ws.ping();
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();
      log(
        `[omp-relay] listening ${useTls ? "https" : "http"}://${config.host ?? "127.0.0.1"}:${port}`,
      );
      if (!useTls) {
        log(
          '[omp-relay] TLS is off — put Caddy/nginx (HTTPS) in front, or set "tls" in the config for direct exposure',
        );
      }
      log(
        `[omp-relay] tunnels configured: ${config.tunnels.map((tunnel) => tunnel.id).join(", ")}`,
      );
      resolveStart({
        server,
        port,
        close: () => closeRelay(),
        onlineTunnelIds: () => [...tunnels.keys()],
        tunnelStatus: () =>
          config.tunnels.map((tunnel) => ({
            id: tunnel.id,
            online: tunnels.has(tunnel.id),
            connections: tunnels.get(tunnel.id)?.conns.size ?? 0,
          })),
        disconnectTunnel: (id) => {
          const session = tunnels.get(id);
          if (!session) return false;
          disposeSession(session);
          return true;
        },
      });
    });
  });

  async function closeRelay(): Promise<void> {
    if (heartbeat) clearInterval(heartbeat);
    for (const session of [...tunnels.values()]) disposeSession(session);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // 残留的访客/upgrade 连接直接断，保证 close() 可确定性返回
      server.closeAllConnections();
    });
  }

  // ---------- 控制通道（桌面端拨入） ----------

  function handleControlUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    const tunnelId = (
      url.searchParams.get("tunnel") ??
      req.headers["x-ompiui-tunnel"] ??
      ""
    )
      .toString()
      .trim()
      .toLowerCase();
    const authorization = req.headers.authorization ?? "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? "";
    const tunnel = config.tunnels.find((item) => item.id === tunnelId);
    // 比较十六进制摘要（等长 64 字节，timing-safe）；未知隧道与坏密钥走同一
    // 条拒绝路径，不区分（避免探测隧道 ID）
    const digestHex = createHash("sha256").update(bearer, "utf8").digest("hex");
    const expectedHex =
      keyHashes.get(tunnelId) ?? hashTunnelKey("\u0000-invalid-\u0000");
    if (
      !tunnel ||
      !timingSafeEqual(
        Buffer.from(digestHex, "utf8"),
        Buffer.from(expectedHex, "utf8"),
      )
    ) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (tunnels.has(tunnel.id)) {
      // Pebrel 同语义：先到先得，重复接入拒绝（防止新连接顶掉正在服务的旧连接）
      rejectUpgrade(socket, 409, "Tunnel already connected");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      registerSession(ws, tunnel, req.headers.host ?? ""),
    );
  }

  function registerSession(
    ws: WebSocket,
    tunnel: RelayTunnelConfig,
    controlHost: string,
  ): void {
    const session: TunnelSession = {
      id: tunnel.id,
      ws,
      conns: new Map(),
      alive: true,
      rateTokens: MESSAGE_RATE_BURST,
      rateLast: Date.now(),
      upload: new DataRateLimit(),
      download: new DataRateLimit(),
      control: new DataRateLimit(1024 * 1024, 2 * 1024 * 1024),
      controlOut: new DataRateLimit(1024 * 1024, 2 * 1024 * 1024),
      cleanupOut: new DataRateLimit(64 * 1024, 128 * 1024),
      controlQueue: [],
      controlQueuedBytes: 0,
    };
    tunnels.set(tunnel.id, session);
    const idleMs = options.connectionIdleTimeoutMs ?? 120_000;
    session.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of session.conns) {
        if (now - conn.createdAt >= MAX_CONNECTION_LIFETIME_MS) {
          abortConnection(session, id);
          continue;
        }
        if (now - conn.progressSampleAt >= MIN_PROGRESS_WINDOW_MS) {
          const progressed = conn.progressBytes - conn.progressSampleBytes;
          conn.progressSampleAt = now;
          conn.progressSampleBytes = conn.progressBytes;
          const healthyUpgrade = conn.kind === "upgrade" && conn.headSent &&
            !conn.request.hasPendingData && !conn.response.hasPendingData;
          if (progressed < MIN_PROGRESS_BYTES && !healthyUpgrade) {
            abortConnection(session, id);
            continue;
          }
        }
        if (now - conn.lastActivity >= idleMs) abortConnection(session, id);
      }
    }, Math.min(30_000, Math.max(10, idleMs / 2)));
    session.idleTimer.unref();
    log(
      `[omp-relay] tunnel "${tunnel.id}" connected (public entry: ${publicUrlFor(tunnel, controlHost)})`,
    );
    sendControl(session, {
      type: "ready",
      v: WIRE_VERSION,
      tunnel: tunnel.id,
      publicUrl: publicUrlFor(tunnel, controlHost),
    });
    ws.on("pong", () => {
      session.alive = true;
    });
    ws.on("ping", data => {
      const bytes = data.length + 14;
      if (ws.bufferedAmount + bytes > BACKPRESSURE_HIGH_WATER ||
        !session.control.canAllow(bytes, 1) || !session.controlOut.canAllow(bytes, 1)) {
        ws.terminate();
        return;
      }
      session.control.allow(bytes, 1);
      session.controlOut.allow(bytes, 1);
      ws.pong(data);
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      try {
        handleTunnelMessage(session, data, isBinary);
      } catch (error) {
        log(
          `[omp-relay] tunnel "${session.id}" message error: ${error instanceof Error ? error.message : String(error)}`,
        );
        session.ws.terminate();
      }
    });
    const drop = () => disposeSession(session);
    ws.on("close", drop);
    ws.on("error", drop);
  }

  function disposeSession(session: TunnelSession): void {
    if (!tunnels.has(session.id)) return;
    tunnels.delete(session.id);
    clearInterval(session.idleTimer);
    clearTimeout(session.controlFlushTimer);
    for (const [connId, conn] of session.conns) {
      forgetConnection(session, connId);
      conn.res?.destroy();
      conn.socket?.destroy();
    }
    session.conns.clear();
    session.controlQueue.length = 0;
    session.controlQueuedBytes = 0;
    session.controlFlushTimer = undefined;
    try {
      session.ws.terminate();
    } catch {
      // 已断开的连接 terminate 会抛，忽略
    }
    log(
      `[omp-relay] tunnel "${session.id}" disconnected (${tunnels.size} online)`,
    );
  }

  function handleTunnelMessage(
    session: TunnelSession,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (session.ws.readyState !== WebSocket.OPEN) return;
    const rawData = toBuffer(data);
    if (isBinary) {
      const raw = rawData;
      if (raw.length > FRAME_PAYLOAD_MAX + 4) {
        session.ws.terminate();
        return;
      }
      const frame = decodeFrameMessage(raw);
      // 协议违例（帧头非法）直接断线，桌面端会退避重连
      if (!frame) {
        session.ws.terminate();
        return;
      }
      if (!session.download.allow(raw.length + 14)) {
        abortConnection(session, frame.connId);
        return;
      }
      deliverBody(session, frame.connId, frame.payload);
      return;
    }
    if (rawData.length > CONTROL_MESSAGE_MAX) {
      session.ws.terminate();
      return;
    }
    const text = rawData.toString("utf8");
    let frame: ControlFrame;
    try {
      frame = JSON.parse(text) as ControlFrame;
    } catch {
      session.ws.terminate();
      return;
    }
    if (!session.control.allow(rawData.length + 14)) {
      if ("c" in frame) abortConnection(session, frame.c);
      return;
    }
    switch (frame.type) {
      case "head": {
        const conn = session.conns.get(frame.c);
        if (!conn || conn.headSent) return;
        if (!activateConnection(session, conn)) return;
        conn.lastActivity = Date.now();
        conn.headSent = true;
        if (conn.kind === "request") {
          conn.res!.writeHead(frame.s, stripHopByHopHeaders(frame.h));
        } else {
          // upgrade 响应绕过 ServerResponse 直写 socket：101 头必须原样透传
          conn.response.write(
            serializeRawHead(frame.s, stripHopByHopHeaders(frame.h, true)),
          );
        }
        return;
      }
      case "end": {
        const conn = session.conns.get(frame.c);
        if (!conn) return;
        conn.uploadEnded = true;
        conn.request.dispose();
        conn.requestStream?.pause();
        // Keep the connection counted until all queued bytes have drained.
        conn.response.end();
        return;
      }
      case "fail": {
        const conn = session.conns.get(frame.c);
        if (!conn) return;
        forgetConnection(session, frame.c);
        if (conn.kind === "request" && !conn.headSent) {
          sendProblem(
            conn.res!,
            502,
            "TUNNEL_UPSTREAM_FAILED",
            frame.e ?? "the computer behind the tunnel refused the connection",
          );
        } else {
          conn.res?.destroy();
          conn.socket?.destroy();
        }
        return;
      }
      case "close": {
        const conn = session.conns.get(frame.c);
        if (!conn) return;
        forgetConnection(session, frame.c);
        conn.res?.destroy();
        conn.socket?.destroy();
        return;
      }
      default:
        // 未知控制帧：忽略（向前兼容）
        return;
    }
  }

  function deliverBody(
    session: TunnelSession,
    connId: number,
    payload: Buffer,
  ): void {
    const conn = session.conns.get(connId);
    if (!conn) return;
    if (!activateConnection(session, conn)) return;
    conn.lastActivity = Date.now();
    conn.progressBytes += payload.length;
    if (!conn.download.allow(payload.length + 18)) {
      abortConnection(session, connId);
      return;
    }
    conn.response.write(payload);
  }

  function forgetConnection(
    session: TunnelSession,
    connId: number,
  ): VirtualConn | undefined {
    const conn = session.conns.get(connId);
    if (!conn) return;
    session.conns.delete(connId);
    for (let index = session.controlQueue.length - 1; index >= 0; index--) {
      const item = session.controlQueue[index]!;
      if ("c" in item.frame && item.frame.c === connId) {
        session.controlQueue.splice(index, 1);
        session.controlQueuedBytes -= item.bytes;
      }
    }
    if (session.controlQueue.length === 0) {
      clearTimeout(session.controlFlushTimer);
      session.controlFlushTimer = undefined;
    }
    conn.response.dispose();
    conn.request.dispose();
    clearTimeout(conn.pendingTimer);
    return conn;
  }

  function abortConnection(session: TunnelSession, connId: number): void {
    const conn = forgetConnection(session, connId);
    if (!conn) return;
    conn.requestStream?.pause();
    conn.requestStream?.removeAllListeners("data");
    conn.requestStream?.destroy();
    if (conn.openSent) sendControl(session, {
      type: conn.kind === "request" ? "abort" : "close",
      c: connId,
    });
    conn.res?.destroy();
    conn.socket?.destroy();
  }

  // ---------- 公网访客（HTTP + WS upgrade） ----------

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const pathname = safePathname(req);
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      pathname === "/healthz"
    ) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    const picked = pickTunnel(hostOf(req));
    const session = typeof picked === "object" ? picked : undefined;
    if (!session) {
      if (picked === "offline") {
        sendProblem(
          res,
          502,
          "TUNNEL_OFFLINE",
          "the tunnel is configured but the computer is not connected",
        );
      } else {
        sendProblem(
          res,
          404,
          "TUNNEL_NO_ROUTE",
          "no tunnel is bound to this host",
        );
      }
      return;
    }
    if (!hasConnectionSlot(session, req)) {
      sendProblem(
        res,
        503,
        "TUNNEL_BUSY",
        "the tunnel has reached its concurrent connection limit",
      );
      return;
    }
    if (!allowMessage(session)) {
      sendProblem(
        res,
        429,
        "TUNNEL_RATE_LIMITED",
        "too many requests for this tunnel",
      );
      return;
    }
    forwardRequest(session, req, res);
  }

  function forwardRequest(
    session: TunnelSession,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const connId = allocateConnId();
    const sink = new BodySink(session.ws, (bytes, frames) => {
      if (
        !session.upload.canAllow(bytes, frames) ||
        !conn.upload.canAllow(bytes, frames)
      )
        return Math.max(session.upload.delayMs(bytes, frames), conn.upload.delayMs(bytes, frames));
      session.upload.allow(bytes, frames);
      conn.upload.allow(bytes, frames);
      return true;
    });
    const response = new ResponseSink(
      res,
      () => abortConnection(session, connId),
      () => forgetConnection(session, connId),
    );
    const conn: VirtualConn = {
      kind: "request",
      uploadEnded: false,
      res,
      openSent: false,
      headSent: false,
      response,
      request: sink,
      upload: new DataRateLimit(4 * 1024 * 1024, 8 * 1024 * 1024),
      download: new DataRateLimit(),
      source: clientAddress(req),
      lastActivity: Date.now(),
      counted: false,
      requestStream: req,
      createdAt: Date.now(),
      progressBytes: 0,
      progressSampleAt: Date.now(),
      progressSampleBytes: 0,
    };
    session.conns.set(connId, conn);
    conn.pendingTimer = setTimeout(() => abortConnection(session, connId), PENDING_CONNECTION_TTL_MS);
    conn.pendingTimer.unref();
    sink.hold(req);
    req.on("data", (chunk: Buffer) => {
      if (session.conns.get(connId) !== conn || conn.uploadEnded) return;
      if (!activateConnection(session, conn)) return;
      conn.lastActivity = Date.now();
      conn.progressBytes += chunk.length;
      sink.write(connId, chunk, req);
    });
    req.on("end", () => {
      if (session.conns.get(connId) === conn && !conn.uploadEnded)
        sendControl(session, { type: "reqEnd", c: connId });
    });
    const abort = () => {
      // 访客中途断开：通知桌面端终止上游请求，避免本地连接悬挂
      if (session.conns.get(connId) === conn) abortConnection(session, connId);
    };
    req.on("aborted", abort);
    req.on("error", abort);
    res.on("error", abort);
    res.on("close", () => {
      if (res.writableEnded) return;
      abort();
    });
    sendControl(session, {
      type: "open",
      c: connId,
      m: req.method ?? "GET",
      u: req.url ?? "/",
      h: withForwardedHeaders(stripHopByHopHeaders(req.headers), req),
    });
  }

  function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const pathname = safePathname(req);
    if (pathname === CONTROL_PATH) {
      handleControlUpgrade(req, socket, head);
      return;
    }
    const picked = pickTunnel(hostOf(req));
    const session = typeof picked === "object" ? picked : undefined;
    if (!session || !hasConnectionSlot(session, req)) {
      socket.end(
        "HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        () => socket.destroy(),
      );
      return;
    }
    if (!allowMessage(session)) {
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        () => socket.destroy(),
      );
      return;
    }
    const connId = allocateConnId();
    const sink = new BodySink(session.ws, (bytes, frames) => {
      if (
        !session.upload.canAllow(bytes, frames) ||
        !conn.upload.canAllow(bytes, frames)
      )
        return Math.max(session.upload.delayMs(bytes, frames), conn.upload.delayMs(bytes, frames));
      session.upload.allow(bytes, frames);
      conn.upload.allow(bytes, frames);
      return true;
    });
    const response = new ResponseSink(
      socket,
      () => abortConnection(session, connId),
      () => {
        forgetConnection(session, connId);
        socket.destroy();
      },
    );
    const conn: VirtualConn = {
      kind: "upgrade",
      uploadEnded: false,
      socket,
      openSent: false,
      headSent: false,
      response,
      request: sink,
      upload: new DataRateLimit(4 * 1024 * 1024, 8 * 1024 * 1024),
      download: new DataRateLimit(),
      source: clientAddress(req),
      lastActivity: Date.now(),
      counted: false,
      requestStream: socket,
      createdAt: Date.now(),
      progressBytes: 0,
      progressSampleAt: Date.now(),
      progressSampleBytes: 0,
    };
    session.conns.set(connId, conn);
    conn.pendingTimer = setTimeout(() => abortConnection(session, connId), PENDING_CONNECTION_TTL_MS);
    conn.pendingTimer.unref();
    sink.hold(socket);
    if (head.length > 0) {
      sink.write(connId, head, socket);
    }
    socket.on("data", (chunk: Buffer) => {
      if (session.conns.get(connId) !== conn || conn.uploadEnded) return;
      if (!activateConnection(session, conn)) return;
      conn.lastActivity = Date.now();
      conn.progressBytes += chunk.length;
      sink.write(connId, chunk, socket);
    });
    const abort = () => {
      if (session.conns.get(connId) === conn) abortConnection(session, connId);
    };
    socket.on("end", () => {
      abort();
      socket.destroy();
    });
    socket.on("error", () => {
      // 由 close 统一清理
    });
    socket.on("close", abort);
    // upgrade 的 connection/upgrade 头必须保留给 101 握手
    sendControl(session, {
      type: "open",
      c: connId,
      m: req.method ?? "GET",
      u: req.url ?? "/",
      h: withForwardedHeaders(stripHopByHopHeaders(req.headers, true), req),
    });
  }

  // ---------- 路由 / 工具 ----------

  function pickTunnel(requestHost: string): PickedTunnel {
    const explicitRouting =
      Boolean(config.domain) || config.tunnels.some((tunnel) => tunnel.host);
    for (const tunnel of config.tunnels) {
      if (tunnel.host && tunnel.host === requestHost) {
        return tunnels.get(tunnel.id) ?? "offline";
      }
    }
    if (config.domain && requestHost.endsWith(`.${config.domain}`)) {
      const id = requestHost.slice(
        0,
        requestHost.length - config.domain.length - 1,
      );
      if (
        TUNNEL_ID_HOSTNAME_PATTERN.test(id) &&
        config.tunnels.some((tunnel) => tunnel.id === id)
      ) {
        return tunnels.get(id) ?? "offline";
      }
    }
    // 单隧道兜底只属于「没做任何显式路由」的个人部署：一旦运维配置了
    // host/domain 绑定，未匹配的 Host 不能被静默转发到别的隧道。
    if (!explicitRouting) {
      if (tunnels.size === 1) return tunnels.values().next().value;
      if (tunnels.size === 0) return "offline";
    }
    return undefined;
  }

  function publicUrlFor(
    tunnel: RelayTunnelConfig,
    controlHost: string,
  ): string | null {
    const base = config.publicUrl;
    const routedHost =
      tunnel.host ??
      (config.domain ? `${tunnel.id}.${config.domain}` : undefined);
    if (!routedHost && base) return base;
    if (!routedHost && !controlHost) return null;
    const url = new URL(
      base ?? `${useTls ? "https" : "http"}://${controlHost || routedHost}`,
    );
    // publicUrl describes the externally reachable scheme/port (possibly a
    // reverse proxy); routing changes only its hostname, not that endpoint.
    if (routedHost) url.hostname = routedHost;
    return url.origin;
  }

  function allowMessage(session: TunnelSession): boolean {
    const now = Date.now();
    const elapsed = Math.max(0, now - session.rateLast) / 1000;
    session.rateLast = now;
    session.rateTokens = Math.min(
      MESSAGE_RATE_BURST,
      session.rateTokens + elapsed * MESSAGE_RATE_PER_SECOND,
    );
    if (session.rateTokens < 1) return false;
    session.rateTokens -= 1;
    return true;
  }

  function withForwardedHeaders(
    headers: Record<string, string>,
    req: IncomingMessage,
  ): Record<string, string> {
    const result = { ...headers };
    // 访客可伪造任意 XFF;这里一律先删除,再按可信链写回
    delete result["x-forwarded-for"];
    const peer = req.socket.remoteAddress;
    const client = isTrustedProxy(peer, trustedProxies)
      ? (resolveForwardedClient(
          req.headers["x-forwarded-for"],
          trustedProxies,
        ) ?? peer)
      : peer;
    if (client) result["x-forwarded-for"] = client;
    result["x-forwarded-proto"] = useTls ? "https" : "http";
    if (req.headers.host) result["x-forwarded-host"] = String(req.headers.host);
    return result;
  }

  function clientAddress(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress;
    return (isTrustedProxy(peer, trustedProxies)
      ? resolveForwardedClient(req.headers["x-forwarded-for"], trustedProxies) ?? peer : peer) ?? "unknown";
  }

  function hasConnectionSlot(session: TunnelSession, req: IncomingMessage): boolean {
    const active = [...session.conns.values()].filter(conn => conn.counted).length;
    const pending = session.conns.size - active;
    if (active >= CONNECTIONS_PER_TUNNEL_MAX || pending >= PENDING_CONNECTIONS_MAX || active + pending >= CONNECTIONS_PER_TUNNEL_MAX) return false;
    const source = clientAddress(req);
    let count = 0;
    for (const conn of session.conns.values()) if (conn.source === source) count++;
    return count < CONNECTIONS_PER_TUNNEL_MAX / 2;
  }

  function isConnectionIdActive(id: number): boolean {
    for (const session of tunnels.values()) {
      if (session.conns.has(id)) return true;
    }
    return false;
  }

  function allocateConnId(): number {
    const id = allocateConnectionId(nextConnId, isConnectionIdActive);
    nextConnId = (id + 1) >>> 0;
    return id;
  }

  function sendControl(session: TunnelSession, frame: ControlFrame): void {
    if (session.ws.readyState !== WebSocket.OPEN) return;
    const send = () => enqueueControl(session, frame);
    const sink =
      "c" in frame && (frame.type === "reqEnd" || frame.type === "close")
        ? session.conns.get(frame.c)?.request
        : undefined;
    if (sink && "c" in frame) sink.finish(frame.c, send);
    else send();
  }

  function activateConnection(session: TunnelSession, conn: VirtualConn): boolean {
    if (conn.counted) return true;
    const active = [...session.conns.values()].filter(item => item.counted).length;
    if (active >= CONNECTIONS_PER_TUNNEL_MAX) {
      const connId = [...session.conns.entries()].find(([, item]) => item === conn)?.[0];
      if (connId !== undefined) abortConnection(session, connId);
      return false;
    }
    conn.counted = true;
    clearTimeout(conn.pendingTimer);
    conn.pendingTimer = undefined;
    return true;
  }

  function enqueueControl(session: TunnelSession, frame: ControlFrame): void {
    if (session.ws.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(frame);
    const bytes = Buffer.byteLength(data);
    const cleanup = frame.type === "abort" || frame.type === "close";
    if (!cleanup && session.controlQueuedBytes + bytes > CONTROL_QUEUE_MAX_BYTES) {
      if ("c" in frame) {
        const conn = forgetConnection(session, frame.c);
        if (conn?.res && !conn.res.headersSent) sendProblem(conn.res, 429, "TUNNEL_RATE_LIMITED", "control capacity reached");
        else conn?.res?.destroy();
        conn?.socket?.destroy();
        if (conn?.openSent) enqueueControl(session, { type: "abort", c: frame.c });
      }
      return;
    }
    session.controlQueue.push({ data, bytes, cleanup, frame });
    session.controlQueuedBytes += bytes;
    flushControl(session);
  }

  function flushControl(session: TunnelSession): void {
    clearTimeout(session.controlFlushTimer);
    session.controlFlushTimer = undefined;
    if (session.ws.readyState !== WebSocket.OPEN) return;
    if (session.ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
      session.controlFlushTimer = setTimeout(() => flushControl(session), 25);
      session.controlFlushTimer.unref();
      return;
    }
    while (session.controlQueue.length > 0 && session.ws.bufferedAmount <= BACKPRESSURE_HIGH_WATER) {
      const item = session.controlQueue[0]!;
      const allowed = (item.cleanup ? session.cleanupOut : session.controlOut).allow(item.bytes + 14);
      if (!allowed) {
        if (!item.cleanup) {
          session.controlQueue.shift();
          session.controlQueuedBytes -= item.bytes;
          if ("c" in item.frame) {
            const conn = forgetConnection(session, item.frame.c);
            if (conn?.res && !conn.res.headersSent) sendProblem(conn.res, 429, "TUNNEL_RATE_LIMITED", "control capacity reached");
            else conn?.res?.destroy();
            conn?.socket?.destroy();
            if (conn?.openSent) enqueueControl(session, { type: "abort", c: item.frame.c });
          }
          continue;
        }
        session.controlFlushTimer = setTimeout(() => flushControl(session), 25);
        session.controlFlushTimer.unref();
        return;
      }
      session.controlQueue.shift();
      session.controlQueuedBytes -= item.bytes;
      session.ws.send(item.data, () => {
        if (session.ws.bufferedAmount <= BACKPRESSURE_LOW_WATER) flushControl(session);
      });
      if (item.frame.type === "open") {
        const conn = session.conns.get(item.frame.c);
        if (conn) {
          conn.openSent = true;
          conn.request.release();
        }
      }
    }
    if (session.controlQueue.length > 0) {
      session.controlFlushTimer = setTimeout(() => flushControl(session), 25);
      session.controlFlushTimer.unref();
    }
  }
}

function sendProblem(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (res.destroyed || res.writableEnded) return;
  const body = relayProblemBody(code, message);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function safePathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://relay.invalid").pathname;
  } catch {
    return "/";
  }
}

function hostOf(req: IncomingMessage): string {
  return String(req.headers.host ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data as ArrayBuffer);
}
