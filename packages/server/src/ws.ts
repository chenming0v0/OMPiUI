import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  EVENT_WS_SUBPROTOCOL,
  eventStreamKey,
  PROTOCOL_VERSION,
  type EventClientMessage,
  type EventCursor,
  type EventEnvelope,
  type EventServerMessage,
  type EventStreamRef,
  TERMINAL_STREAM_PROTOCOL_VERSION,
  isJsonObject,
  isErrorCode,
  type TerminalStreamClientFrame,
  type TerminalStreamServerFrame,
} from "@ompiui/protocol";
import type { EventHub } from "./event-hub.ts";
import { eventWireFrame, omittedEventWireFrame } from "./event-hub.ts";
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
import { WebSocketSendBudget, type SendAdmission } from "./ws-send-budget.ts";
import { WebSocketIngressBudget } from "./ws-ingress-budget.ts";
import { TerminalOutputFlow } from "./terminal-output-flow.ts";

// 除解析前的原始帧速率预算外，仍保留聚合载荷上限。
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_OUTBOUND_MESSAGE_BYTES = 4 * 1024 * 1024;
const sendBudget = new WebSocketSendBudget<WebSocket>();
const discardConnectionQueues = new WeakMap<WebSocket, () => void>();
const deliveryTimers = new WeakMap<WebSocket, { pending: number; timer: NodeJS.Timeout }>();
const subscribeGlobalBudget = new RateBudget(240, 120);
const ingressGlobalFrames = new RateBudget(4096, 2048);
const ingressGlobalBytes = new RateBudget(32 * 1024 * 1024, 16 * 1024 * 1024);
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
    // 浏览器业务消息使用单帧，禁止 continuation 重组绕过入站帧率预算。
    maxFragments: 1,
    autoPong: false,
    // 服务端不主动 ping：保活靠客户端每 25s 的应用层 ping，半开连接由 sendReserved 的
    // 5s 停滞看门狗在第一条事件上回收。不要按"没有心跳 ⇒ 连接永不回收"上报。
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
    sendBudget.register(ws, () => {
      discardConnectionQueues.get(ws)?.();
      closeSocket(ws, 1013, "websocket output budget exceeded");
    });
    ws.on("close", () => {
      discardConnectionQueues.get(ws)?.();
      discardConnectionQueues.delete(ws);
      sendBudget.remove(ws);
      clearTimeout(deliveryTimers.get(ws)?.timer);
      deliveryTimers.delete(ws);
    });
    const ingress = new WebSocketIngressBudget(ingressGlobalFrames, ingressGlobalBytes);
    const admit = (bytes: number) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      if (ingress.allow(bytes)) return true;
      discardConnectionQueues.get(ws)?.();
      closeSocket(ws, 1013, "websocket input rate limit exceeded");
      return false;
    };
    ws.on("ping", (data) => {
      if (!admit(data.byteLength)) return;
      const bytes = data.byteLength + 10;
      if (reserveWire(ws, bytes) === "accepted")
        sendReserved(ws, bytes, (done) => ws.pong(data, undefined, done));
    });
    ws.on("pong", (data) => { admit(data.byteLength); });
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
        admit,
      );
      return;
    }
    attachConnection(ws, eventHub, admit, options.onSubscribe);
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

interface SubscriptionState {
  stream: EventStreamRef;
  cursor?: EventCursor;
  dirty: boolean;
}

type ResyncStreams = Extract<EventServerMessage, { type: "resync_required" }>["streams"];

