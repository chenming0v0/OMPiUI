import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  EVENT_WS_SUBPROTOCOL,
  eventStreamKey,
  splitUtf8Text,
  PROTOCOL_VERSION,
  type EventClientMessage,
  type EventServerMessage,
  type EventStreamRef,
  TERMINAL_STREAM_PROTOCOL_VERSION,
  isJsonObject,
  type TerminalStreamClientFrame,
  type TerminalStreamServerFrame,
} from "@ompiui/protocol";
import type { EventHub } from "./event-hub.ts";
import { eventWireFrame } from "./event-hub.ts";
import {
  requestHasAllowedOrigin,
  requestHasValidToken,
  timingSafeTokenEquals,
  type AllowedOrigins,
} from "./host/security.ts";
import { resolveAuthToken } from "./host/auth-token.ts";
import type { TerminalManager } from "./host/terminal-manager.ts";
import { diagnostics, diagnosticErrorCode } from "./diagnostics/recorder.ts";
import { recordBrowserDiagnostic } from "./diagnostics/browser.ts";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
// Client frames are tiny (ping/subscribe); cap to avoid buffering huge frames.
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_OUTBOUND_MESSAGE_BYTES = 4 * 1024 * 1024;
const allSockets = new Set<WebSocket>();
const extraQueuedBytes = new WeakMap<WebSocket, number>();
const TOTAL_OUTBOUND_BYTES = 64 * 1024 * 1024;
const MAX_TERMINAL_BUFFERED_BYTES = 8 * 1024 * 1024;
const TERMINAL_OUTPUT_CHUNK_BYTES = 32 * 1024;
const TERMINAL_PATH = /^\/api\/v1\/host\/terminals\/([^/]+)\/stream$/;

export interface EventWebSocketOptions {
  eventHub: EventHub;
  authToken?: string | null;
  /**
   * 额外放行的 Origin（公网入口的 origin，可传 getter）：反向代理/自建中转
   * 隧道把 Host 重写成上游地址时，浏览器页面的 Origin 与 Host 不相等，
   * 同源分支放不了行。隧道是动态上线的，必须支持运行时取值。
   */
  allowedOrigins?: AllowedOrigins;
  /** Called after a client (re)subscribes — push per-connection snapshots */
  onSubscribe?: (send: (message: EventServerMessage) => void) => void;
  terminalManager?: TerminalManager;
  maxConnections?: number;
}

