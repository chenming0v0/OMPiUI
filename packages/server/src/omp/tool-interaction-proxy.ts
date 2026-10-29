import { randomUUID, createHash } from "node:crypto";
import type { Server } from "node:http";
import {
  TOOL_INTERACTION_PROTOCOL_VERSION,
  isJsonObject,
  isToolInteractionDescriptor,
  isToolInteractionIdentity,
  toolInteractionKey,
  type JsonValue,
  type ToolInteractionDescriptor,
  type ToolInteractionIdentity,
  type ToolInteractionLease,
  type ToolInteractionOperation,
  type ToolInteractionRead,
  type ToolInteractionSnapshot,
} from "@ompiui/protocol";
import type { SessionHost } from "./session-host.ts";
import { TextWindow } from "../host/text-window.ts";

export const TOOL_INTERACTION_TICKET_TTL_MS = 60_000;
export const TOOL_INTERACTION_MAX_TICKETS = 1024;
export const TOOL_INTERACTION_READ_BYTES = 8 * 1024;
const CACHE_BYTES = 256 * 1024;

export type ToolInteractionTicketBinding = {
  identity: ToolInteractionIdentity;
  workspacePath: string;
  expiresAt: number;
  authScope: string;
};
type Reader = {
  refs: number;
  window: TextWindow;
  descriptor?: ToolInteractionDescriptor;
  cursor: number;
  checkedAt: number;
  delay: number;
  pending?: Promise<ToolInteractionRead>;
};

const proxies = new WeakMap<Server, ToolInteractionProxy>();
export function registerToolInteractionProxy(server: Server, proxy: ToolInteractionProxy): void {
  proxies.set(server, proxy);
}
export function getToolInteractionProxy(server: Server): ToolInteractionProxy | undefined {
  return proxies.get(server);
}

export function toolInteractionAuthScope(token: string | null): string {
  return createHash("sha256").update(token === null ? "anonymous" : `token:${token}`).digest("hex");
}
function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function sameIdentity(a: ToolInteractionIdentity, b: ToolInteractionIdentity): boolean {
  return toolInteractionKey(a) === toolInteractionKey(b);
}

/** Only forwards commands to an already attached runtime; owns no processes or event output. */
export class ToolInteractionProxy {
  private readonly tickets = new Map<string, ToolInteractionTicketBinding>();
  private readonly readers = new Map<string, Reader>();
  private pendingTickets = 0;

  constructor(private readonly host: Pick<SessionHost, "executeSessionCommand">) {}

  async execute(operation: Exclude<ToolInteractionOperation, { operation: "list" }>): Promise<JsonValue | undefined> {
    const result = await this.host.executeSessionCommand(operation.sessionId, "toolInteraction", { ...operation });
    // This command must resolve immediately, never become a queued model command.
    if (result && typeof result === "object" && "promise" in result)
      throw failure("INTERNAL", "tool interaction command must return immediate JSON");
    return result as JsonValue | undefined;
  }

  async list(sessionId: string): Promise<ToolInteractionSnapshot> {
    const result = await this.host.executeSessionCommand(sessionId, "toolInteraction", { operation: "list" });
    if (!isJsonObject(result) || result.protocolVersion !== TOOL_INTERACTION_PROTOCOL_VERSION ||
        typeof result.runtimeId !== "string" || typeof result.available !== "boolean" ||
        !Array.isArray(result.executions) || !result.executions.every(isToolInteractionDescriptor))
      throw failure("INTERNAL", "invalid tool interaction snapshot");
    return result as unknown as ToolInteractionSnapshot;
  }

  async describe(identity: ToolInteractionIdentity): Promise<ToolInteractionDescriptor> {
    if (!isToolInteractionIdentity(identity)) throw failure("INVALID_REQUEST", "invalid tool interaction identity");
    const result = await this.execute({ operation: "describe", ...identity });
    if (!isToolInteractionDescriptor(result) || !sameIdentity(result, identity))
      throw failure("INTERNAL", "tool interaction descriptor identity mismatch");
    return result;
  }

  async issueTicket(identity: ToolInteractionIdentity, authScope: string): Promise<{ ticket: string; expiresAt: number }> {
    const now = Date.now();
    for (const [ticket, binding] of this.tickets)
      if (binding.expiresAt <= now) this.tickets.delete(ticket);
    if (this.tickets.size + this.pendingTickets >= TOOL_INTERACTION_MAX_TICKETS)
      throw failure("RATE_LIMITED", "tool interaction ticket limit reached");
    this.pendingTickets++;
    try {
      const descriptor = await this.describe(identity);
      const ticket = randomUUID();
      const expiresAt = Date.now() + TOOL_INTERACTION_TICKET_TTL_MS;
      this.tickets.set(ticket, { identity: { ...identity }, workspacePath: descriptor.cwd, expiresAt, authScope });
      return { ticket, expiresAt };
    } finally { this.pendingTickets--; }
  }

