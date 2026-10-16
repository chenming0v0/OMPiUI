/**
 * 自建中转的桌面端隧道客户端（反向隧道）。
 *
 * 作为 WebSocket 客户端拨号到用户自己的中转服务（wss://relay/_tunnel），
 * 把中转转来的公网 HTTP 请求重放到 127.0.0.1:localPort 的本机 OMPiUI
 * server，再把响应字节流回中转。WS upgrade（事件流/终端流）走
 * http.request 的 upgrade 事件，101 之后双向字节拼接。
 *
 * 协议常量与帧编解码直接复用 @ompiui/relay——两侧单一来源，ready.v 握手
 * 兜底版本漂移。断线按 Pebrel 同款指数退避重连（500ms×2ⁿ 上限 15s+抖动）。
 */

import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { WebSocket } from "ws";
import type { TunnelStatus } from "@ompiui/protocol";
import { TUNNEL_FORWARDING_HEADER } from "../host/security.ts";
import {
  CLOSE_DUPLICATE,
  CLOSE_RATE_LIMITED,
  CLOSE_UNAUTHORIZED,
  CONTROL_PATH,
  CONTROL_MESSAGE_MAX,
  CONNECTIONS_PER_TUNNEL_MAX,
  FRAME_PAYLOAD_MAX,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  WIRE_VERSION,
  BodySink,
  createPongSender,
  ResponseSink,
  RESPONSE_BUFFER_MAX,
  DataRateLimit,
  decodeFrameMessage,
  stripHopByHopHeaders,
  type ControlFrame,
} from "@ompiui/relay";

export interface TunnelClientOptions {
  /** 中转控制入口，如 wss://relay.example.com（结尾斜杠会被去掉）。 */
  relayUrl: string;
  /** 中转接入密钥（omp-relay init 生成）。 */
  key: string;
  /** 隧道 ID，需与中转配置一致；默认 ompiui。 */
  tunnelId?: string;
  /** 本机 OMPiUI server 端口（127.0.0.1 上的 loopback）。 */
  localPort: number;
  localHost?: string;
  /** Per-start secret for the local HTTP hop only; never sent to the relay. */
  tunnelForwardingToken?: string;
  onStatus?: (status: TunnelStatus) => void;
}

interface TunnelConn {
  kind: "request" | "upgrade";
  req?: ClientRequest;
  socket?: Duplex;
  sink?: BodySink;
  input?: ResponseSink;
  preUpgrade: Buffer[];
  preUpgradeBytes: number;
  upload: DataRateLimit;
}

function toBuffer(data: unknown): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (Buffer.isBuffer(data)) return data as Buffer;
  return Buffer.from(data as ArrayBuffer);
}

export class TunnelClient {
  private readonly relayUrl: string;
  private readonly key: string;
  private readonly tunnelId: string;
  private readonly localPort: number;
  private readonly localHost: string;
  private readonly tunnelForwardingToken: string | undefined;
  private readonly onStatus: (status: TunnelStatus) => void;

  private ws: WebSocket | null = null;
  private stopped = false;
  private state: TunnelStatus["state"] = "connecting";
  private publicUrl: string | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private alive = true;
  private readonly conns = new Map<number, TunnelConn>();
  private controlRate = new DataRateLimit(1024 * 1024, 2 * 1024 * 1024);
  private cleanupControlRate = new DataRateLimit(64 * 1024, 128 * 1024);
  private openRate = new DataRateLimit(1024 * 1024, 2 * 1024 * 1024, 100, 200);
  private readonly download = new DataRateLimit();

  constructor(options: TunnelClientOptions) {
    this.relayUrl = options.relayUrl.trim().replace(/\/+$/, "");
    this.key = options.key;
    this.tunnelId = options.tunnelId?.trim() || "ompiui";
    this.localPort = options.localPort;
    this.localHost = options.localHost ?? "127.0.0.1";
    this.tunnelForwardingToken = options.tunnelForwardingToken;
    this.onStatus = options.onStatus ?? (() => undefined);
  }

