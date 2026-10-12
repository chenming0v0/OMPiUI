import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { EventCursor, JsonObject, JsonValue } from "@ompiui/protocol";
import type {
  BranchCheckpoint,
  EntriesPage,
  LiveMessage,
  SessionHead,
} from "@ompiui/protocol";

export type { BranchCheckpoint, EntriesPage, LiveMessage, SessionHead };

type NativeCursor = { v: 1; epoch: string; beforeId: string };

/**
 * 光标 HMAC 密钥。优先用服务端注入的持久化密钥（OMPIUI_CURSOR_SECRET），
 * 这样 worker 进程重启（空闲回收后重新 attach）后旧光标依然有效；
 * 没有注入时退回每进程随机密钥（独立运行场景）。
 */
const cursorSecret = resolveCursorSecret();

function resolveCursorSecret(): Buffer {
  const configured = process.env.OMPIUI_CURSOR_SECRET?.trim();
  if (configured) {
    const decoded = Buffer.from(configured, "base64url");
    if (decoded.length >= 32) return decoded.subarray(0, 32);
  }
  return randomBytes(32);
}

export function sessionHeadFromParts(
  parts: Omit<SessionHead, "epoch">,
  epochSeed: unknown = parts.header,
): SessionHead {
  return {
    ...parts,
    epoch: createHash("sha256")
      .update(JSON.stringify(epochSeed))
      .digest("base64url")
      .slice(0, 22),
  };
}

export function entriesPageFromEntries<T>(
  head: SessionHead,
  entries: readonly T[],
  options: {
    cursor?: string;
    limit: number;
    maxBytes: number;
    checkpoint?: BranchCheckpoint;
  },
  serialize: (entry: T) => JsonObject,
): EntriesPage {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  ) {
    throw Object.assign(new Error("invalid page limits"), {
      code: "INVALID_REQUEST",
    });
  }
  options = {
    ...options,
    limit: Math.min(options.limit, 200),
    maxBytes: Math.min(options.maxBytes, 4 * 1024 * 1024),
  };
  const decoded = options.cursor ? decodeCursor(options.cursor) : undefined;
  if (decoded && decoded.epoch !== head.epoch)
    throw staleCursor("cursor belongs to another session epoch");
  const before = decoded
    ? entries.findIndex((entry) => entryIdOf(entry) === decoded.beforeId)
    : entries.length;
  if (before < 0)
    throw staleCursor("cursor anchor is no longer in the session");
  const emptyPage = {
    head,
    items: [],
    checkpoint: options.checkpoint,
    hasMore: before > 0,
  };
  if (Buffer.byteLength(JSON.stringify(emptyPage), "utf8") > options.maxBytes) {
    throw Object.assign(new Error("page metadata exceeds the byte limit"), {
      code: "FILE_TOO_LARGE",
    });
  }
  const selected: JsonObject[] = [];
  const fixedBytes = Buffer.byteLength(
    JSON.stringify({
      head,
      items: [],
      checkpoint: options.checkpoint,
      hasMore: true,
    }),
  );
  let itemsBytes = 0;
  let index = before - 1;
  while (index >= 0 && selected.length < options.limit) {
    const item = projectEntryAttachments(serialize(entries[index]!), head);
    if (typeof item.id !== "string") {
      throw Object.assign(new Error("Pi session entry id is not a string"), {
        code: "NATIVE_DATA_NOT_JSON",
      });
    }
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    // base64url 的长度可直接计量；最终页才计算一次 HMAC。
    const cursorPayloadBytes =
      index > 0
        ? Buffer.byteLength(
            JSON.stringify({ v: 1, epoch: head.epoch, beforeId: item.id }),
          )
        : 0;
    const cursorLength = Math.ceil((cursorPayloadBytes * 4) / 3) + 44;
    const cursorBytes =
      index > 0
        ? Buffer.byteLength(
            JSON.stringify({ beforeCursor: "x".repeat(cursorLength) }),
          ) - 1
        : 1;
    const candidateBytes =
      fixedBytes +
      itemsBytes +
      itemBytes +
      (selected.length ? 1 : 0) +
      cursorBytes;
    if (candidateBytes > options.maxBytes) {
      if (!selected.length)
        throw Object.assign(new Error("entry exceeds the page byte limit"), {
          code: "FILE_TOO_LARGE",
        });
      break;
    }
    selected.push(item);
    itemsBytes += itemBytes + (selected.length > 1 ? 1 : 0);
    index -= 1;
  }
  const start = index + 1;
  selected.reverse();
  return {
    head,
    items: selected,
    checkpoint: options.checkpoint,
    beforeCursor:
      start > 0 && selected[0]
        ? encodeCursor({
            v: 1,
            epoch: head.epoch,
            beforeId: String(selected[0].id),
          })
        : undefined,
    hasMore: start > 0,
  };
}

