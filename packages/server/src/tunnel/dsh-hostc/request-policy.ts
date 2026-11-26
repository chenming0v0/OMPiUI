import { validateHeaderName, validateHeaderValue } from "node:http";
import { TERMINAL_SECRET_HEADER } from "../../host/terminal-auth.js";
import { parseSubprotocols, stripWebSocketHandshake, type HeaderList, type OpenMessage } from "./protocol/index.js";

export interface DshHostcAdmissionRequest {
  readonly method: string;
  /** Original origin-form target, including its query. May contain credentials; do not log. */
  readonly path: string;
  /** Decoded path used for the reserved-route check. */
  readonly pathname: string;
  /** Client-supplied end-to-end headers; do not trust claims of client identity. */
  readonly headers: readonly (readonly [name: string, value: string])[];
  readonly websocket?: readonly string[];
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const RESERVED = /^\/(?:__remote|api\/v1\/host\/dsh-remote)(?:\/|$)/i;
const SINGLETON_HEADERS = new Set(["authorization", "origin", TERMINAL_SECRET_HEADER]);
const PRIVATE_HEADERS = /^(?:(?:forwarded|via|x-real-ip|x-client-ip|true-client-ip|x-cluster-client-ip|x-rewrite-url)$|x-forwarded(?:-|$)|cf-|x-original-|x-dsh-(?:remote|web)-|(?:x-)?hostc-)/i;

/** Never trust caller-supplied relay markers or carry relay credentials to the local app. */
export function stripPrivateHeaders(headers: HeaderList, preserveTerminalCredential = false): HeaderList {
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !PRIVATE_HEADERS.test(lower) && (!lower.startsWith("x-ompiui-")
      || (preserveTerminalCredential && lower === TERMINAL_SECRET_HEADER));
  });
}

export function prepareRequest(
  request: OpenMessage,
  publicHost: string,
  admit?: (request: DshHostcAdmissionRequest) => boolean,
): OpenMessage | undefined {
  const { method, path, body, websocket } = request;
  if (!METHODS.has(method) || path.length > 8192 || /[^\x21-\x7e]|#/.test(path) || request.headers.length > 128) return;
  let pathname: string;
  try { pathname = decodeURIComponent(path.split("?", 1)[0]!); } catch { return; }
  // Reject ambiguous target forms before either proxy policy or Node parses them. Do not reconstruct
  // the forwarded path from the decoded one: app query credentials and encoded segments stay intact.
  if (!pathname.startsWith("/") || pathname.includes("//") || /[\\\x00-\x1f\x7f?#]|%[a-f\d]{2}/i.test(pathname)
    || pathname.split("/").some(part => part === "." || part === "..") || RESERVED.test(pathname)) return;
  if (websocket !== undefined && (method !== "GET" || body || websocket.length > 32
    || (websocket.length > 0 && parseSubprotocols(websocket.join(","))?.length !== websocket.length)
    || websocket.some(protocol => !protocol || protocol.includes(",") || protocol.trim() !== protocol))) return;

  try {
    for (const [name, value] of request.headers) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    }
    const headers = stripWebSocketHandshake(request.headers);
    const seen = new Set<string>();
    for (const [name] of headers) {
      const lower = name.toLowerCase();
      if (SINGLETON_HEADERS.has(lower) && seen.has(lower)) return;
      seen.add(lower);
    }
    if (admit && admit({
      method, path, pathname, websocket: websocket?.slice(),
      headers: headers.map(([name, value]) => [name.toLowerCase(), value] as const),
    }) !== true) return;
    // Host derives only from the lease. The TCP destination remains loopback, and the
    // unchanged Origin is checked by the app (including its existing Tauri policy).
    const forwarded = stripPrivateHeaders(headers, true).filter(([name]) => !["host", "content-length", "expect"].includes(name.toLowerCase()));
    forwarded.unshift(["host", publicHost]);
    return { method, path, body, websocket, headers: forwarded };
  } catch { return; }
}
