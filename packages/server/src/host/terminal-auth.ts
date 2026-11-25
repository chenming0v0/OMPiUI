import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const TERMINAL_SECRET_HEADER = "x-ompiui-terminal-secret";

declare const terminalOwnerBrand: unique symbol;
/** Server-derived private principal. Never accept an owner ID from request params. */
export type TerminalOwner = string & { readonly [terminalOwnerBrand]: true };

/**
 * GUI terminals belong to a private browser/client, not the shared host bearer.
 * The client creates and persists 32 random bytes per backend. Only its digest
 * is kept on the in-memory terminal registry; it is never sent in event payloads.
 */
export function terminalOwnerFromSecret(secret: unknown): TerminalOwner | undefined {
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) return;
  return createHash("sha256").update("ompiui-private-terminal-v1\0").update(secret).digest("hex") as TerminalOwner;
}

export function terminalOwnerFromRequest(req: IncomingMessage): TerminalOwner | undefined {
  return terminalOwnerFromSecret(req.headers[TERMINAL_SECRET_HEADER]);
}

export function requireTerminalOwner(owner: TerminalOwner | undefined): TerminalOwner {
  if (!owner) {
    throw Object.assign(new Error("private terminal credential required"), { code: "FORBIDDEN" });
  }
  return owner;
}
