import { open } from "node:fs/promises";
import {
  isJsonObject,
  jsonByteSize,
  utf8Suffix,
  type JsonObject,
} from "@ompiui/protocol";
import { getPreviewSettings } from "./preview-settings.js";
import { jsonlEntries } from "./jsonl-reader.js";
import { projectEntryAttachments, sessionHeadFromParts } from '../runtime/pagination.js';

export const SUBAGENT_PREVIEW_BYTES = 256 * 1024;
const MESSAGE_BYTES = 128 * 1024;
type PreviewCursor = { fromByte: number; nextByte: number };
export type ProjectedPreviewMessage = { message: JsonObject; truncated: boolean };

/** 游标始终指向原文件字节；过滤只发生在完整消息解析之后。 */
export async function readSubagentPreview(
  filePath: string,
  fromByte: number,
  sessionId?: string,
): Promise<JsonObject> {
  if (!Number.isSafeInteger(fromByte) || fromByte < 0)
    throw Object.assign(new Error("invalid transcript cursor"), {
      code: "INVALID_REQUEST",
    });
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    const reset = fromByte > size;
    const from = reset ? 0 : fromByte;
    let nextByte = from;
    let previewTruncated = false;
    let incomplete = false;
    const messages: JsonObject[] = [];
    const settings = getPreviewSettings();
    const head = sessionHeadFromParts({ sdkVersion: '', revision: 0, header: { id: sessionId }, leafId: null, entryCount: 0 });
    // false 和文件末尾游标占用最多字节；正文、逗号之外的完整页封装只计量一次。
    let bytes = jsonByteSize(
      {
        messages: [],
        fromByte: from,
        nextByte: size,
        reset,
        hasMore: false,
        settingsRevision: settings.revision,
        previewTruncated: false,
      },
      SUBAGENT_PREVIEW_BYTES,
    );
    if (bytes > SUBAGENT_PREVIEW_BYTES)
      throw Object.assign(new Error("Subagent preview metadata exceeds 256 KiB"), {
        code: "FILE_TOO_LARGE",
      });
    for await (const line of jsonlEntries(file, from, size)) {
      if (!line.newline && !line.valid) {
        incomplete = true;
        break;
      }
      const entry = line.entry;
      let message: JsonObject | undefined;
      if (
        isJsonObject(entry) &&
        entry.type === "message" &&
        isJsonObject(entry.message)
      ) {
        let projected: ProjectedPreviewMessage;
        try {
          const imageMessage = projectEntryAttachments(entry, head).message;
          projected = projectPreviewMessage(isJsonObject(imageMessage) ? imageMessage : entry.message, settings.subagentThinking, {
            fromByte: nextByte,
            nextByte: nextByte + line.bytes,
          });
        } catch (error) {
          if (!messages.length || !(error instanceof Error) ||
              !("code" in error) || error.code !== "FILE_TOO_LARGE") throw error;
          break;
        }
        const length = jsonByteSize(projected.message, SUBAGENT_PREVIEW_BYTES) +
          (messages.length ? 1 : 0);
        if (bytes + length > SUBAGENT_PREVIEW_BYTES) {
          if (!messages.length)
            throw Object.assign(new Error("Subagent preview entry exceeds 256 KiB"), {
              code: "FILE_TOO_LARGE",
              details: { fromByte: nextByte, nextByte: nextByte + line.bytes, limitBytes: SUBAGENT_PREVIEW_BYTES },
            });
          break;
        }
        message = projected.message;
        previewTruncated ||= projected.truncated;
        bytes += length;
      }
      nextByte += line.bytes;
      if (message) messages.push(message);
      if (
        bytes >= SUBAGENT_PREVIEW_BYTES ||
        messages.length >= 200 ||
        nextByte - from >= 2 * 1024 * 1024
      )
        break;
    }
    return {
      messages,
      fromByte: from,
      nextByte,
      reset,
      hasMore: nextByte < size && !incomplete,
      settingsRevision: settings.revision,
      previewTruncated,
    };
  } finally {
    await file.close();
  }
}

