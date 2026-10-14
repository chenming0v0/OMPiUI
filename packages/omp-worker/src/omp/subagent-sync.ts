import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  isJsonObject,
  jsonByteSize,
  subagentBlockHash,
  subagentDigest,
  type JsonObject,
  type SubagentDataBlock,
  type SubagentSyncRequest,
  type SubagentSyncPage,
} from "@ompiui/protocol";
import { jsonlEntries } from "./jsonl-reader.js";
import { getPreviewSettings } from "./preview-settings.js";
import {
  projectPreviewMessage,
  SUBAGENT_PREVIEW_BYTES,
  type ProjectedPreviewMessage,
} from "./subagent-preview.js";

const BLOCK_BYTES = 256 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const cache = new Map<
  string,
  { block: SubagentDataBlock; bytes: number; incomplete: boolean }
>();
let cachedBytes = 0;

function snapshotFor(
  filePath: string,
  stat: Stats,
  projection: string,
): string {
  return subagentDigest({
    filePath,
    projection,
    size: stat.size,
    modified: stat.mtimeMs,
    changed: stat.ctimeMs,
    inode: stat.ino,
  });
}

function expired(): Error {
  return Object.assign(
    new Error("Subagent history changed during pagination"),
    {
      code: "SYNC_SNAPSHOT_EXPIRED",
    },
  );
}

async function readBlock(
  file: FileHandle,
  fromByte: number,
  size: number,
  projection: string,
  thinking: boolean,
  messageBytes: number,
): Promise<{ block: SubagentDataBlock; bytes: number; incomplete: boolean }> {
  const messages: JsonObject[] = [];
  let nextByte = fromByte;
  let bytes = 2;
  let previewTruncated = false;
  let incomplete = false;
  for await (const line of jsonlEntries(file, fromByte, size)) {
    // 只有换行封闭的记录才稳定，正在写入的尾行留给下一轮读取。
    if (!line.newline) {
      incomplete = true;
      break;
    }
    if (
      isJsonObject(line.entry) &&
      line.entry.type === "message" &&
      isJsonObject(line.entry.message)
    ) {
      let projected: ProjectedPreviewMessage;
      try {
        projected = projectPreviewMessage(line.entry.message, thinking, {
          fromByte: nextByte,
          nextByte: nextByte + line.bytes,
        });
      } catch (error) {
        if (!messages.length || !(error instanceof Error) ||
            !("code" in error) || error.code !== "FILE_TOO_LARGE") throw error;
        break;
      }
      const length = jsonByteSize(projected.message, messageBytes) + (messages.length ? 1 : 0);
      if (bytes + length > messageBytes) {
        if (!messages.length)
          throw Object.assign(new Error("Subagent preview entry exceeds 256 KiB"), {
            code: "FILE_TOO_LARGE",
            details: { fromByte: nextByte, nextByte: nextByte + line.bytes, limitBytes: SUBAGENT_PREVIEW_BYTES },
          });
        break;
      }
      messages.push(projected.message);
      bytes += length;
      previewTruncated ||= projected.truncated;
    }
    nextByte += line.bytes;
    if (nextByte - fromByte >= BLOCK_BYTES || messages.length >= 200) break;
  }
  const body = { fromByte, nextByte, messages, previewTruncated };
  const block: SubagentDataBlock = { ...body, kind: "data", hash: subagentBlockHash(projection, body) };
  return {
    block,
    bytes: jsonByteSize(block, SUBAGENT_PREVIEW_BYTES),
    incomplete,
  };
}