function attachConnection(
  ws: WebSocket,
  eventHub: EventHub,
  admit: (bytes: number) => boolean,
  onSubscribe?: (send: (message: EventServerMessage) => void) => void,
): void {
  const subscribed = new Map<string, SubscriptionState>();
  const connectionId = randomUUID();
  const started = performance.now();
  const subscribeBudget = new RateBudget(12, 4);
  const malformedBudget = new RateBudget(16, 1);
  let clientId: string | undefined;
  let sessionIds: string[] = [];
  let diagnosticWindow = Date.now();
  let diagnosticCount = 0;
  let closed = false;
  let pendingSubscription: Map<string, SubscriptionState> | undefined;
  let subscribeTimer: NodeJS.Timeout | undefined;
  let replayTask: NodeJS.Immediate | undefined;
  let pendingSends = 0;
  let helloPending = true;
  let snapshotPending = false;
  let pendingPongs = 0;
  let resync: ResyncStreams = {};

  const schedulePump = () => {
    if (closed || pendingSends || replayTask) return;
    replayTask = setImmediate(() => {
      replayTask = undefined;
      pump();
    });
  };
  const stopWaiting = sendBudget.whenAvailable(schedulePump);
  const writeFrame = (message: EventServerMessage): boolean => {
    pendingSends++;
    const admission = send(ws, message, () => {
      pendingSends--;
      schedulePump();
    });
    if (admission === "accepted") return true;
    pendingSends--;
    return false;
  };
  const suppressed = (event: EventEnvelope) =>
    event.stream.kind === "server" &&
    event.channel === "omp.subagent" &&
    isJsonObject(event.payload) &&
    typeof event.payload.sessionId === "string" &&
    subscribed.has(eventStreamKey({ kind: "session", id: event.payload.sessionId }));

  const requireResync = (key: string, state: SubscriptionState, reason: "missing_cursor" | "epoch_mismatch" | "future_cursor" | "history_expired") => {
    const cursor = eventHub.getCursor(state.stream);
    resync[key as keyof ResyncStreams] = { cursor, reason };
    state.cursor = cursor;
    state.dirty = false;
  };
  const sendResync = () => {
    const entries = Object.entries(resync);
    if (!entries.length) return true;
    if (!writeFrame({ channel: "control", type: "resync_required", streams: resync }))
      return false;
    const [key, value] = entries[0]!;
    const stream = subscribed.get(key)?.stream;
    diagnostics.record("connection.resync", {
      connectionId, clientId,
      sessionId: stream?.kind === "session" ? stream.id : undefined,
      reason: value?.reason,
      sequence: value?.cursor.sequence,
      epoch: value?.cursor.epoch,
      count: entries.length,
      sessionIds: entries.flatMap(([key]) => {
        const stream = subscribed.get(key)?.stream;
        return stream?.kind === "session" ? [stream.id] : [];
      }),
    });
    resync = {};
    return true;
  };

  // 此发送循环由 hub 支撑，不为每个 socket 复制全部历史。
  // 游标仅随已准入的帧前进；有界批次之间由回调让出执行权。
  // 回放期间的实时发布也沿同一游标路径发送。
  const pump = () => {
    if (closed || ws.readyState !== WebSocket.OPEN || pendingSends) return;
    if (helloPending) {
      if (!writeFrame({ type: "hello", protocolVersion: PROTOCOL_VERSION,
        service: "ompiui-server", subprotocol: EVENT_WS_SUBPROTOCOL })) return;
      helloPending = false;
    }
    if (!sendResync()) return;
    let batchBytes = 0;
    let batchFrames = 0;
    for (const [key, state] of [...subscribed]) {
      if (!state.dirty) continue;
      // 每批从下一条待重放流开始，热流未追平时也不能独占批次。
      subscribed.delete(key);
      subscribed.set(key, state);
      const replay = eventHub.replaySince(state.stream, state.cursor);
      if (replay.resyncRequired) {
        requireResync(key, state, replay.reason ?? "missing_cursor");
        continue;
      }
      let complete = true;
      for (const event of replay.events) {
        if (batchFrames >= 64 || batchBytes >= 256 * 1024) {
          complete = false;
          break;
        }
        if (!suppressed(event)) {
          if (!writeFrame({ channel: "event", event })) return;
          batchBytes += eventWireFrame(event).bytes;
          batchFrames++;
        }
        state.cursor = event.cursor;
      }
      state.dirty = !complete;
      if (!complete) break;
    }
    if (!sendResync()) return;
    while (pendingPongs > 0) {
      if (!writeFrame({ type: "pong", protocolVersion: PROTOCOL_VERSION, t: Date.now() }))
        return;
      pendingPongs--;
    }
    if (snapshotPending && ![...subscribed.values()].some((state) => state.dirty)) {
      snapshotPending = false;
      onSubscribe?.((message) => {
        if (!writeFrame(message)) snapshotPending = true;
      });
    }
  };

  const applyPendingSubscription = () => {
    clearTimeout(subscribeTimer);
    subscribeTimer = undefined;
    if (closed || !pendingSubscription) return;
    const delay = Math.max(subscribeBudget.retryAfterMs(1), subscribeGlobalBudget.retryAfterMs(1));
    if (delay > 0) {
      subscribeTimer = setTimeout(applyPendingSubscription, delay);
      subscribeTimer.unref();
      return;
    }
    subscribeBudget.allow(1);
    subscribeGlobalBudget.allow(1);
    const desired = pendingSubscription;
    pendingSubscription = undefined;
    const previouslyEmpty = subscribed.size === 0;
    for (const key of subscribed.keys()) {
      if (!desired.has(key)) {
        subscribed.delete(key);
        delete resync[key as keyof ResyncStreams];
      }
    }
    for (const [key, state] of desired) {
      if (!subscribed.has(key)) subscribed.set(key, state);
    }
    sessionIds = [...subscribed.values()]
      .filter(({ stream }) => stream.kind === "session")
      .map(({ stream }) => stream.id);
    diagnostics.record("connection.subscribed", {
      connectionId, clientId, sessionIds, count: subscribed.size,
    });
    if (previouslyEmpty) snapshotPending = true;
    schedulePump();
  };

  const unsubscribe = eventHub.subscribe((event) => {
    const state = subscribed.get(eventStreamKey(event.stream));
    if (closed || !state) return;
    if (suppressed(event)) {
      if (!state.dirty) state.cursor = event.cursor;
      return;
    }
    // 游标已追上时可直接发送实时事件，包括 hub 无法保留的大事件；
    // 否则只保留游标工作，不复制事件正文。
    if (!state.dirty && !helloPending && !Object.keys(resync).length &&
        (!pendingSends || eventWireFrame(event).bytes > 2 * 1024 * 1024) &&
        writeFrame({ channel: "event", event })) {
      state.cursor = event.cursor;
    }
    state.dirty = true;
    schedulePump();
  });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(subscribeTimer);
    if (replayTask) clearImmediate(replayTask);
    pendingSubscription = undefined;
    subscribed.clear();
    resync = {};
    stopWaiting();
    unsubscribe();
  };
  discardConnectionQueues.set(ws, cleanup);
  diagnostics.record("connection.opened", { connectionId });
  ws.on("error", (error) => diagnostics.record("connection.error", {
    connectionId, clientId, sessionIds, errorCode: diagnosticErrorCode(error),
  }, "warn"));
  const invalidFrame = () => {
    if (!malformedBudget.allow(1)) {
      cleanup();
      closeSocket(ws, 1008, "invalid event frames");
    }
  };
  ws.on("message", (raw) => {
    const bytes = rawBytes(raw);
    if (closed || !admit(bytes)) return;
    let message: EventClientMessage;
    try {
      message = JSON.parse(String(raw)) as EventClientMessage;
    } catch {
      invalidFrame();
      return;
    }
    if (!isJsonObject(message)) { invalidFrame(); return; }
    if (message.type === "diagnostic") {
      if (bytes > 16 * 1024 || !validDiagnosticShape(message)) {
        cleanup();
        closeSocket(ws, 1008, "invalid diagnostic frame");
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) { rejectProtocol(ws); return; }
      if (Date.now() - diagnosticWindow >= 60_000) {
        diagnosticWindow = Date.now();
        diagnosticCount = 0;
      }
      if (++diagnosticCount <= 120)
        clientId = recordBrowserDiagnostic(message, connectionId, sessionIds) ?? clientId;
      return;
    }
    if (message.type === "ping") {
      if (bytes > 256 || Object.keys(message).length !== 2) {
        cleanup();
        closeSocket(ws, 1008, "invalid ping frame");
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) { rejectProtocol(ws); return; }
      pendingPongs++;
      schedulePump();
      return;
    }
    if (message.type !== "subscribe") { invalidFrame(); return; }
    if (message.protocolVersion !== PROTOCOL_VERSION) { rejectProtocol(ws); return; }
    const desired = readSubscription(message);
    if (!desired) { invalidFrame(); return; }
    // subscribe 表示替换后的目标状态，而非可丢弃的通知；
    // 即使共享预算紧张，也要保留最新的已校验目标。
    pendingSubscription = desired;
    applyPendingSubscription();
  });
  ws.on("close", (code: number) => {
    cleanup();
    diagnostics.record("connection.closed", {
      connectionId, clientId, sessionIds, code,
      durationMs: Math.round(performance.now() - started),
      reason: code === 1006 ? "abnormal_disconnect" : "socket_closed",
    }, code === 1006 ? "warn" : "info");
  });
  pump();
}

