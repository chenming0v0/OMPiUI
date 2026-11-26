// Modified for OMPiUI; upstream source and licenses are identified in NOTICE.
import { isUtf8 } from "node:buffer";
import http from "node:http";
import { type RawData, WebSocket } from "ws";
import {
  decodeClose, decodeWindow, encodeClose, encodeHead, encodeText, encodeWindow,
  type Frame, FrameType, GrowingWindow, type HeaderList, MAX_CHUNK_BYTES, MAX_STREAM_WINDOW_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES, type OpenMessage, ProtocolError, RESPONSE_TIMEOUT_MS, responseHasBody,
  sendableCloseCode, STREAM_WINDOW_BYTES, stripHopByHop, stripWebSocketHandshake, type WindowBudget,
} from "./protocol/index.js";
import { fromRawHeaders, toPublicResponseHeaders, toRawHeaders } from "./rewrite.js";

export type RequestLog = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  websocket: boolean;
};

export type StreamContext = {
  target: URL;
  stripResponseHeaders: (headers: HeaderList) => HeaderList;
  publicOrigin: string;
  /** A completed or discarded write releases the waiting producer. */
  send: (type: FrameType, stream: number, payload?: Uint8Array, flushed?: () => void) => void;
  log: (entry: RequestLog) => void;
  remove: (id: number) => void;
  windowBudget: WindowBudget;
  reserveWebSocketSend: (bytes: number) => (() => void) | undefined;
};

export interface Stream {
  start(): void;
  receive(frame: Frame): void;
  abort(): void;
}

export function createStream(context: StreamContext, id: number, open: OpenMessage): Stream {
  return open.websocket !== undefined ? new WebSocketStream(context, id, open) : new HttpStream(context, id, open);
}

/** One public HTTP request with independent upload/download flow control. */
class HttpStream implements Stream {
  private readonly startedAt = Date.now();
  private request: http.ClientRequest | undefined;
  private response: http.IncomingMessage | undefined;
  private readonly window: GrowingWindow;
  private sendCredit = STREAM_WINDOW_BYTES;
  private receiveCredit = STREAM_WINDOW_BYTES;
  private wakeSender: (() => void) | undefined;
  private responseTimer: NodeJS.Timeout | undefined;
  private requestEnded = false;
  private finished = false;

  constructor(private readonly context: StreamContext, private readonly id: number, private readonly open: OpenMessage) {
    this.window = new GrowingWindow(context.windowBudget);
  }