  consumeTicket(sessionId: string, executionId: string, ticket: string, authScope: string): ToolInteractionTicketBinding | undefined {
    const binding = this.tickets.get(ticket);
    if (!binding) return;
    this.tickets.delete(ticket);
    if (binding.expiresAt <= Date.now() || binding.authScope !== authScope ||
        binding.identity.sessionId !== sessionId || binding.identity.executionId !== executionId) return;
    return binding;
  }

  async claim(identity: ToolInteractionIdentity, writerId: string, writerEpoch?: string): Promise<ToolInteractionLease> {
    const result = await this.execute({ operation: "claim", ...identity, writerId, ...(writerEpoch ? { writerEpoch } : {}) });
    if (!isJsonObject(result) || result.writerId !== writerId || typeof result.writerEpoch !== "string" ||
        !result.writerEpoch || result.writerEpoch.length > 256 ||
        !Number.isSafeInteger(result.lastAcceptedSequence) || Number(result.lastAcceptedSequence) < 0 ||
        typeof result.expiresAt !== "number" || !Number.isFinite(result.expiresAt))
      throw failure("INTERNAL", "invalid tool interaction writer lease");
    return result as unknown as ToolInteractionLease;
  }

  async input(identity: ToolInteractionIdentity, lease: ToolInteractionLease, sequence: number, data: string): Promise<{ sequence: number; lastAcceptedSequence: number }> {
    const result = await this.execute({ operation: "input", ...identity, writerId: lease.writerId, writerEpoch: lease.writerEpoch, sequence, data });
    if (!isJsonObject(result) || result.sequence !== sequence ||
        !Number.isSafeInteger(result.lastAcceptedSequence) || Number(result.lastAcceptedSequence) < sequence)
      throw failure("INTERNAL", "invalid tool interaction input acknowledgement; acceptance is unknown");
    return { sequence, lastAcceptedSequence: Number(result.lastAcceptedSequence) };
  }

  /** Ref-counted bounded cache: one native read in flight per execution, none after detach. */
  attach(identity: ToolInteractionIdentity): { read: (cursor?: number) => Promise<ToolInteractionRead>; detach: () => void } {
    const key = toolInteractionKey(identity);
    let reader = this.readers.get(key);
    if (!reader) {
      reader = { refs: 0, window: new TextWindow(CACHE_BYTES), cursor: 0, checkedAt: 0, delay: 80 };
      this.readers.set(key, reader);
    }
    reader.refs++;
    let detached = false;
    return {
      read: cursor => detached ? Promise.reject(failure("REQUEST_ABORTED", "tool interaction viewer detached")) : this.read(identity, reader!, cursor),
      detach: () => {
        if (detached) return;
        detached = true;
        if (--reader!.refs === 0) this.readers.delete(key);
      },
    };
  }

  private cached(reader: Reader, cursor: number | undefined): ToolInteractionRead | undefined {
    const descriptor = reader.descriptor;
    if (!descriptor || cursor === undefined) return;
    const oldest = reader.cursor - reader.window.length;
    if (cursor < oldest || cursor > reader.cursor) return;
    if (cursor === reader.cursor && descriptor.status !== "exited" && Date.now() - reader.checkedAt >= reader.delay) return;
    const slice = reader.window.sliceFrom(cursor - oldest, TOOL_INTERACTION_READ_BYTES);
    return { descriptor, fromCursor: cursor, cursor: cursor + slice.chars, data: slice.text, reset: false };
  }

  private async read(identity: ToolInteractionIdentity, reader: Reader, cursor?: number): Promise<ToolInteractionRead> {
    const cached = this.cached(reader, cursor);
    if (cached) return cached;
    if (reader.pending) {
      const result = await reader.pending;
      if (cursor === undefined || cursor === result.fromCursor) return result;
      return this.read(identity, reader, cursor);
    }
    const request = async (): Promise<ToolInteractionRead> => {
      const result = await this.execute({ operation: "read", ...identity, ...(cursor === undefined ? {} : { cursor }), maxBytes: TOOL_INTERACTION_READ_BYTES });
      if (!isJsonObject(result) || !isToolInteractionDescriptor(result.descriptor) ||
          !sameIdentity(result.descriptor, identity) || typeof result.data !== "string" ||
          typeof result.reset !== "boolean" || !Number.isSafeInteger(result.fromCursor) || Number(result.fromCursor) < 0 ||
          !Number.isSafeInteger(result.cursor) || Number(result.cursor) !== Number(result.fromCursor) + result.data.length ||
          Number(result.cursor) > result.descriptor.cursor || Buffer.byteLength(result.data) > TOOL_INTERACTION_READ_BYTES)
        throw failure("INTERNAL", "invalid tool interaction output read");
      const read = result as unknown as ToolInteractionRead;
      if (read.fromCursor !== reader.cursor || read.reset) reader.window = new TextWindow(CACHE_BYTES);
      reader.window.append(read.data);
      reader.cursor = read.cursor;
      reader.descriptor = read.descriptor;
      reader.checkedAt = Date.now();
      reader.delay = read.data ? 80 : 250;
      return read;
    };
    reader.pending = request();
    try { return await reader.pending; }
    finally { reader.pending = undefined; }
  }

  dispose(): void {
    this.tickets.clear();
    this.readers.clear();
  }
}
