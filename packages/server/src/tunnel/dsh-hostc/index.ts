import { Connection, type CloseInfo } from "./connection.js";
import { isTunnelId, CLOSE_SHUTDOWN, type CreateTunnelResponse } from "./protocol/index.js";
import { prepareRequest, stripPrivateHeaders, type DshHostcAdmissionRequest } from "./request-policy.js";
import type { RequestLog } from "./streams.js";

export { TunnelError, type TunnelErrorCode } from "./api.js";
export type { DshHostcAdmissionRequest } from "./request-policy.js";
export type DshHostcLease = Readonly<CreateTunnelResponse>;
export type DshHostcCloseInfo = Readonly<CloseInfo>;
export type DshHostcRequestInfo = Readonly<RequestLog>;
export type DshHostcPublicInfo = Readonly<Pick<DshHostcLease, "id" | "url">>;

type Hook<T> = (event: Readonly<T>) => void | Promise<void>;

export interface DshHostcOptions {
  lease: DshHostcLease;
  /** TCP always connects directly to 127.0.0.1, never to the request Host. */
  localPort: number;
  /** 仅用于已授权隧道请求到本机回环服务的鉴权，不发送给中转或客户端。 */
  authToken?: string;
  /** Additional admission; returning anything other than true or throwing denies the request. */
  admit?: (request: DshHostcAdmissionRequest) => boolean;
  onOpen?: Hook<DshHostcPublicInfo>;
  onClose?: Hook<DshHostcCloseInfo>;
  /** HTTP completion or WebSocket handshake; no query string or credentials. */
  onRequest?: Hook<DshHostcRequestInfo>;
}

export interface DshHostcTransport {
  readonly closed: Promise<DshHostcCloseInfo>;
  /** Stop forwarding and close the connection with hostc's intentional-shutdown code. */
  close(): void;
}

/** Open one preallocated v5 transport. The caller owns lease expiry, renewal and retry policy. */
export async function openDshHostc(options: DshHostcOptions, signal?: AbortSignal): Promise<DshHostcTransport> {
  const { lease, localPort, authToken, admit, onOpen, onClose, onRequest } = options;
  signal?.throwIfAborted();
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error("Invalid DS Harness Remote loopback port");
  }
  const tunnel = validateLease(lease);
  const publicUrl = new URL(tunnel.url);
  const connection = await Connection.open({
    tunnel,
    target: new URL(`http://127.0.0.1:${localPort}`),
    publicUrl,
    authorize: request => prepareRequest(request, publicUrl.host, admit, authToken),
    stripResponseHeaders: stripPrivateHeaders,
    onRequest: entry => notify(onRequest, entry),
  }, signal);

  // The input signal cancels dialing only. Once open, use close() to stop an active transport.
  if (signal?.aborted) {
    connection.close(CLOSE_SHUTDOWN, "host stopped");
    signal.throwIfAborted();
  }
  void connection.closed.then(info => notify(onClose, info));
  notify(onOpen, Object.freeze({ id: tunnel.id, url: tunnel.url }));
  return { closed: connection.closed, close: () => connection.close(CLOSE_SHUTDOWN, "host stopped") };
}

function validateLease(lease: DshHostcLease): CreateTunnelResponse {
  const { id, token, url, connectUrl } = lease;
  const publicUrl = URL.parse(url);
  const dial = URL.parse(connectUrl);
  // Match the pinned allocator's canonical per-lease endpoints. The caller must separately
  // verify that the lease came from the expected allocator; a syntactically valid domain is not trusted.
  if (!publicUrl || !dial || !isTunnelId(id) || !/^[A-Za-z0-9_-]{43}$/.test(token)
    || dial.href !== `wss://${dial.hostname}/api/tunnels/${id}/connect`
    || publicUrl.href !== `https://${id}.${dial.hostname}/`) {
    throw new Error("Invalid DS Harness Remote tunnel lease");
  }
  return { id, token, url: publicUrl.href, connectUrl: dial.href };
}

function notify<T>(hook: Hook<T> | undefined, event: Readonly<T>): void {
  try { void Promise.resolve(hook?.(event)).catch(() => {}); } catch { /* Observability must not break forwarding. */ }
}