export function attachEventWebSocket(
  server: HttpServer,
  options: EventWebSocketOptions,
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    // 只协商本服务声明的子协议;未声明子协议的客户端照常握手(不带协议头)
    handleProtocols: (protocols) =>
      protocols.has(EVENT_WS_SUBPROTOCOL) ? EVENT_WS_SUBPROTOCOL : false,
  });
  const eventHub = options.eventHub;
  const authToken =
    options.authToken === undefined ? resolveAuthToken() : options.authToken;
  const terminalConnections = new WeakMap<
    IncomingMessage,
    { terminalId: string; workspacePath: string }
  >();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      socket.write(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    const wsToken = url.searchParams.get("token");
    const hasToken =
      requestHasValidToken(req, authToken) ||
      (authToken !== null &&
        wsToken !== null &&
        timingSafeTokenEquals(wsToken, authToken));
    const terminalMatch = TERMINAL_PATH.exec(url.pathname);
    const isEventPath = url.pathname === "/api/v1/events";
    if (
      (!isEventPath && !terminalMatch) ||
      !requestHasAllowedOrigin(req, options.allowedOrigins) ||
      !hasToken
    ) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    const offered = req.headers["sec-websocket-protocol"];
    if (wss.clients.size >= (options.maxConnections ?? 128)) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    if (
      isEventPath &&
      offered !== undefined &&
      !String(offered)
        .split(",")
        .some((name) => name.trim() === EVENT_WS_SUBPROTOCOL)
    ) {
      // 客户端声明了其它子协议:明确拒绝,而不是 ws 默认的回显行为
      socket.write(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    if (terminalMatch) {
      if (!options.terminalManager) {
        socket.write(
          "HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      const terminalId = decodePathSegment(terminalMatch[1]!);
      const ticket = url.searchParams.get("ticket");
      const workspacePath = ticket
        ? options.terminalManager.consumeConnectToken(terminalId, ticket)
        : undefined;
      if (!workspacePath) {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      terminalConnections.set(req, { terminalId, workspacePath });
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    allSockets.add(ws);
    ws.on("close", () => {
      allSockets.delete(ws);
      extraQueuedBytes.delete(ws);
    });
    // Without an error listener, ws emits 'error' synchronously on receiver
    // errors (oversized frames, bad UTF-8, invalid opcodes) and Node throws,
    // crashing the whole process. Swallow per-socket errors; close handles the rest.
    ws.on("error", () => undefined);
    const terminal = terminalConnections.get(req);
    if (terminal && options.terminalManager) {
      attachTerminalConnection(
        ws,
        options.terminalManager,
        terminal.terminalId,
        terminal.workspacePath,
        req,
      );
      return;
    }
    attachConnection(ws, eventHub, options.onSubscribe);
  });

  return wss;
}

export function closeEventWebSocket(
  wss: WebSocketServer,
  callback?: (error?: Error) => void,
): void {
  for (const client of wss.clients) client.terminate();
  wss.close(callback);
}

function attachConnection(
  ws: WebSocket,
  eventHub: EventHub,
  onSubscribe?: (send: (message: EventServerMessage) => void) => void,
): void {
  const subscribed = new Set<string>();
  const connectionId = randomUUID();
  const started = performance.now();
  let clientId: string | undefined;
  let sessionIds: string[] = [];
  let diagnosticWindow = Date.now();
  let diagnosticCount = 0;
  diagnostics.record("connection.opened", { connectionId });
  ws.on("error", (error) =>
    diagnostics.record(
      "connection.error",
      {
        connectionId,
        clientId,
        sessionIds,
        errorCode: diagnosticErrorCode(error),
      },
      "warn",
    ),
  );
  send(ws, {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    service: "ompiui-server",
    subprotocol: EVENT_WS_SUBPROTOCOL,
  });

  const unsubscribe = eventHub.subscribe((event) => {
    if (
      event.stream.kind === "server" &&
      event.channel === "omp.subagent" &&
      isJsonObject(event.payload) &&
      typeof event.payload.sessionId === "string" &&
      subscribed.has(
        eventStreamKey({ kind: "session", id: event.payload.sessionId }),
      )
    )
      return;
    if (subscribed.has(eventStreamKey(event.stream)))
      send(ws, { channel: "event", event });
  });

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw)) as EventClientMessage;
      if (message.type === "diagnostic") {
        if (message.protocolVersion !== PROTOCOL_VERSION) return;
        if (Date.now() - diagnosticWindow >= 60_000) {
          diagnosticWindow = Date.now();
          diagnosticCount = 0;
        }
        // 客户端记录只供诊断，不进入业务事件流，并限制写盘频率。
        if (++diagnosticCount <= 120) {
          clientId =
            recordBrowserDiagnostic(message, connectionId, sessionIds) ??
            clientId;
        }
        return;
      }
      if (message.type === "ping") {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          rejectProtocol(ws);
          return;
        }
        send(ws, {
          type: "pong",
          protocolVersion: PROTOCOL_VERSION,
          t: Date.now(),
        });
        return;
      }
      if (message.type !== "subscribe") return;
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        rejectProtocol(ws);
        return;
      }
      if (!Array.isArray(message.streams) || message.streams.length > 256)
        return;

      const previous = new Set(subscribed);
      subscribed.clear();
      const resync: Extract<
        EventServerMessage,
        { type: "resync_required" }
      >["streams"] = {};
      const seenStreams = new Set<string>();
      for (const stream of message.streams) {
        if (!stream.id || !isEventStreamKind(stream.kind)) continue;
        const key = eventStreamKey(stream);
        if (seenStreams.has(key)) continue;
        seenStreams.add(key);
        subscribed.add(key);
        if (previous.has(key)) continue;
        const cursor = message.cursors?.[key as keyof typeof message.cursors];
        const replay = eventHub.replaySince(stream, cursor);
        if (replay.resyncRequired) {
          resync[key] = {
            cursor: eventHub.getCursor(stream),
            reason: replay.reason ?? "missing_cursor",
          };
          continue;
        }
        for (const event of replay.events)
          send(ws, { channel: "event", event });
      }
      if (Object.keys(resync).length > 0) {
        send(ws, {
          channel: "control",
          type: "resync_required",
          streams: resync,
        });
      }
      sessionIds = message.streams
        .filter(
          (stream) =>
            stream.kind === "session" && typeof stream.id === "string",
        )
        .map((stream) => stream.id);
      diagnostics.record("connection.subscribed", {
        connectionId,
        clientId,
        sessionIds,
        count: subscribed.size,
      });
      for (const [key, value] of Object.entries(resync)) {
        const stream = message.streams.find(
          (stream) => eventStreamKey(stream) === key,
        );
        diagnostics.record("connection.resync", {
          connectionId,
          clientId,
          sessionId: stream?.kind === "session" ? stream.id : undefined,
          reason: value?.reason,
          sequence: value?.cursor.sequence,
          epoch: value?.cursor.epoch,
        });
      }
      if (previous.size === 0) onSubscribe?.((message) => send(ws, message));
    } catch {
      /* ignore malformed client messages */
    }
  });
  ws.on("close", (code: number) => {
    unsubscribe();
    diagnostics.record(
      "connection.closed",
      {
        connectionId,
        clientId,
        sessionIds,
        code,
        durationMs: Math.round(performance.now() - started),
        reason: code === 1006 ? "abnormal_disconnect" : "socket_closed",
      },
      code === 1006 ? "warn" : "info",
    );
  });
}

