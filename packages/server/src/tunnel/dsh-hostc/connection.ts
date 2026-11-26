// Modified for OMPiUI; upstream source and licenses are identified in NOTICE.
import { type RawData, WebSocket } from "ws";
import { errorFromResponse, PROTOCOL_HEADERS, TunnelError } from "./api.js";
import {
  CLOSE_PROTOCOL_ERROR, CLOSE_REPLACED, CLOSE_SHUTDOWN, decodeFrame, decodeOpen, encodeFrame, encodeHead, encodeText,
  FRAME_HEADER_BYTES, FrameType as Frames, type Frame, type FrameType, type CreateTunnelResponse, type HeaderList,
  type OpenMessage, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, MAX_STREAMS, MAX_WEBSOCKET_MESSAGE_BYTES,
  PING, PONG, ProtocolError, WindowBudget,
} from "./protocol/index.js";
import { createStream, type RequestLog, type Stream } from "./streams.js";

export type ConnectionOptions = {
  tunnel: CreateTunnelResponse;
  target: URL;
  publicUrl: URL;
  authorize: (request: OpenMessage) => OpenMessage | undefined;
  stripResponseHeaders: (headers: HeaderList) => HeaderList;
  onRequest: (entry: RequestLog) => void;
};

export type CloseInfo = { code: number; reason: string };

const MAX_OPEN_BYTES = 64 * 1024;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

/** One WebSocket session with the tunnel server. */
export class Connection {
  readonly closed: Promise<CloseInfo>;
  private readonly streams = new Map<number, Stream>();
  private readonly windowBudget = new WindowBudget();
  private readonly heartbeat: NodeJS.Timeout;
  private pongTimeout: NodeJS.Timeout | undefined;
  private closeTimeout: NodeJS.Timeout | undefined;
  private readonly relayQueue = new SendBudget();
  private readonly localWebSocketQueue = new SendBudget();
  private stopping = false;