function readSubscription(message: Extract<EventClientMessage, { type: "subscribe" }>): Map<string, SubscriptionState> | undefined {
  if (!Array.isArray(message.streams) || message.streams.length > 256) return;
  const desired = new Map<string, SubscriptionState>();
  for (const stream of message.streams) {
    if (!stream || typeof stream.id !== "string" || !stream.id ||
        Buffer.byteLength(stream.id) > 1024 || !isEventStreamKind(stream.kind)) continue;
    const ref: EventStreamRef = { kind: stream.kind, id: stream.id };
    const key = eventStreamKey(ref);
    if (desired.has(key)) continue;
    const value = message.cursors?.[key];
    const cursor = value && typeof value.epoch === "string" &&
      value.epoch.length <= 128 && Number.isSafeInteger(value.sequence) && value.sequence >= 0
      ? { epoch: value.epoch, sequence: value.sequence } : undefined;
    desired.set(key, { stream: ref, cursor, dirty: true });
  }
  return desired;
}

const DIAGNOSTIC_FIELDS: Record<string, true> = {
  type: true, protocolVersion: true, event: true, clientId: true, sessionId: true,
  state: true, status: true, errorCode: true, visibility: true, navigation: true,
  code: true, reason: true,
};

function validDiagnosticShape(message: object): boolean {
  return Object.entries(message).every(([key, value]) =>
    Object.hasOwn(DIAGNOSTIC_FIELDS, key) &&
    (key === "state"
      ? isJsonObject(value) && Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024
      : key === "protocolVersion" || key === "code"
      ? typeof value === "number" && Number.isFinite(value)
      : typeof value === "string" && Buffer.byteLength(value) <= 1024));
}