function isEventStreamKind(value: string): value is EventStreamRef["kind"] {
  return (
    value === "server" ||
    value === "workspace" ||
    value === "session" ||
    value === "provider" ||
    value === "resources"
  );
}

function send(ws: WebSocket, message: EventServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  let wire = "event" in message ? eventWireFrame(message.event) : undefined;
  let data = wire?.data ?? JSON.stringify(message);
  let bytes = wire?.bytes ?? Buffer.byteLength(data);
  if ("event" in message && bytes > MAX_OUTBOUND_MESSAGE_BYTES) {
    // 正文由只读分页恢复；不伪造 history_expired，也不消费未交付正文的游标。
    const event = message.event;
    const payload = isJsonObject(event.payload) ? event.payload : {};
    data = JSON.stringify({
      channel: "event",
      event: {
        ...event,
        channel: "pi.event",
        payload: {
          event: { type: "entry_appended", truncated: true },
          meta: payload.meta,
        },
      },
    });
    bytes = Buffer.byteLength(data);
  }
  if (!canQueue(ws, bytes, MAX_BUFFERED_BYTES)) {
    ws.close(1013, "event client too slow");
    const timer = setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }, 1000);
    timer.unref();
    return;
  }
  ws.send(data);
}

function canQueue(ws: WebSocket, bytes: number, limit: number): boolean {
  if (ws.bufferedAmount + (extraQueuedBytes.get(ws) ?? 0) + bytes > limit)
    return false;
  let total = bytes;
  for (const socket of allSockets)
    total += socket.bufferedAmount + (extraQueuedBytes.get(socket) ?? 0);
  return total <= TOTAL_OUTBOUND_BYTES;
}