  /** 拨号并保持连接；返回自身便于调用方持有。 */
  start(): this {
    this.stopped = false;
    this.connect();
    return this;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    this.disposeConns();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 连接已死时 close 会抛，terminate 兜底
        this.ws.terminate();
      }
      this.ws = null;
    }
    this.setStatus("disabled", null);
  }

  getStatus(): TunnelStatus {
    return {
      enabled: true,
      state: this.state,
      relayUrl: this.relayUrl,
      tunnelId: this.tunnelId,
      publicUrl: this.publicUrl,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  // ---------- 连接生命周期 ----------

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting", null);
    this.alive = true;
    const ws = new WebSocket(`${this.relayUrl}${CONTROL_PATH}`, {
      headers: {
        authorization: `Bearer ${this.key}`,
        "x-ompiui-tunnel": this.tunnelId,
      },
      handshakeTimeout: 10_000,
      maxPayload: Math.max(CONTROL_MESSAGE_MAX, FRAME_PAYLOAD_MAX + 4),
      autoPong: false,
    });
    this.ws = ws;
    ws.on("pong", () => {
      this.alive = true;
    });
    const sendPong = createPongSender(ws);
    ws.on("ping", data => {
      const bytes = data.length + 14;
      if (!this.controlRate.canAllow(bytes, 1)) {
        ws.terminate();
        return;
      }
      this.controlRate.allow(bytes, 1);
      sendPong(data);
    });
    ws.on("message", (data, isBinary) => {
      try {
        this.handleMessage(data, isBinary);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        ws.terminate();
      }
    });
    ws.on("error", (error) => {
      this.lastError = error.message;
      // close 事件随后触发，统一走重连路径
    });
    ws.on("close", (code) => {
      this.clearHeartbeat();
      this.disposeConns();
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.scheduleReconnect(describeCloseCode(code));
    });
  }

  private scheduleReconnect(reason: string | null): void {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    // Generic closes (notably 1006 after a failed HTTP/WS handshake) carry no
    // diagnosis. Keep the useful error until a new cause or a successful ready.
    if (reason) this.lastError = reason;
    this.setStatus("reconnecting", null);
    const delay =
      Math.min(
        RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 10),
        RECONNECT_MAX_MS,
      ) + Math.floor(Math.random() * 500);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!this.alive) {
        // 上一周期无 pong：链路已死，触发 close → 重连
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private disposeConns(): void {
    for (const conn of this.conns.values()) {
      try {
        conn.req?.destroy();
        conn.socket?.destroy();
        conn.sink?.dispose();
        conn.input?.dispose();
      } catch {
        // 已销毁的对象忽略
      }
    }
    this.conns.clear();
  }

  private setStatus(
    state: TunnelStatus["state"],
    publicUrl: string | null,
  ): void {
    this.state = state;
    if (publicUrl !== null) this.publicUrl = publicUrl;
    this.onStatus(this.getStatus());
  }

  // ---------- 线协议 ----------

  private handleMessage(data: unknown, isBinary: boolean): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const raw = toBuffer(data);
    if (isBinary) {
      if (raw.length > FRAME_PAYLOAD_MAX + 4) {
        ws.terminate();
        return;
      }
      const frame = decodeFrameMessage(raw);
      if (!frame) {
        ws.terminate();
        return;
      }
      const conn = this.conns.get(frame.connId);
      if (!conn) return;
      if (!conn.upload.allow(raw.length + 14)) {
        this.abortInput(frame.connId);
        return;
      }
      if (conn.kind === "upgrade" && !conn.socket) {
        if (
          conn.preUpgradeBytes + frame.payload.length > RESPONSE_BUFFER_MAX ||
          conn.preUpgrade.length >= 1024
        ) {
          this.abortInput(frame.connId);
          return;
        }
        conn.preUpgrade.push(Buffer.from(frame.payload));
        conn.preUpgradeBytes += frame.payload.length;
      } else conn.input?.write(frame.payload);
      return;
    }
    if (raw.length > CONTROL_MESSAGE_MAX) {
      ws.terminate();
      return;
    }
    const frame = JSON.parse(raw.toString("utf8")) as ControlFrame;
    const controlRate = frame.type === "abort" || frame.type === "close" ? this.cleanupControlRate : this.controlRate;
    if (!controlRate.allow(raw.length + 14)) { ws.terminate(); return }
    switch (frame.type) {
      case "ready": {
        if (frame.v !== WIRE_VERSION) {
          this.lastError = `relay protocol version ${frame.v} ≠ ${WIRE_VERSION}; upgrade @ompiui/relay or the relay deployment`;
          ws.terminate();
          return;
        }
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.startHeartbeat(ws);
        this.setStatus("connected", frame.publicUrl);
        return;
      }
      case "open":
        this.forwardRequest(frame);
        return;
      case "reqEnd":
        this.conns.get(frame.c)?.input?.end();
        return;
      case "abort":
      case "close": {
        const conn = this.conns.get(frame.c);
        if (!conn) return;
        this.conns.delete(frame.c);
        conn.req?.destroy();
        conn.socket?.destroy();
        conn.sink?.dispose();
        conn.input?.dispose();
        return;
      }
      default:
        // head/end/fail 只从中转的下行方向出现，客户端收到一律忽略
        return;
    }
  }

  private abortInput(id: number): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    conn.input?.dispose();
    conn.sink?.dispose();
    conn.preUpgrade = [];
    conn.preUpgradeBytes = 0;
    conn.req?.destroy();
    conn.socket?.destroy();
    this.sendControl({
      type: "fail",
      c: id,
      e: "local request buffer or rate limit exceeded",
    });
  }

  private forwardRequest(frame: Extract<ControlFrame, { type: "open" }>): void {
    if (this.conns.has(frame.c)) return;
    const ws = this.ws;
    if (!ws) return;
    if (this.conns.size >= CONNECTIONS_PER_TUNNEL_MAX || !this.openRate.allow(1)) {
      this.sendControl({ type: "fail", c: frame.c, e: "local request capacity reached" });
      return;
    }
    const headers = { ...frame.h };
    // Public clients can supply any spelling of this header. Never replay it,
    // even when this TunnelClient has no internal forwarding credentials.
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === TUNNEL_FORWARDING_HEADER) delete headers[name];
    }
    if (this.tunnelForwardingToken)
      headers[TUNNEL_FORWARDING_HEADER] = this.tunnelForwardingToken;
    const isUpgrade =
      typeof headers.upgrade === "string" && headers.upgrade.length > 0;
    const conn: TunnelConn = {
      kind: isUpgrade ? "upgrade" : "request",
      preUpgrade: [],
      preUpgradeBytes: 0,
      upload: new DataRateLimit(4 * 1024 * 1024, 8 * 1024 * 1024),
    };
    const sink = new BodySink(ws, (bytes, frames) =>
      this.download.allow(bytes, frames) || this.download.delayMs(bytes, frames),
    );
    conn.sink = sink;
    this.conns.set(frame.c, conn);

    const isCurrent = () => this.conns.get(frame.c) === conn;
    const abort = () => {
      if (isCurrent()) this.abortInput(frame.c);
    };
    const finish = () => {
      if (!isCurrent()) return;
      this.conns.delete(frame.c);
      sink.dispose();
      conn.input?.dispose();
      conn.preUpgrade = [];
      conn.preUpgradeBytes = 0;
    };
    let responseEnded = false;
    const req = httpRequest(
      {
        host: this.localHost,
        port: this.localPort,
        method: frame.m,
        path: frame.u,
        headers,
      },
      (res) => {
        if (!isCurrent()) {
          res.destroy();
          return;
        }
        // 升级请求被上游以普通响应拒绝时走这里，按常规响应回传
        this.sendControl({
          type: "head",
          c: frame.c,
          s: res.statusCode ?? 502,
          h: stripHopByHopHeaders(res.headers),
        });
        res.on("data", (chunk: Buffer) => sink.write(frame.c, chunk, res));
        res.on("end", () => {
          if (!isCurrent()) return;
          responseEnded = true;
          // 完整响应已收到，上传方向正常关闭不能销毁待排空的响应尾部。
          conn.input?.dispose();
          req.setTimeout(0);
          this.sendControl({ type: "end", c: frame.c }, finish);
        });
        res.on("error", () => {
          if (!isCurrent()) return;
          this.sendControl({
            type: "fail",
            c: frame.c,
            e: "local response aborted",
          });
          finish();
        });
      },
    );
    conn.req = req;
    req.setTimeout(120_000, abort);
    if (!isUpgrade)
      conn.input = new ResponseSink(
        req,
        abort,
        () => {},
      );
    req.on("upgrade", (res: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!isCurrent()) {
        socket.destroy();
        return;
      }
      (socket as Socket).setTimeout(120_000, abort);
      conn.socket = socket;
      conn.input = new ResponseSink(
        socket,
        abort,
        () => {},
      );
      this.sendControl({
        type: "head",
        c: frame.c,
        s: res.statusCode ?? 101,
        h: stripHopByHopHeaders(res.headers, true),
      });
      for (const data of conn.preUpgrade) conn.input.write(data);
      conn.preUpgrade = [];
      conn.preUpgradeBytes = 0;
      if (head.length > 0) sink.write(frame.c, head, null);
      socket.on("data", (chunk: Buffer) => sink.write(frame.c, chunk, socket));
      let ended = false;
      socket.on("end", () => {
        if (!isCurrent() || ended) return;
        ended = true;
        // 正常可读 EOF 后，输入端的 close 监听器不能丢弃
        // 仍在等待共享数据额度的响应字节。
        conn.input?.dispose();
        this.sendControl({ type: "end", c: frame.c }, () => {
          finish();
          socket.destroy();
        });
      });
      socket.on("close", () => {
        if (!ended) abort();
      });
      socket.on("error", abort);
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (!isCurrent() || responseEnded) return;
      this.sendControl({
        type: "fail",
        c: frame.c,
        e: error.code ?? error.message,
      });
      finish();
    });
    // WebSocket 握手没有请求体：请求头必须立即冲刷，本地 server 才会回 101
    if (isUpgrade) req.end();
  }

  private sendControl(frame: ControlFrame, after?: () => void): void {
    const send = () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify(frame));
      after?.();
    };
    const sink =
      frame.type === "end"
        ? this.conns.get(frame.c)?.sink
        : undefined;
    if (sink && "c" in frame) sink.finish(frame.c, send);
    else send();
  }
}

function describeCloseCode(code: number): string | null {
  switch (code) {
    case CLOSE_UNAUTHORIZED:
      return "relay rejected the tunnel key (unauthorized) — check OMPIUI_TUNNEL_KEY against relay.config.json";
    case CLOSE_DUPLICATE:
      return "another client already holds this tunnel id on the relay";
    case CLOSE_RATE_LIMITED:
      return "relay rate limit exceeded";
    default:
      return null;
  }
}