/** 只读原生文件；快照绑定文件状态，重写、截短和分页途中追加均不能混入旧页。 */
export async function readSubagentSync(
  filePath: string,
  fromByte: number,
  sync: SubagentSyncRequest,
): Promise<JsonObject> {
  if (!Number.isSafeInteger(fromByte) || fromByte < 0)
    throw Object.assign(new Error("invalid transcript cursor"), {
      code: "INVALID_REQUEST",
    });
  const settings = getPreviewSettings();
  const projection = `subagent-preview-v2:thinking-${settings.subagentThinking ? "on" : "off"}`;
  const file = await open(filePath, "r");
  try {
    const stat = await file.stat();
    const snapshot = snapshotFor(filePath, stat, projection);
    if (sync.snapshot && sync.snapshot !== snapshot) throw expired();
    const reset = fromByte > stat.size;
    let position = reset ? 0 : fromByte;
    const start = position;
    const blocks: SubagentSyncPage["blocks"] = [];
    // 为完整页和块封装预留空间；使用最大游标宽度以保持追加前后的块边界稳定。
    const envelopeBytes = jsonByteSize({
      syncVersion: 1, snapshot, projection, blocks: [],
      fromByte: Number.MAX_SAFE_INTEGER, nextByte: Number.MAX_SAFE_INTEGER,
      reset: false, hasMore: false,
    }, SUBAGENT_PREVIEW_BYTES);
    const blockEnvelopeBytes = jsonByteSize({
      kind: "data", hash: snapshot, messages: [], previewTruncated: false,
      fromByte: Number.MAX_SAFE_INTEGER, nextByte: Number.MAX_SAFE_INTEGER,
    }, SUBAGENT_PREVIEW_BYTES);
    const messageBytes = SUBAGENT_PREVIEW_BYTES - envelopeBytes - blockEnvelopeBytes + 2;
    let sentBytes = envelopeBytes;
    let incomplete = false;
    const known = new Map(
      sync.knownBlocks.map((block) => [block.fromByte, block]),
    );
    while (position < stat.size && blocks.length < 32) {
      const key = `${snapshot}:${position}`;
      let cached = cache.get(key);
      if (!cached) {
        try {
          cached = await readBlock(
            file,
            position,
            stat.size,
            projection,
            settings.subagentThinking,
            messageBytes,
          );
        } catch (error) {
          if (!blocks.length || !(error instanceof Error) ||
              !("code" in error) || error.code !== "FILE_TOO_LARGE") throw error;
          break;
        }
        cachedBytes -= cache.get(key)?.bytes ?? 0;
        cache.set(key, cached);
        cachedBytes += cached.bytes;
        while (
          (cachedBytes > CACHE_BYTES || cache.size > 512) &&
          cache.size > 1
        ) {
          const oldest = cache.keys().next().value!;
          cachedBytes -= cache.get(oldest)!.bytes;
          cache.delete(oldest);
        }
      } else {
        cache.delete(key);
        cache.set(key, cached);
      }
      const { block, bytes } = cached;
      if (block.nextByte === position) {
        incomplete = cached.incomplete;
        break;
      }
      const match = known.get(position);
      const reuse =
        match?.nextByte === block.nextByte && match.hash === block.hash;
      const ref = reuse
        ? {
            kind: "reuse" as const,
            fromByte: block.fromByte,
            nextByte: block.nextByte,
            hash: block.hash,
            previewTruncated: block.previewTruncated,
          }
        : block;
      const length = (reuse ? jsonByteSize(ref, SUBAGENT_PREVIEW_BYTES) : bytes) + (blocks.length ? 1 : 0);
      if (sentBytes + length > SUBAGENT_PREVIEW_BYTES) {
        if (!blocks.length)
          throw Object.assign(new Error("Subagent preview block exceeds 256 KiB"), {
            code: "FILE_TOO_LARGE",
            details: { fromByte: block.fromByte, nextByte: block.nextByte, limitBytes: SUBAGENT_PREVIEW_BYTES },
          });
        break;
      }
      blocks.push(ref);
      sentBytes += length;
      position = block.nextByte;
      incomplete = cached.incomplete;
      if (incomplete || sentBytes >= SUBAGENT_PREVIEW_BYTES) break;
    }
    if (snapshotFor(filePath, await file.stat(), projection) !== snapshot)
      throw expired();
    return {
      syncVersion: 1,
      snapshot,
      projection,
      blocks,
      fromByte: start,
      nextByte: position,
      reset,
      hasMore: position < stat.size && !incomplete,
    };
  } finally {
    await file.close();
  }
}
