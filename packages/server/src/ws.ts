import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  EVENT_WS_SUBPROTOCOL,
  eventStreamKey,
  PROTOCOL_VERSION,
  type EventClientMessage,
  type EventServerMessage,
  type EventStreamRef,
  TERMINAL_STREAM_PROTOCOL_VERSION,
  isJsonObject,
  isErrorCode,
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
import { RateBudget } from "./rate-budget.ts";
import { splitTerminalOutput } from "./terminal-output.ts";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
// Client frames are tiny (ping/subscribe); cap to avoid buffering huge frames.
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_OUTBOUND_MESSAGE_BYTES = 4 * 1024 * 1024;
const allSockets = new Set<WebSocket>();
const extraQueuedBytes = new WeakMap<WebSocket, number>();
const TOTAL_OUTBOUND_BYTES = 64 * 1024 * 1024;
const MAX_TERMINAL_BUFFERED_BYTES = 8 * 1024 * 1024;
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
      const timer = setTimeout(() => socket.destroy(), 1000);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        () => socket.destroy(),
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
  const subscribeBudget = new RateBudget(12, 4);
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
    if (ws.readyState !== WebSocket.OPEN) return;
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
      if (!subscribeBudget.allow(1)) {
        ws.close(1008, "subscription rate limit exceeded");
        const timer = setTimeout(() => ws.terminate(), 1000);
        timer.unref();
        return;
      }

      const previous = new Set(subscribed);
      subscribed.clear();
      const resync: Extract<
        EventServerMessage,
        { type: "resync_required" }
      >["streams"] = {};
      const seenStreams = new Map<string, EventStreamRef>();
      for (const stream of message.streams) {
        if (
          !stream || typeof stream.id !== "string" || !stream.id ||
          Buffer.byteLength(stream.id) > 1024 || !isEventStreamKind(stream.kind)
        ) continue;
        const key = eventStreamKey(stream);
        if (seenStreams.has(key)) continue;
        seenStreams.set(key, stream);
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
      sessionIds = [...seenStreams.values()]
        .filter((stream) => stream.kind === "session")
        .map((stream) => stream.id);
      diagnostics.record("connection.subscribed", {
        connectionId,
        clientId,
        sessionIds,
        count: subscribed.size,
      });
      const resyncEntries = Object.entries(resync);
      if (resyncEntries.length) {
        const [key, value] = resyncEntries[0]!;
        const stream = seenStreams.get(key);
        diagnostics.record("connection.resync", {
          connectionId,
          clientId,
          sessionId: stream?.kind === "session" ? stream.id : undefined,
          reason: value?.reason,
          sequence: value?.cursor.sequence,
          epoch: value?.cursor.epoch,
          count: resyncEntries.length,
          sessionIds: resyncEntries
            .map(([key]) => seenStreams.get(key))
            .filter((stream) => stream?.kind === "session")
            .map((stream) => stream!.id),
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
  const wire = "event" in message ? eventWireFrame(message.event) : undefined;
  let data = wire?.data ?? JSON.stringify(message);
  let bytes = wire?.bytes ?? Buffer.byteLength(data);
  if ("event" in message && bytes > MAX_OUTBOUND_MESSAGE_BYTES) {
    // 用独立控制帧恢复原通道，不将未交付事件伪装成另一种业务事件。
    const event = message.event;
    const payload = isJsonObject(event.payload) ? event.payload : {};
    data = JSON.stringify({
      channel: "control",
      type: "payload_omitted",
      stream: event.stream,
      cursor: event.cursor,
      eventId: event.eventId,
      eventChannel: event.channel,
      commandId: event.channel === "command.updated" && typeof payload.id === "string" ? payload.id : undefined,
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
  // ws.bufferedAmount 在连续 send() 的同一事件循环里可能尚未反映新帧，
  // 重连补发历史时会因此把大量事件瞬间压进底层发送队列。用额外计数覆盖
  // 这段窗口，并在 ws 库确认交付后释放，避免“长时间无更新后突然成批到达”。
  extraQueuedBytes.set(ws, (extraQueuedBytes.get(ws) ?? 0) + bytes);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const queued = extraQueuedBytes.get(ws) ?? 0;
    const remaining = queued - bytes;
    if (remaining > 0) extraQueuedBytes.set(ws, remaining);
    else extraQueuedBytes.delete(ws);
  };
  try {
    ws.send(data, release);
  } catch {
    release();
    throw new Error("websocket send failed");
  }
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
  const queue: Array<{ data: string; bytes: number }> = [];
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
    queuedBytes -= next.bytes;
    extraQueuedBytes.set(ws, queuedBytes + outputBytes);
    writing = true;
    ws.send(next.data, (error) => {
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
    const bytes = Buffer.byteLength(data);
    if (!canQueue(ws, bytes, MAX_TERMINAL_BUFFERED_BYTES)) {
      close(1013, "terminal client too slow");
      return;
    }
    queuedBytes += bytes;
    if (queuedBytes > MAX_TERMINAL_BUFFERED_BYTES) {
      close(1013, "terminal client too slow");
      return;
    }
    queue.push({ data, bytes });
    extraQueuedBytes.set(ws, queuedBytes + outputBytes);
    pump();
  };
  const problem = (code: string, message: string) =>
    sendFrame({ type: "problem", problem: { code: isErrorCode(code) ? code : "INTERNAL", message } });
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
      (data, bytes = Buffer.byteLength(data)) => {
        if (
          !canQueue(ws, bytes, MAX_TERMINAL_BUFFERED_BYTES)
        ) {
          close(1013, "terminal client too slow");
          return;
        }
        outputParts.push(data);
        outputBytes += bytes;
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
    problem(
      code,
      error instanceof Error ? error.message : String(error),
    );
    closeWhenDrained(code === "TERMINAL_CURSOR_EXPIRED" ? 1008 : 1000, code);
    return;
  }

  let outputCursor = attachment.replayCursor;
  detach = attachment.detach;
  let terminal;
  try {
    terminal = manager.get(workspacePath, terminalId);
  } catch (error) {
    attachment.detach();
    problem(
      errorCode(error),
      error instanceof Error ? error.message : String(error),
    );
    closeWhenDrained(1000, "terminal not found");
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
    problem(
      errorCode(error),
      error instanceof Error ? error.message : String(error),
    );
    closeWhenDrained(1008, "terminal cursor expired");
  }

  const frameBudget = new RateBudget(240, 120);
  ws.on("message", (raw) => {
    if (closed) return;
    if (!frameBudget.allow(1)) {
      close(1013, "terminal input rate limit exceeded");
      return;
    }
    let frame: TerminalStreamClientFrame;
    try {
      frame = JSON.parse(String(raw)) as TerminalStreamClientFrame;
    } catch {
      problem(
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
        problem(
          "INVALID_REQUEST",
          "invalid terminal stream frame",
        );
      }
    } catch (error) {
      const code = errorCode(error);
      problem(
        code,
        error instanceof Error ? error.message : String(error),
      );
      if (code === "RATE_LIMITED") closeWhenDrained(1013, "terminal input budget exceeded");
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

function sendTerminalProblem(
  ws: WebSocket,
  code: string,
  message: string,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify({ type: "problem", problem: { code, message } });
  if (!canQueue(ws, Buffer.byteLength(data), MAX_TERMINAL_BUFFERED_BYTES)) {
    ws.close(1013, "terminal client too slow");
    const timer = setTimeout(() => ws.terminate(), 1000);
    timer.unref();
    return;
  }
  ws.send(data);
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