  start(): void {
    const { target } = this.context;
    const headers = toRawHeaders(this.open.headers);
    // Framing belongs to this hop, not to caller-supplied Content-Length/Transfer-Encoding.
    if (this.open.body) headers.push("transfer-encoding", "chunked");
    const request = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      method: this.open.method,
      path: this.open.path,
      headers,
      agent: false,
    });
    this.request = request;
    this.responseTimer = setTimeout(() => this.fail(504, "Local Web server did not respond"), RESPONSE_TIMEOUT_MS);
    this.responseTimer.unref();
    request.on("response", response => void this.respond(response));
    request.on("error", () => this.fail(502, "Local Web server unavailable"));
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      this.fail(502, "Unexpected local WebSocket upgrade");
    });
    if (this.open.body) {
      request.flushHeaders();
    } else {
      this.requestEnded = true;
      request.end();
    }
  }

  receive(frame: Frame): void {
    switch (frame.type) {
      case FrameType.Data: {
        const bytes = frame.payload.byteLength;
        const request = this.request!;
        if (this.requestEnded || bytes > MAX_CHUNK_BYTES || bytes > this.receiveCredit) {
          this.fail(400, "Invalid HTTP upload data");
          return;
        }
        if (bytes === 0) return;
        this.receiveCredit -= bytes;
        // Return credit only when the local socket takes these bytes.
        request.write(frame.payload, error => {
          if (!error && !this.finished) {
            const grant = bytes + (this.requestEnded ? 0 : this.window.delivered(bytes, request.writableLength === 0));
            this.receiveCredit += grant;
            this.context.send(FrameType.Window, this.id, encodeWindow(grant));
          }
        });
        return;
      }
      case FrameType.End:
        if (!this.requestEnded) {
          this.requestEnded = true;
          this.request?.end();
        }
        return;
      case FrameType.Reset:
        this.abort();
        this.finish(499);
        return;
      case FrameType.Window: {
        const credit = decodeWindow(frame.payload);
        if (this.sendCredit + credit > MAX_STREAM_WINDOW_BYTES) {
          this.fail(400, "Invalid HTTP download window");
          return;
        }
        this.sendCredit += credit;
        this.wakeSender?.();
        return;
      }
      default:
        this.fail(400, "Unexpected HTTP stream frame");
    }
  }

  abort(): void {
    this.finished = true;
    this.window.release();
    clearTimeout(this.responseTimer);
    this.request?.destroy();
    this.response?.destroy();
    this.wakeSender?.();
  }

  private async respond(response: http.IncomingMessage): Promise<void> {
    if (this.finished) { response.destroy(); return; }
    this.response = response;
    clearTimeout(this.responseTimer);
    const status = response.statusCode ?? 0;
    if (status < 200 || status > 599) {
      this.fail(502, "Invalid local HTTP status");
      return;
    }
    const body = responseHasBody(this.open.method, status);
    try {
      const headers = this.publicHeaders(response);
      this.context.send(FrameType.Head, this.id, encodeHead({ status, headers, body }));
      if (!body) {
        // No DATA follows a bodyless HEAD, even if a misbehaving local server sent bytes.
        response.destroy();
        if (!this.finished) this.finish(status);
        return;
      }
      // Async iteration waits for the next hop's window and each completed socket write.
      for await (const chunk of response as AsyncIterable<Buffer>) {
        for (let offset = 0; offset < chunk.byteLength;) {
          while (!this.finished && this.sendCredit === 0) {
            await new Promise<void>(resolve => { this.wakeSender = resolve; });
            this.wakeSender = undefined;
          }
          if (this.finished) return;
          const bytes = Math.min(this.sendCredit, MAX_CHUNK_BYTES, chunk.byteLength - offset);
          const part = chunk.subarray(offset, offset + bytes);
          this.sendCredit -= bytes;
          offset += bytes;
          await new Promise<void>(resolve => this.context.send(FrameType.Data, this.id, part, resolve));
        }
      }
      if (!this.finished) {
        this.context.send(FrameType.End, this.id);
        if (!this.finished) this.finish(status);
      }
    } catch {
      this.fail(502, "Local HTTP response failed");
    }
  }

  private publicHeaders(response: http.IncomingMessage): HeaderList {
    return toPublicResponseHeaders(
      this.context.stripResponseHeaders(stripHopByHop(fromRawHeaders(response.rawHeaders))),
      this.context.publicOrigin,
      this.context.target,
    );
  }

  private fail(status: number, message: string): void {
    if (this.finished) return;
    this.context.send(FrameType.Reset, this.id, encodeText(message));
    this.abort();
    this.finish(status);
  }

  private finish(status: number): void {
    this.finished = true;
    this.window.release();
    clearTimeout(this.responseTimer);
    if (!this.requestEnded) this.request?.destroy();
    this.context.remove(this.id);
    this.context.log({
      method: this.open.method, path: this.open.path.split("?", 1)[0]!, status,
      durationMs: Date.now() - this.startedAt, websocket: false,
    });
  }
}

/** One public WebSocket bridged to the local app; WS has no hostc WINDOW frames. */
class WebSocketStream implements Stream {
  private readonly startedAt = Date.now();
  private socket: WebSocket | undefined;
  private settled = false;
  private ended = false;
  private closing = false;
  private closeTimer: NodeJS.Timeout | undefined;
  private unflushed = 0;

  constructor(private readonly context: StreamContext, private readonly id: number, private readonly open: OpenMessage) {}