function rawBytes(raw: WebSocket.RawData): number {
  if (!Array.isArray(raw)) return raw.byteLength;
  let bytes = 0;
  for (const part of raw) bytes += part.byteLength;
  return bytes;
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

function send(ws: WebSocket, message: EventServerMessage, delivered?: () => void): SendAdmission {
  if (ws.readyState !== WebSocket.OPEN) return "connection_full";
  const wire = "event" in message ? eventWireFrame(message.event) : undefined;
  let data = wire?.data ?? JSON.stringify(message);
  let bytes = wire?.bytes ?? Buffer.byteLength(data);
  if ("event" in message && bytes > MAX_OUTBOUND_MESSAGE_BYTES) {
    const omitted = omittedEventWireFrame(message.event);
    data = omitted.data;
    bytes = omitted.bytes;
  }
  if (bytes > MAX_OUTBOUND_MESSAGE_BYTES) return "connection_full";
  bytes += 10; // The largest unmasked WS frame header is part of the budget.
  const admission = reserveWire(ws, bytes);
  if (admission === "accepted")
    sendReserved(ws, bytes, (done) => ws.send(data, done), delivered);
  return admission;
}

function reserveWire(ws: WebSocket, bytes: number): SendAdmission {
  let admission = sendBudget.reserve(ws, bytes);
  if (admission === "global_full") {
    sendBudget.reclaimFor(ws, bytes);
    admission = sendBudget.reserve(ws, bytes);
  }
  return admission;
}

function sendReserved(
  ws: WebSocket,
  bytes: number,
  write: (done: (error?: Error) => void) => void,
  delivered?: () => void,
): void {
  sendBudget.sending(ws, bytes);
  const stalled = () => {
    discardConnectionQueues.get(ws)?.();
    closeSocket(ws, 1013, "websocket client too slow");
  };
  let state = deliveryTimers.get(ws);
  if (!state) {
    const timer = setTimeout(stalled, 5000);
    timer.unref();
    state = { pending: 0, timer };
    deliveryTimers.set(ws, state);
  }
  state.pending++;
  let released = false;
  const done = (error?: Error) => {
    if (released) return;
    released = true;
    sendBudget.release(ws, bytes, true);
    state.pending--;
    if (!state.pending) {
      clearTimeout(state.timer);
      deliveryTimers.delete(ws);
    } else state.timer.refresh();
    if (error) {
      discardConnectionQueues.get(ws)?.();
      closeSocket(ws, 1011, "websocket send failed");
    }
    delivered?.();
  };
  try { write(done); }
  catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  ws.close(code, reason);
  const timer = setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, 1000);
  timer.unref();
  ws.once("close", () => clearTimeout(timer));
}