  static open(options: ConnectionOptions, signal?: AbortSignal): Promise<Connection> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const socket = new WebSocket(options.tunnel.connectUrl, {
        headers: { authorization: `Bearer ${options.tunnel.token}`, ...PROTOCOL_HEADERS },
        agent: false,
        rejectUnauthorized: true,
        followRedirects: false,
        autoPong: false,
        perMessageDeflate: false,
        handshakeTimeout: 6_000,
        maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES + FRAME_HEADER_BYTES,
        maxFragments: 128,
        maxBufferedChunks: 1024,
      });
      const abort = () => {
        reject(signal?.reason);
        socket.terminate();
      };
      const removeAbort = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("close", removeAbort);
      socket.once("unexpected-response", (_request, response) => {
        reject(errorFromResponse(response.statusCode ?? 0, "Tunnel rejected the connection"));
        response.destroy();
        socket.terminate();
      });
      const onError = () => reject(new TunnelError("network_error", "Could not connect to DS Harness Remote"));
      socket.once("error", onError);
      socket.once("open", () => {
        removeAbort();
        socket.off("error", onError);
        resolve(new Connection(socket, options));
      });
    });
  }

  private constructor(private readonly socket: WebSocket, private readonly options: ConnectionOptions) {
    let resolveClosed!: (info: CloseInfo) => void;
    this.closed = new Promise(resolve => { resolveClosed = resolve; });
    socket.on("message", (data, isBinary) => {
      if (this.stopping) return;
      // Inbound data proves liveness even if the text pong is queued behind an upload.
      if (isBinary) {
        clearTimeout(this.pongTimeout);
        this.receive(data);
      } else if (data.toString() === PONG) {
        clearTimeout(this.pongTimeout);
      }
    });
    socket.on("ping", data => this.queue(data.length, done => socket.pong(data, true, done)));
    socket.on("error", () => this.stopStreams());
    socket.once("close", code => {
      clearTimeout(this.closeTimeout);
      this.stopStreams();
      // Never expose arbitrary relay close text to status, hooks or logs.
      resolveClosed(Object.freeze({ code, reason: closeDescription(code) }));
    });
    this.heartbeat = setInterval(() => {
      this.queue(PING.length, done => socket.send(PING, done));
      if (this.stopping) return;
      clearTimeout(this.pongTimeout);
      this.pongTimeout = setTimeout(() => this.terminate(), HEARTBEAT_TIMEOUT_MS);
      this.pongTimeout.unref();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  close(code: number, reason: string): void {
    this.stopStreams();
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(code, reason);
      this.closeTimeout = setTimeout(() => this.socket.terminate(), 1000);
      this.closeTimeout.unref();
    }
  }

  private terminate(): void {
    this.stopStreams();
    this.socket.terminate();
  }

  private stopStreams(): void {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.pongTimeout);
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
  }

  private receive(data: RawData): void {
    try {
      const frame = decodeFrame(Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      try {
        this.dispatch(frame);
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        // One local failure must not take down the multiplexed connection.
        this.streams.get(frame.stream)?.abort();
        this.streams.delete(frame.stream);
        this.send(Frames.Reset, frame.stream, encodeText("Host could not forward the request"));
      }
    } catch {
      this.close(CLOSE_PROTOCOL_ERROR, "invalid hostc frame");
    }
  }

  private dispatch(frame: Frame): void {
    if (frame.type !== Frames.Open) {
      // Frames already in flight for a stream that ended are expected.
      this.streams.get(frame.stream)?.receive(frame);
      return;
    }
    if (this.streams.has(frame.stream)) throw new ProtocolError("stream already open");
    if (frame.payload.byteLength > MAX_OPEN_BYTES || this.streams.size >= MAX_STREAMS) {
      this.send(Frames.Reset, frame.stream, encodeText("Request exceeds tunnel capacity"));
      return;
    }
    const request = this.options.authorize(decodeOpen(frame.payload));
    if (request === undefined) {
      this.send(Frames.Head, frame.stream, encodeHead({ status: 403, headers: [], body: false }));
      return;
    }
    const stream = createStream({
      target: this.options.target,
      publicOrigin: this.options.publicUrl.origin,
      stripResponseHeaders: this.options.stripResponseHeaders,
      send: (type, id, payload, flushed) => this.send(type, id, payload, flushed),
      log: this.options.onRequest,
      remove: id => this.streams.delete(id),
      windowBudget: this.windowBudget,
      reserveWebSocketSend: bytes => this.localWebSocketQueue.reserve(bytes),
    }, frame.stream, request);
    this.streams.set(frame.stream, stream);
    stream.start();
  }

  private send(type: FrameType, stream: number, payload?: Uint8Array, flushed?: () => void): void {
    this.queue(FRAME_HEADER_BYTES + (payload?.byteLength ?? 0), done => {
      this.socket.send(encodeFrame(type, stream, payload), done);
    }, flushed);
  }

  private queue(bytes: number, send: (done: (error?: Error) => void) => void, flushed?: () => void): void {
    if (this.stopping || this.socket.readyState !== WebSocket.OPEN) {
      flushed?.();
      return;
    }
    const release = this.relayQueue.reserve(bytes);
    if (!release) {
      this.terminate();
      flushed?.();
      return;
    }
    let completed = false;
    const done = (error?: Error) => {
      if (completed) return;
      completed = true;
      release();
      if (error) this.terminate();
      flushed?.();
    };
    try { send(done); } catch { done(new Error("Could not write tunnel frame")); }
  }
}

/** Bound queued bytes and account for the frame/callback even for an empty message. */
class SendBudget {
  private queued = 0;

  reserve(bytes: number): (() => void) | undefined {
    const charge = bytes + 64;
    if (this.queued + charge > MAX_QUEUED_BYTES) return;
    this.queued += charge;
    return () => { this.queued -= charge; };
  }
}

function closeDescription(code: number): string {
  if (code === CLOSE_SHUTDOWN) return "host stopped";
  if (code === CLOSE_REPLACED) return "connection replaced";
  if (code === 1006) return "connection lost";
  return `closed with code ${code}`;
}
