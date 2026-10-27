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
import { entryContentReference } from "./entry-content.js";
import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import path from "node:path";
import { nativeOmpSessionsRoot } from "../omp/omp-directories.js";

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
  try {
    return buildEntriesPage(head, entries, options, serialize);
  } catch (error) {
    if (!options.checkpoint?.liveMessage || !error || typeof error !== "object" ||
      !("code" in error) || error.code !== "FILE_TOO_LARGE") throw error;
    return buildEntriesPage(head, entries, {
      ...options,
      checkpoint: { ...options.checkpoint, liveMessage: undefined, liveMessageOmitted: true },
    }, serialize);
  }
}

function buildEntriesPage<T>(
  head: SessionHead,
  entries: readonly T[],
  options: { cursor?: string; limit: number; maxBytes: number; checkpoint?: BranchCheckpoint },
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
    const source = serialize(entries[index]!);
    let item = projectEntryAttachments(source, head);
    if (typeof item.id !== "string") {
      throw Object.assign(new Error("Pi session entry id is not a string"), {
        code: "NATIVE_DATA_NOT_JSON",
      });
    }
    let itemBytes = Buffer.byteLength(JSON.stringify(item));
    const referenced = itemBytes > 4 * 1024 * 1024 - 64 * 1024;
    if (referenced) {
      if (selected.length) break;
      item = entryContentReference(source, item);
      itemBytes = Buffer.byteLength(JSON.stringify(item));
    }
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
    // A normal native task aggregate can exceed the requested 128 KiB page
    // while remaining well below the absolute entry limit. Reference that
    // entry instead of stopping after a newer final message and losing its
    // owner/results from the refreshed window. Count metadata and cursor too.
    if (!referenced && itemBytes + fixedBytes + cursorBytes > options.maxBytes) {
      item = entryContentReference(source, item);
      itemBytes = Buffer.byteLength(JSON.stringify(item));
    }
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
    if (referenced) break;
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

export function projectEntryAttachments(entry: JsonObject, head: SessionHead): JsonObject {
  const message = asRecord(entry.message);
  let changed = false;
  const project = (value: JsonValue, blockIndex: number, source: "content" | "details"): JsonValue => {
    const block = asRecord(value);
    if (typeof block.data !== "string" || !isImageBlock(block) ||
      (!block.data.startsWith("blob:sha256:") && block.data.length <= 64 * 1024)) return value;
    changed = true;
    const hash = /^blob:sha256:([a-f0-9]{64})$/.exec(block.data)?.[1];
    return { ...block, data: "", attachment: { sessionId: head.header?.id, entryId: entry.id, blockIndex, source, epoch: head.epoch, etag: hash ? `"${hash}"` : imageEtag(block) } };
  };
  const content = Array.isArray(message.content)
    ? message.content.map((value, index) => project(value, index, "content")) : message.content;
  let detailIndex = 0;
  const projectDetails = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(projectDetails);
    if (!value || typeof value !== "object") return value;
    if (isImageBlock(value)) return project(value, detailIndex++, "details");
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) result[key] = child === undefined ? undefined : projectDetails(child);
    return result;
  };
  const details = message.details === undefined ? undefined : projectDetails(message.details);
  return changed ? { ...entry, message: { ...message, content, ...(details === undefined ? {} : { details }) } } : entry;
}

function isImageBlock(value: JsonObject): boolean {
  return typeof value.data === "string" && typeof value.mimeType === "string" &&
    (value.type === "image" || value.mimeType.startsWith("image/"));
}

function detailImage(value: JsonValue | undefined, index: number): JsonObject | undefined {
  let seen = 0;
  const visit = (node: JsonValue | undefined): JsonObject | undefined => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && isImageBlock(node)) return seen++ === index ? node : undefined;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      const found = visit(child);
      if (found) return found;
    }
  };
  return visit(value);
}

export function imageAttachmentFromEntry(
  entry: JsonObject,
  blockIndex: number,
  offset = 0,
  source: "content" | "details" = "content",
): JsonObject {
  if (source !== 'content' && source !== 'details') throw Object.assign(new Error('invalid attachment source'), { code: 'INVALID_REQUEST' });
  const message = asRecord(entry.message);
  const block = source === "details" ? detailImage(message.details, blockIndex)
    : Array.isArray(message.content) ? asRecord(message.content[blockIndex]) : undefined;
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0 || !block || !isImageBlock(block)) throw notFound("image block not found");
  const data = String(block.data);
  const hash = /^blob:sha256:([a-f0-9]{64})$/.exec(data)?.[1];
  if (data.startsWith("blob:sha256:") && !hash) throw notFound("invalid image blob reference");
  let descriptor: number | undefined;
  try {
    if (hash) {
      try { descriptor = openSync(path.join(path.dirname(nativeOmpSessionsRoot()), "blobs", hash), "r"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound("image blob not found");
        throw error;
      }
    }
    const stat = descriptor === undefined ? undefined : fstatSync(descriptor);
    if (stat && !stat.isFile()) throw notFound("image blob is not a file");
    const size = stat?.size;
    const totalChars = size === undefined ? data.length : Math.ceil(size / 3) * 4;
    if (!Number.isSafeInteger(totalChars) || totalChars > 64 * 1024 * 1024) {
      throw Object.assign(new Error("Image exceeds 64 MiB preview limit"), { code: "FILE_TOO_LARGE" });
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalChars || offset % 4 !== 0) {
      throw Object.assign(new Error("invalid attachment offset"), { code: "INVALID_REQUEST" });
    }
    const nextOffset = Math.min(totalChars, offset + 256 * 1024);
    let chunk: string;
    if (descriptor === undefined) chunk = data.slice(offset, nextOffset);
    else {
      const byteOffset = offset / 4 * 3;
      const bytes = Buffer.allocUnsafe(Math.max(0, Math.min(size! - byteOffset, (nextOffset - offset) / 4 * 3)));
      let read = 0;
      while (read < bytes.length) {
        const count = readSync(descriptor, bytes, read, bytes.length - read, byteOffset + read);
        if (count === 0) throw notFound("image blob was truncated while reading");
        read += count;
      }
      chunk = bytes.toString("base64");
    }
    const revision = stat ? JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]) : undefined;
    if (descriptor !== undefined) {
      const after = fstatSync(descriptor);
      if (revision !== JSON.stringify([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs])) throw notFound("image blob changed while reading");
    }
    return { mimeType: String(block.mimeType), data: chunk, etag: hash ? `"${hash}"` : imageEtag(block), ...(revision ? { revision } : {}), nextOffset, totalChars, hasMore: nextOffset < totalChars };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
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