function attachTerminalConnection(
  ws: WebSocket,
  manager: TerminalManager,
  terminalId: string,
  workspacePath: string,
  req: IncomingMessage,
  admit: (bytes: number) => boolean,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue === null ? undefined : Number(cursorValue);
  const outputAck = url.searchParams.get("protocolVersion") === String(TERMINAL_STREAM_PROTOCOL_VERSION);
  const outputFlow = new TerminalOutputFlow(outputAck);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < -1)) {
    sendTerminalProblem(ws, "INVALID_REQUEST", "terminal cursor must be an integer >= -1");
    closeSocket(ws, 1008, "invalid cursor");
    return;
  }

  let closed = false;
  let writing = false;
  let pumping = false;
  const queue: Array<{ data: string; bytes: number }> = [];
  let closeAfterFlush: { code: number; reason: string } | undefined;
  let attachment: ReturnType<TerminalManager["attach"]> | undefined;
  let outputCursor: number | undefined;
  let recovering = true;
  let helloPending = true;
  let readyPending = true;
  let outputParts: string[] = [];
  let outputBytes = 0;
  let outputTimer: NodeJS.Timeout | undefined;
  let outputResumeTimer: NodeJS.Timeout | undefined;
  let outputAckTimer: NodeJS.Timeout | undefined;
  let outputBlockedOnAck = false;
  let workTask: NodeJS.Immediate | undefined;
  let pendingProblem: Extract<TerminalStreamServerFrame, { type: "problem" }> | undefined;
  let pendingAck: Extract<TerminalStreamServerFrame, { type: "input_ack" }> | undefined;
  let pendingTitle: string | undefined;
  let pendingExit: { exitCode: number | null } | undefined;
  let pendingPongs = 0;
  let lastInputId = 0;
  let lastInputData: string | undefined;
  const scheduleWork = () => {
    if (closed || workTask) return;
    workTask = setImmediate(() => {
      workTask = undefined;
      if (recovering && !closeAfterFlush) resumeOutput();
      pump();
    });
  };
  const stopWaiting = sendBudget.whenAvailable(scheduleWork);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(outputTimer);
    clearTimeout(outputResumeTimer);
    clearTimeout(outputAckTimer);
    clearImmediate(workTask);
    outputParts = [];
    outputBytes = 0;
    queue.length = 0;
    pendingProblem = undefined;
    pendingAck = undefined;
    pendingTitle = undefined;
    pendingExit = undefined;
    lastInputData = undefined;
    stopWaiting();
    attachment?.detach();
    sendBudget.discardQueued(ws);
  };
  discardConnectionQueues.set(ws, cleanup);
  ws.on("close", cleanup);
  const close = (code: number, reason: string) => {
    cleanup();
    closeSocket(ws, code, reason);
  };
  const closeWhenDrained = (code: number, reason: string) => {
    if (closed) return;
    closeAfterFlush = { code, reason };
    attachment?.detach();
    pump();
  };
  const sendFrame = (frame: TerminalStreamServerFrame): boolean => {
    if (closed || ws.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify(frame);
    const bytes = Buffer.byteLength(data) + 10;
    if (frame.type === "output") {
      const delay = outputFlow.retryAfterMs(bytes);
      if (delay > 0) {
        if (Number.isFinite(delay)) {
          outputResumeTimer ??= setTimeout(() => {
            outputResumeTimer = undefined;
            scheduleWork();
          }, delay);
          outputResumeTimer.unref();
        } else {
          outputBlockedOnAck = true;
          outputAckTimer ??= setTimeout(() => close(1013, "terminal output acknowledgement stalled"), 5000);
          outputAckTimer.unref();
        }
        return false;
      }
    }
    const admission = reserveWire(ws, bytes);
    if (admission === "connection_full") {
      close(1013, "terminal client too slow");
      return false;
    }
    if (admission === "global_full") return false;
    if (frame.type === "output") {
      outputFlow.sent(frame.cursor, bytes);
      if (outputAck)
        outputAckTimer ??= setTimeout(() => close(1013, "terminal output acknowledgement stalled"), 5000);
      outputAckTimer?.unref();
    }
    queue.push({ data, bytes });
    pump();
    return true;
  };
  const pump = () => {
    if (closed || writing || pumping) return;
    pumping = true;
    try {
      if (pendingAck && sendFrame(pendingAck)) pendingAck = undefined;
      if (pendingProblem && sendFrame(pendingProblem)) pendingProblem = undefined;
      if (!recovering && pendingTitle !== undefined &&
          sendFrame({ type: "title", title: pendingTitle })) pendingTitle = undefined;
      if (!recovering && !outputFlow.hasPendingAcknowledgements && pendingExit &&
          sendFrame({ type: "exit", cursor: outputCursor!, exitCode: pendingExit.exitCode })) {
        pendingExit = undefined;
        closeAfterFlush = { code: 1001, reason: "terminal exited" };
      }
      while (pendingPongs > 0) {
        if (!sendFrame({ type: "pong", protocolVersion: TERMINAL_STREAM_PROTOCOL_VERSION, t: Date.now() })) break;
        pendingPongs--;
      }
      const next = queue.shift();
      if (!next) {
        if (closeAfterFlush && !pendingAck && !pendingProblem && !pendingExit) {
          const pending = closeAfterFlush;
          close(pending.code, pending.reason);
        }
        return;
      }
      writing = true;
      sendReserved(ws, next.bytes, (done) => ws.send(next.data, done), () => {
        writing = false;
        scheduleWork();
      });
    } finally {
      pumping = false;
    }
  };
  const problem = (code: string, message: string) => {
    pendingProblem = { type: "problem", problem: { code: isErrorCode(code) ? code : "INTERNAL", message } };
    pump();
  };
  const suspendOutput = () => {
    recovering = true;
    attachment?.detach();
    clearTimeout(outputTimer);
    outputTimer = undefined;
    outputParts = [];
    const bytes = outputBytes;
    outputBytes = 0;
    sendBudget.release(ws, bytes);
  };
  const flushOutput = () => {
    clearTimeout(outputTimer);
    outputTimer = undefined;
    if (closed || recovering) return;
    const data = outputParts.join("");
    outputParts = [];
    const bytes = outputBytes;
    outputBytes = 0;
    sendBudget.release(ws, bytes);
    for (const chunk of splitTerminalOutput(data)) {
      const nextCursor = outputCursor! + chunk.length;
      if (!sendFrame({ type: "output", cursor: nextCursor, data: chunk })) {
        if (!closed) suspendOutput();
        return;
      }
      outputCursor = nextCursor;
    }
  };
  const onOutput = (data: string, bytes = Buffer.byteLength(data)) => {
    if (closed || recovering) return;
    const admission = reserveWire(ws, bytes);
    if (admission === "connection_full") {
      close(1013, "terminal client too slow");
      return;
    }
    if (admission === "global_full") {
      suspendOutput();
      return;
    }
    outputParts.push(data);
    outputBytes += bytes;
    if (outputBytes >= 32 * 1024) flushOutput();
    else outputTimer ??= setTimeout(flushOutput, 16);
  };
  const onExit = (event: { exitCode: number | null }) => {
    if (closed) return;
    flushOutput();
    pendingExit = event;
    pump();
  };
  const onTitle = (title: string) => {
    if (closed) return;
    flushOutput();
    pendingTitle = title;
    pump();
  };
  const resumeOutput = () => {
    if (closed || closeAfterFlush || !recovering || outputResumeTimer || outputBlockedOnAck) return;
    try {
      // 总额度紧张时保留游标，而不是另建未计量的输出队列；
      // 从最后准入的字符续接，游标过期则显式返回协议错误，
      // 绝不静默跳过终端输出尾部。
      attachment = manager.attach(workspacePath, terminalId,
        outputCursor ?? cursor, onOutput, onExit, onTitle);
      outputCursor = attachment.replayCursor;
      if (helloPending) {
        if (!sendFrame({ type: "hello", protocolVersion: TERMINAL_STREAM_PROTOCOL_VERSION,
          inputAck: true, ...(outputAck ? { outputAck: true } : {}),
          terminal: manager.get(workspacePath, terminalId), cursor: attachment.cursor })) {
          if (!closed) suspendOutput();
          return;
        }
        helloPending = false;
      }
      for (const chunk of splitTerminalOutput(attachment.replay)) {
        const nextCursor: number = outputCursor! + chunk.length;
        if (!sendFrame({ type: "output", cursor: nextCursor, data: chunk })) {
          if (!closed) suspendOutput();
          return;
        }
        outputCursor = nextCursor;
      }
      if (readyPending) {
        if (!sendFrame({ type: "ready", cursor: attachment.cursor })) {
          if (!closed) suspendOutput();
          return;
        }
        readyPending = false;
      }
      recovering = false;
      if (!closed) attachment.activate();
    } catch (error) {
      attachment?.detach();
      const code = errorCode(error);
      problem(code, error instanceof Error ? error.message : String(error));
      closeWhenDrained(code === "TERMINAL_CURSOR_EXPIRED" ? 1008 : 1000, code);
    }
  };

  ws.on("message", (raw) => {
    const bytes = rawBytes(raw);
    if (closed || !admit(bytes)) return;
    let frame: TerminalStreamClientFrame;
    try { frame = JSON.parse(String(raw)) as TerminalStreamClientFrame; }
    catch { problem("INVALID_REQUEST", "invalid terminal stream frame"); return; }
    if (!isJsonObject(frame)) { problem("INVALID_REQUEST", "invalid terminal stream frame"); return; }
    try {
      if (frame.type === "input" && typeof frame.data === "string") {
        if (frame.inputId === undefined) {
          manager.write(workspacePath, terminalId, frame.data);
          return;
        }
        const inputId = frame.inputId;
        if (!Number.isSafeInteger(inputId) || inputId < 1 ||
            bytes > 64 * 1024 || Buffer.byteLength(frame.data) > 32 * 1024 || pendingAck ||
            (inputId !== lastInputId + 1 && inputId !== lastInputId) ||
            (inputId === lastInputId && frame.data !== lastInputData)) {
          problem("INVALID_REQUEST", "invalid terminal input sequence");
          closeWhenDrained(1008, "invalid terminal input sequence");
          return;
        }
        // 操作 PTY 前先预留有界 ACK；下面的共享预算拒绝
        // 确定尚未写入，因此可安全重试。
        const ackBytes = 128;
        const admission = reserveWire(ws, ackBytes);
        if (admission === "connection_full") { close(1013, "terminal client too slow"); return; }
        if (admission === "global_full") {
          pendingAck = inputId === lastInputId
            ? { type: "input_ack", inputId, accepted: true }
            : { type: "input_ack", inputId, accepted: false, retryAfterMs: 50 };
          scheduleWork();
          return;
        }
        let accepted = inputId === lastInputId;
        try {
          if (!accepted) {
            manager.write(workspacePath, terminalId, frame.data);
            lastInputId = inputId;
            lastInputData = frame.data;
            accepted = true;
          }
        } catch (error) {
          if (errorCode(error) !== "RATE_LIMITED") {
            sendBudget.release(ws, ackBytes);
            throw error;
          }
        }
        const ack = accepted
          ? { type: "input_ack", inputId, accepted: true }
          : { type: "input_ack", inputId, accepted: false, retryAfterMs: 50 };
        const data = JSON.stringify(ack);
        const wireBytes = Buffer.byteLength(data) + 10;
        sendBudget.release(ws, ackBytes - wireBytes);
        queue.push({ data, bytes: wireBytes });
        pump();
      } else if (frame.type === "output_ack") {
        if (!outputFlow.acknowledge(frame.cursor)) {
          problem("INVALID_REQUEST", "invalid terminal output acknowledgement");
          closeWhenDrained(1008, "invalid terminal output acknowledgement");
          return;
        }
        outputBlockedOnAck = false;
        clearTimeout(outputAckTimer);
        outputAckTimer = undefined;
        if (outputFlow.hasPendingAcknowledgements) {
          outputAckTimer = setTimeout(() => close(1013, "terminal output acknowledgement stalled"), 5000);
          outputAckTimer.unref();
        }
        scheduleWork();
      } else if (frame.type === "resize" &&
          Number.isSafeInteger(frame.rows) && frame.rows >= 1 && frame.rows <= 500 &&
          Number.isSafeInteger(frame.cols) && frame.cols >= 1 && frame.cols <= 500) {
        manager.update(workspacePath, terminalId, { rows: frame.rows, cols: frame.cols });
      } else if (frame.type === "ping" && (frame.protocolVersion === TERMINAL_STREAM_PROTOCOL_VERSION || frame.protocolVersion === 1)) {
        pendingPongs++;
        pump();
      } else problem("INVALID_REQUEST", "invalid terminal stream frame");
    } catch (error) {
      const code = errorCode(error);
      problem(code, error instanceof Error ? error.message : String(error));
      // 意外 PTY 错误无法确认是否受理，不能宣称可安全重试；
      // 旧版无标识客户端仍沿用限流时明确关闭的路径。
      if (frame.type === "input")
        closeWhenDrained(code === "RATE_LIMITED" ? 1013 : 1011, "terminal input interrupted");
    }
  });
  resumeOutput();
}

function sendTerminalProblem(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify({ type: "problem", problem: { code, message } });
  const bytes = Buffer.byteLength(data) + 10;
  if (reserveWire(ws, bytes) === "accepted")
    sendReserved(ws, bytes, (done) => ws.send(data, done));
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
