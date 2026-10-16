import {
  isJsonObject,
  utf8Prefix,
  utf8Suffix,
  type JsonObject,
} from "@ompiui/protocol";
import { getPreviewSettings } from "./preview-settings.js";
import { base64Bytes } from "@ompiui/protocol";

/** 状态仅展示大图元数据；原图留在运行时，显式编辑操作仍返回完整附件。 */
export function projectStateImages(value: JsonObject): JsonObject {
  if (!Array.isArray(value.images)) return value;
  const images = value.images.filter(isJsonObject).map(image =>
    typeof image.data === "string" && image.data.length > 64 * 1024
      ? { ...image, data: "", dataOmitted: true, byteLength: base64Bytes(image.data) }
      : { ...image },
  );
  return { ...value, images };
}

/** 主时间线只裁剪流式更新的未消费字段；开始、结束及落盘结果保持完整。 */
export function projectToolUpdate(event: JsonObject): JsonObject {
  if (event.type === "message_update") {
    // 前端只消费 message；SDK 增量事件的 partial 会再次携带同一份累计快照。
    const { assistantMessageEvent: _unused, ...projected } = event;
    return projected;
  }
  if (event.type !== "tool_execution_update") return event;
  const projected = { ...event };
  delete projected.args;
  if (isJsonObject(event.partialResult)) {
    const content = event.partialResult.content;
    if (Array.isArray(content)) {
      const blocks = content.filter(isJsonObject).filter(
        (block) => block.type === "text" && typeof block.text === "string",
      );
      let text = "";
      for (let index = blocks.length - 1; index >= 0; index--) {
        text = utf8Suffix(String(blocks[index]!.text), 256 * 1024) + text;
        text = utf8Suffix(text, 256 * 1024);
        if (Buffer.byteLength(text) >= 256 * 1024) break;
      }
      projected.partialResult = { content: [{ type: "text", text }] };
    } else projected.partialResult = { content };
  }
  return projected;
}

// 对齐前端 normalizeProgress；身份字段仍用于恢复和多子代理分流。
const PROGRESS_FIELDS = [
  "id",
  "index",
  "status",
  "currentTool",
  "currentToolArgs",
  "currentToolStartMs",
  "recentTools",
  "recentOutput",
  "toolCount",
  "requests",
  "tokens",
  "contextTokens",
  "contextWindow",
  "cost",
  "durationMs",
  "resolvedModel",
  "lastIntent",
] as const;

export function projectSubagentPayload(
  kind: string,
  payload: JsonObject,
): JsonObject {
  if (kind === "event" && isJsonObject(payload.event)) {
    const raw = payload.event;
    let event: JsonObject = { type: raw.type };
    if (raw.type === "irc_message" && isJsonObject(raw.message)) {
      const details = isJsonObject(raw.message.details)
        ? raw.message.details
        : undefined;
      const from = typeof details?.from === "string" ? details.from : "agent";
      const text = typeof details?.message === "string" ? details.message : "";
      event.message = { role: "agent", content: `${from}: ${text}` };
    } else if (isJsonObject(raw.message)) {
      const message = raw.message;
      const content = Array.isArray(message.content)
        ? message.content.filter(isJsonObject).flatMap((block) => {
            if (block.type === "text")
              return [{ type: "text", text: block.text } as JsonObject];
            if (
              block.type === "thinking" &&
              getPreviewSettings().subagentThinking
            )
              return [
                { type: "thinking", thinking: block.thinking } as JsonObject,
              ];
            if (block.type === "toolCall")
              return [
                {
                  type: "toolCall",
                  id: block.id,
                  name: block.name,
                  title:
                    typeof block.title === "string"
                      ? block.title.slice(0, 512)
                      : undefined,
                } as JsonObject,
              ];
            return [];
          })
        : message.content;
      event.message = {
        role: message.role,
        id: message.id,
        content:
          message.role === "assistant" || message.role === "user"
            ? content
            : undefined,
        stopReason: message.stopReason,
      };
      if (raw.messageId !== undefined) event.messageId = raw.messageId;
    } else if (
      raw.type === "tool_execution_start" ||
      raw.type === "tool_execution_end" ||
      raw.type === "tool_execution_update"
    ) {
      // 内联预览只显示工具徽标；参数、结果和图片从原生子会话按需读取。
      for (const key of ["toolCallId", "toolName", "title", "isError"]) {
        if (raw[key] !== undefined)
          event[key] =
            typeof raw[key] === "string" ? raw[key].slice(0, 512) : raw[key];
      }
    } else {
      event = { type: raw.type };
    }
    return { id: payload.id, event };
  }
  if (kind !== "progress" || !isJsonObject(payload.progress)) return payload;
  const progress: JsonObject = {};
  for (const key of PROGRESS_FIELDS) {
    if (payload.progress[key] !== undefined)
      progress[key] = payload.progress[key];
  }
  for (const key of ["currentToolArgs", "lastIntent"]) {
    if (typeof progress[key] === "string")
      progress[key] = utf8Prefix(progress[key], 512);
  }
  if (Array.isArray(progress.recentOutput)) {
    progress.recentOutput = progress.recentOutput
      .slice(-12)
      .map((line) => utf8Suffix(String(line), 1024));
  }
  if (Array.isArray(progress.recentTools)) {
    progress.recentTools = progress.recentTools
      .slice(-12)
      .filter(isJsonObject)
      .map((tool) => ({
        tool: tool.tool,
        endMs: tool.endMs,
        args:
          typeof tool.args === "string"
            ? utf8Prefix(tool.args, 512)
            : undefined,
      }));
  }
  // 工具结果通过最终事件和原生历史提供，不在进度及 state.get 中再次嵌套。
  const projected: JsonObject = { progress };
  for (const key of [
    "id",
    "index",
    "parentToolCallId",
    "sessionFile",
    "agent",
    "description",
    "task",
    "assignment",
    "detached",
  ]) {
    if (payload[key] !== undefined)
      projected[key] =
        typeof payload[key] === "string" &&
        (key === "task" || key === "assignment" || key === "description")
          ? utf8Prefix(payload[key], 2048)
          : payload[key];
  }
  return projected;
}