export function projectPreviewMessage(
  message: JsonObject,
  thinking: boolean,
  cursor?: PreviewCursor,
): ProjectedPreviewMessage {
  const content: JsonObject[] = [];
  const projected: JsonObject = {
    role: message.role,
    content: typeof message.content === "string" ? "" : content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    stopReason: message.stopReason,
    isError: message.isError,
  };
  let metadataBytes = jsonByteSize(projected, MESSAGE_BYTES);
  if (metadataBytes > MESSAGE_BYTES) throw metadataLimit(cursor);
  // 先为所有保留字段预留编码空间，文本不得挤掉或截断工具关联 ID。
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isJsonObject(block) || (block.type === "thinking" && !thinking)) continue;
      const field = block.type === "thinking" ? "thinking" : block.type === "text" ? "text" : undefined;
      let item: JsonObject;
      if (block.type === "toolCall") {
        item = { type: "toolCall", id: block.id, name: block.name };
      } else if (field && typeof block[field] === "string") {
        item = { type: block.type, [field]: "" };
      } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        item = block;
      } else {
        continue;
      }
      metadataBytes += jsonByteSize(item, MESSAGE_BYTES) + (content.length ? 1 : 0);
      if (metadataBytes > MESSAGE_BYTES) throw metadataLimit(cursor);
      if (field) item[field] = block[field];
      content.push(item);
    }
  }
  const collectDetailImages = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collectDetailImages); return; }
    const block = value as JsonObject;
    if (typeof block.data === 'string' && typeof block.mimeType === 'string' && block.mimeType.startsWith('image/')) {
      const item = { ...block, type: 'image' };
      metadataBytes += jsonByteSize(item, MESSAGE_BYTES) + (content.length ? 1 : 0);
      if (metadataBytes > MESSAGE_BYTES) throw metadataLimit(cursor);
      content.push(item);
      projected.content = content;
      return;
    }
    Object.values(block).forEach(collectDetailImages);
  };
  collectDetailImages(message.details);
  if (typeof message.content === 'string' && content.length) {
    metadataBytes += jsonByteSize({ type: 'text', text: '' }, MESSAGE_BYTES) + 1;
    if (metadataBytes > MESSAGE_BYTES) throw metadataLimit(cursor);
  }
  let remaining = MESSAGE_BYTES - metadataBytes;
  let truncated = false;
  if (typeof message.content === "string") {
    const text = encodedPreviewText(message.content, remaining);
    projected.content = content.length ? [{ type: 'text', text: text.value }, ...content] : text.value;
    truncated = text.value.length < message.content.length;
  } else {
    for (const block of content) {
      const field = block.type === "thinking" ? "thinking" : block.type === "text" ? "text" : undefined;
      if (!field || typeof block[field] !== "string") continue;
      const original = block[field];
      const tail = field === "thinking";
      const text = encodedPreviewText(
        tail ? utf8Suffix(original, 2048) : original,
        Math.min(tail ? remaining : 64 * 1024, remaining),
        tail,
      );
      block[field] = text.value;
      remaining -= text.bytes;
      truncated ||= text.value.length < original.length;
    }
  }
  return { message: projected, truncated };
}

function metadataLimit(cursor?: PreviewCursor): Error {
  return Object.assign(new Error("Subagent preview metadata exceeds 128 KiB; identifiers cannot be truncated"), {
    code: "FILE_TOO_LARGE",
    details: { ...cursor, limitBytes: MESSAGE_BYTES },
  });
}

/** 计入 JSON 转义，且前缀/思考尾部均不拆开 UTF-16 代理对。 */
function encodedPreviewText(text: string, maxBytes: number, suffix = false): { value: string; bytes: number } {
  let start = suffix ? text.length : 0;
  let end = start;
  let bytes = 0;
  while (suffix ? start > 0 : end < text.length) {
    let index = suffix ? start - 1 : end;
    if (suffix && index > 0 && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff &&
        text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff) index--;
    const point = text.codePointAt(index)!;
    const cost = point < 0x20
      ? (point === 8 || point === 9 || point === 10 || point === 12 || point === 13 ? 2 : 6)
      : point === 0x22 || point === 0x5c ? 2
      : point <= 0x7f ? 1
      : point <= 0x7ff ? 2
      : point >= 0xd800 && point <= 0xdfff ? 6
      : point <= 0xffff ? 3 : 4;
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    if (suffix) start = index;
    else end += point > 0xffff ? 2 : 1;
  }
  return { value: text.slice(start, end), bytes };
}