function attachTerminalConnection(
  ws: WebSocket,
  manager: TerminalManager,
  terminalId: string,
  workspacePath: string,
  req: IncomingMessage,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue === null ? undefined : Number(cursorValue);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < -1)) {
    sendTerminalProblem(
      ws,
      "INVALID_REQUEST",
      "terminal cursor must be an integer >= -1",
    );
    ws.close(1008, "invalid cursor");
    return;
  }

  let closed = false;
  let writing = false;
  let queuedBytes = 0;
  const queue: string[] = [];
  let closeAfterFlush: { code: number; reason: string } | undefined;
  let detach = () => {};
  let outputParts: string[] = [];
  let outputBytes = 0;
  let outputTimer: NodeJS.Timeout | undefined;
  const close = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    extraQueuedBytes.delete(ws);
    clearTimeout(outputTimer);
    outputParts = [];
    outputBytes = 0;
    closeAfterFlush = undefined;
    detach();
    ws.close(code, reason);
    if (code === 1013) {
      const timer = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }, 1000);
      timer.unref();
    }
  };
  const closeWhenDrained = (code: number, reason: string) => {
    if (closed) return;
    closeAfterFlush = { code, reason };
    pump();
  };
  const pump = () => {
    if (closed || writing) return;
    const next = queue.shift();
    if (!next) {
      queuedBytes = 0;
      if (closeAfterFlush) {
        const pending = closeAfterFlush;
        closeAfterFlush = undefined;
        close(pending.code, pending.reason);
      }
      return;
    }
    queuedBytes -= Buffer.byteLength(next);
    extraQueuedBytes.set(ws, queuedBytes + outputBytes);
    writing = true;
    ws.send(next, (error) => {
      writing = false;
      if (error) {
        close(1011, "terminal stream failed");
        return;
      }
      pump();
    });
  };
  const sendFrame = (frame: TerminalStreamServerFrame) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(frame);
    if (!canQueue(ws, Buffer.byteLength(data), MAX_TERMINAL_BUFFERED_BYTES)) {
      close(1013, "terminal client too slow");
      return;
    }
    queuedBytes += Buffer.byteLength(data);
    if (queuedBytes > MAX_TERMINAL_BUFFERED_BYTES) {
      close(1013, "terminal client too slow");
      return;
    }
    queue.push(data);
    extraQueuedBytes.set(ws, queuedBytes + outputBytes);
    pump();
  };
  const flushOutput = () => {
    clearTimeout(outputTimer);
    outputTimer = undefined;
    const data = outputParts.join("");
    outputParts = [];
    outputBytes = 0;
    extraQueuedBytes.set(ws, queuedBytes);
    for (const chunk of splitTerminalOutput(data)) {
      outputCursor += chunk.length;
      sendFrame({ type: "output", cursor: outputCursor, data: chunk });
    }
  };

  let attachment: ReturnType<TerminalManager["attach"]>;
  try {
    attachment = manager.attach(
      workspacePath,
      terminalId,
      cursor,
      (data) => {
        if (
          !canQueue(ws, Buffer.byteLength(data), MAX_TERMINAL_BUFFERED_BYTES)
        ) {
          close(1013, "terminal client too slow");
          return;
        }
        outputParts.push(data);
        outputBytes += Buffer.byteLength(data);
        extraQueuedBytes.set(ws, queuedBytes + outputBytes);
        if (outputBytes >= 32 * 1024) flushOutput();
        else outputTimer ??= setTimeout(flushOutput, 16);
      },
      (event) => {
        flushOutput();
        sendFrame({
          type: "exit",
          cursor: outputCursor,
          exitCode: event.exitCode,
        });
        closeWhenDrained(1001, "terminal exited");
      },
      (title) => {
        flushOutput();
        sendFrame({ type: "title", title });
      },
    );
  } catch (error) {
    const code = errorCode(error);
    sendTerminalProblem(
      ws,
      code,
      error instanceof Error ? error.message : String(error),
    );
    close(code === "TERMINAL_CURSOR_EXPIRED" ? 1008 : 1000, code);
    return;
  }

  let outputCursor = attachment.replayCursor;
  detach = attachment.detach;
  let terminal;
  try {
    terminal = manager.get(workspacePath, terminalId);
  } catch (error) {
    attachment.detach();
    sendTerminalProblem(
      ws,
      errorCode(error),
      error instanceof Error ? error.message : String(error),
    );
    close(1000, "terminal not found");
    return;
  }
  sendFrame({
    type: "hello",
    protocolVersion: TERMINAL_STREAM_PROTOCOL_VERSION,
    terminal,
    cursor: attachment.cursor,
  });
  for (const chunk of splitTerminalOutput(attachment.replay)) {
    outputCursor += chunk.length;
    sendFrame({ type: "output", cursor: outputCursor, data: chunk });
  }
  sendFrame({ type: "ready", cursor: attachment.cursor });
  try {
    if (!closed) attachment.activate();
  } catch (error) {
    attachment.detach();
    sendTerminalProblem(
      ws,
      errorCode(error),
      error instanceof Error ? error.message : String(error),
    );
    close(1008, "terminal cursor expired");
  }

  ws.on("message", (raw) => {
    if (closed) return;
    let frame: TerminalStreamClientFrame;
    try {
      frame = JSON.parse(String(raw)) as TerminalStreamClientFrame;
    } catch {
      sendTerminalProblem(
        ws,
        "INVALID_REQUEST",
        "invalid terminal stream frame",
      );
      return;
    }
    try {
      if (frame.type === "input" && typeof frame.data === "string") {
        manager.write(workspacePath, terminalId, frame.data);
      } else if (
        frame.type === "resize" &&
        Number.isSafeInteger(frame.rows) &&
        frame.rows >= 1 &&
        frame.rows <= 500 &&
        Number.isSafeInteger(frame.cols) &&
        frame.cols >= 1 &&
        frame.cols <= 500
      ) {
        manager.update(workspacePath, terminalId, {
          rows: frame.rows,
          cols: frame.cols,
        });
      } else if (
        frame.type === "ping" &&
        frame.protocolVersion === TERMINAL_STREAM_PROTOCOL_VERSION
      ) {
        sendFrame({
          type: "pong",
          protocolVersion: TERMINAL_STREAM_PROTOCOL_VERSION,
          t: Date.now(),
        });
      } else {
        sendTerminalProblem(
          ws,
          "INVALID_REQUEST",
          "invalid terminal stream frame",
        );
      }
    } catch (error) {
      sendTerminalProblem(
        ws,
        errorCode(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  });
  ws.on("close", () => {
    closed = true;
    clearTimeout(outputTimer);
    outputParts = [];
    outputBytes = 0;
    extraQueuedBytes.delete(ws);
    queue.length = 0;
    queuedBytes = 0;
    attachment.detach();
  });
}

function splitTerminalOutput(data: string): string[] {
  // JSON 控制字符最多膨胀六倍，保守限制线上帧而不改变现有协议。
  return splitUtf8Text(data, Math.floor(TERMINAL_OUTPUT_CHUNK_BYTES / 6));
}

function sendTerminalProblem(
  ws: WebSocket,
  code: string,
  message: string,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "problem", problem: { code, message } }));
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "INTERNAL";
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rejectProtocol(ws: WebSocket): void {
  send(ws, {
    channel: "control",
    type: "problem",
    problem: {
      code: "PROTOCOL_VERSION_MISMATCH",
      message: "event protocol version mismatch",
    },
  });
  ws.close(1002, "protocol version mismatch");
}