  start(): void {
    const { target, publicOrigin, send } = this.context;
    // Concatenate instead of resolving: never resolve a visitor's request against a TCP authority.
    const url = new URL(`ws://${target.host}${this.open.path}`);
    if (url.host !== target.host) throw new Error("request path escapes the target");
    const headers: Record<string, string> = Object.create(null);
    for (const [name, value] of this.open.headers) {
      const lower = name.toLowerCase();
      const previous = headers[lower];
      headers[lower] = previous === undefined ? value : `${previous}${lower === "cookie" ? "; " : ", "}${value}`;
    }
    const socket = new WebSocket(url, this.open.websocket ?? [], {
      headers,
      agent: false,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 6_000,
      maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
      maxFragments: 128,
      maxBufferedChunks: 1024,
    });
    this.socket = socket;

    let upgradeHeaders: HeaderList = [];
    socket.on("upgrade", response => {
      upgradeHeaders = this.context.stripResponseHeaders(stripWebSocketHandshake(fromRawHeaders(response.rawHeaders)));
    });
    socket.on("open", () => {
      const protocol = socket.protocol || undefined;
      send(FrameType.Head, this.id, encodeHead({ status: 101, headers: upgradeHeaders, body: false, protocol }));
      this.settle(101);
    });
    socket.on("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 502;
      const headers = toPublicResponseHeaders(
        this.context.stripResponseHeaders(stripHopByHop(fromRawHeaders(response.rawHeaders), ["content-length"])),
        publicOrigin, target,
      );
      send(FrameType.Head, this.id, encodeHead({ status, headers, body: false }));
      this.settle(status);
      this.end();
      response.destroy();
      socket.terminate();
    });
    socket.on("message", (data, isBinary) => {
      if (this.ended || this.closing) return;
      // What the tunnel has not taken stays in TCP and holds back this local server socket.
      socket.pause();
      this.unflushed++;
      send(isBinary ? FrameType.Data : FrameType.Text, this.id, toBytes(data), () => {
        if (--this.unflushed === 0 && !this.ended) socket.resume();
      });
    });
    socket.on("close", (code, reason) => {
      if (this.ended) return;
      if (!this.closing) send(FrameType.End, this.id, encodeClose({ code, reason: reason.toString() }));
      this.end();
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (this.ended) return;
      if (this.settled) {
        const code = error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? 1009 : 1011;
        if (!this.closing) this.sendClose(code, "Local WebSocket failed");
      } else {
        send(FrameType.Reset, this.id, encodeText("Local Web server unavailable"));
        this.settle(502);
      }
      this.abort();
    });
  }

  receive(frame: Frame): void {
    switch (frame.type) {
      case FrameType.Data:
      case FrameType.Text: {
        if (this.closing || this.socket?.readyState !== WebSocket.OPEN) return;
        const binary = frame.type === FrameType.Data;
        if (!binary && !isUtf8(frame.payload)) {
          this.sendClose(1007, "Invalid WebSocket text");
          this.abort();
          return;
        }
        const release = this.context.reserveWebSocketSend(frame.payload.byteLength);
        if (!release) {
          this.sendClose(1013, "WebSocket queue full");
          this.abort();
          return;
        }
        try { this.socket.send(frame.payload, { binary }, release); } catch (error) { release(); throw error; }
        return;
      }
      case FrameType.End: {
        if (this.closing) return;
        if (frame.payload.byteLength > 125) throw new ProtocolError("oversized WebSocket close frame");
        const { code, reason } = decodeClose(frame.payload);
        this.closing = true;
        if (this.socket?.readyState !== WebSocket.OPEN) { this.abort(); return; }
        this.socket.close(sendableCloseCode(code), reason);
        this.socket.resume();
        this.closeTimer = setTimeout(() => this.abort(), 1000);
        this.closeTimer.unref();
        return;
      }
      case FrameType.Reset:
        this.settle(499);
        this.abort();
        return;
      default:
        this.context.send(FrameType.Reset, this.id, encodeText("Unexpected WebSocket stream frame"));
        this.abort();
    }
  }

  abort(): void {
    this.end();
    this.socket?.terminate();
  }

  private sendClose(code: number, reason: string): void {
    this.context.send(FrameType.End, this.id, encodeClose({ code, reason }));
  }

  private settle(status: number): void {
    if (this.settled) return;
    this.settled = true;
    this.context.log({
      method: "GET", path: this.open.path.split("?", 1)[0]!, status,
      durationMs: Date.now() - this.startedAt, websocket: true,
    });
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.closeTimer);
    this.context.remove(this.id);
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}