export function projectEntryAttachments(
  entry: JsonObject,
  head: SessionHead,
): JsonObject {
  const message = asRecord(entry.message);
  if (!Array.isArray(message.content)) return entry;
  let changed = false;
  const content = message.content.map((value, blockIndex) => {
    const block = asRecord(value);
    if (
      block.type !== "image" ||
      typeof block.data !== "string" ||
      block.data.length <= 64 * 1024
    )
      return value;
    changed = true;
    return {
      ...block,
      data: "",
      attachment: { sessionId: head.header?.id, entryId: entry.id, blockIndex },
    };
  });
  return changed ? { ...entry, message: { ...message, content } } : entry;
}

export function imageAttachmentFromEntry(
  entry: JsonObject,
  blockIndex: number,
  offset = 0,
): JsonObject {
  const message = asRecord(entry.message);
  const content = message.content;
  if (!Array.isArray(content)) throw notFound("entry has no message content");
  const block = asRecord(content[blockIndex] as JsonValue);
  if (
    block.type !== "image" ||
    typeof block.mimeType !== "string" ||
    typeof block.data !== "string"
  ) {
    throw notFound("image block not found");
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > block.data.length ||
    offset % 4 !== 0
  ) {
    throw Object.assign(new Error("invalid attachment offset"), {
      code: "INVALID_REQUEST",
    });
  }
  const nextOffset = Math.min(block.data.length, offset + 256 * 1024);
  return {
    mimeType: block.mimeType,
    data: block.data.slice(offset, nextOffset),
    etag: imageEtag(block),
    nextOffset,
    totalChars: block.data.length,
    hasMore: nextOffset < block.data.length,
  };
}

const imageEtags = new WeakMap<JsonObject, string>();
function imageEtag(block: JsonObject): string {
  let etag = imageEtags.get(block);
  if (!etag) {
    etag = `"${createHash("sha256").update(String(block.data)).digest("hex")}"`;
    imageEtags.set(block, etag);
  }
  return etag;
}

export function beforeEntryCursor(head: SessionHead, beforeId: string): string {
  return encodeCursor({ v: 1, epoch: head.epoch, beforeId });
}

function encodeCursor(cursor: NativeCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", cursorSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(cursor: string): NativeCursor {
  try {
    const [payload, signature] = cursor.split(".");
    if (!payload || !signature) throw new Error("bad cursor");
    const expected = createHmac("sha256", cursorSecret)
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("bad cursor");
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<NativeCursor>;
    if (
      value.v !== 1 ||
      typeof value.epoch !== "string" ||
      typeof value.beforeId !== "string"
    )
      throw new Error("bad cursor");
    return value as NativeCursor;
  } catch {
    throw Object.assign(new Error("invalid pagination cursor"), {
      code: "INVALID_REQUEST",
    });
  }
}

function asRecord(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function entryIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function staleCursor(message: string): Error {
  return Object.assign(new Error(message), { code: "STALE_CURSOR" });
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: "NOT_FOUND" });
}
