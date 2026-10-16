import { createHash } from "node:crypto"
import type { JsonObject } from "@ompiui/protocol"

type EncodedEntry = { text: string; etag: string; bytes: number }
const snapshots = new Map<string, EncodedEntry>()
const identities = new WeakMap<JsonObject, string>()
let retainedBytes = 0
const MAX_CONTENT_BYTES = 64 * 1024 * 1024

function encoded(entry: JsonObject, projected: JsonObject): EncodedEntry {
  const identity = identities.get(entry)
  const cached = identity ? snapshots.get(identity) : undefined
  if (cached) {
    snapshots.delete(identity!)
    snapshots.set(identity!, cached)
    return cached
  }
  const text = JSON.stringify(projected, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))
  })
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_CONTENT_BYTES)
    throw Object.assign(new Error("entry content exceeds the read limit"), { code: "FILE_TOO_LARGE" })
  const value = { text, bytes, etag: createHash("sha256").update(text).digest("hex") }
  identities.set(entry, value.etag)
  const previous = snapshots.get(value.etag)
  snapshots.delete(value.etag)
  if (previous) retainedBytes -= previous.bytes
  snapshots.set(value.etag, value)
  retainedBytes += bytes
  for (const [key, item] of snapshots) {
    if (snapshots.size <= 2 && retainedBytes <= MAX_CONTENT_BYTES) break
    snapshots.delete(key)
    retainedBytes -= item.bytes
  }
  return value
}

export function entryContentReference(entry: JsonObject, projected: JsonObject): JsonObject {
  const value = encoded(entry, projected)
  return {
    type: "ompiui.entry_ref", id: entry.id,
    parentId: entry.parentId ?? null, timestamp: entry.timestamp ?? "",
    contentRef: { etag: value.etag, totalChars: value.text.length },
  }
}

export function entryContentChunk(entry: JsonObject, projected: JsonObject, offset: number, etag?: string): JsonObject {
  const value = encoded(entry, projected)
  if (etag && etag !== value.etag)
    throw Object.assign(new Error("entry changed during content read"), { code: "STALE_REVISION" })
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.text.length)
    throw Object.assign(new Error("invalid entry content offset"), { code: "INVALID_REQUEST" })
  let nextOffset = Math.min(value.text.length, offset + 64 * 1024)
  if (nextOffset < value.text.length && value.text.charCodeAt(nextOffset) >= 0xdc00 && value.text.charCodeAt(nextOffset) <= 0xdfff)
    nextOffset--
  return {
    entryId: entry.id, etag: value.etag, offset, nextOffset,
    totalChars: value.text.length, content: value.text.slice(offset, nextOffset),
    hasMore: nextOffset < value.text.length,
  }
}
