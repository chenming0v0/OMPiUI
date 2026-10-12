import { open } from "node:fs/promises";
import {
  isJsonObject,
  utf8Prefix,
  utf8Suffix,
  type JsonObject,
} from "@ompiui/protocol";
import { getPreviewSettings } from "./preview-settings.js";
import { jsonlEntries } from "./jsonl-reader.js";

/** 游标始终指向原文件字节；过滤只发生在完整消息解析之后。 */
export async function readSubagentPreview(
  filePath: string,
  fromByte: number,
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
    let bytes = 0;
    let previewTruncated = false;
    let incomplete = false;
    const messages: JsonObject[] = [];
    const settings = getPreviewSettings();
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
        const projected = projectPreviewMessage(
          entry.message,
          settings.subagentThinking,
        );
        message = projected.message;
        previewTruncated ||= projected.truncated;
        const length = Buffer.byteLength(JSON.stringify(message));
        if (messages.length && bytes + length > 256 * 1024) break;
        bytes += length;
      }
      nextByte += line.bytes;
      if (message) messages.push(message);
      if (
        bytes >= 256 * 1024 ||
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
): { message: JsonObject; truncated: boolean } {
  let truncated = false;
  let used = 0;
  const content =
    typeof message.content === "string"
      ? utf8Prefix(message.content, 128 * 1024)
      : Array.isArray(message.content)
        ? message.content.filter(isJsonObject).flatMap((block) => {
            if (used >= 128 * 1024) {
              truncated = true;
              return [];
            }
            if (block.type === "thinking" && !thinking) return [];
            if (block.type === "image") return [];
            if (block.type === "toolCall")
              return [
                {
                  type: "toolCall",
                  id: block.id,
                  name: block.name,
                } as JsonObject,
              ];
            const field =
              block.type === "thinking"
                ? "thinking"
                : block.type === "text"
                  ? "text"
                  : undefined;
            if (!field || typeof block[field] !== "string") return [];
            const text =
              field === "thinking"
                ? utf8Suffix(block[field], 2048)
                : utf8Prefix(
                    block[field],
                    Math.min(64 * 1024, 128 * 1024 - used),
                  );
            truncated ||= text.length < block[field].length;
            used += Buffer.byteLength(text);
            return [{ type: block.type, [field]: text } as JsonObject];
          })
        : [];
  if (typeof content === "string" && content !== message.content)
    truncated = true;
  return {
    message: {
      role: message.role,
      content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      stopReason: message.stopReason,
      isError: message.isError,
    },
    truncated,
  };
}
