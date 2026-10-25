import { randomUUID } from "node:crypto";
import { isJsonObject, jsonByteSize, splitUtf8Text, type JsonObject } from "@ompiui/protocol";
import { getPreviewSettings } from "./preview-settings.js";
import { PausableFrameQueue } from "./pausable-frame-queue.js";

const CHUNK_BYTES = 4096;
const RECOVERY_CHARS = 2048;

type MessageState = {
  id: string;
  sourceId?: string;
  text: string;
  tools: string;
  thinking?: string;
  thinkingEnabled: boolean;
};

/** 合并快照后再计算增量；短尾部供新订阅者恢复预览，不重发累计正文。 */
export class SubagentMessageStream {
  private readonly delivery: PausableFrameQueue<JsonObject>;
  private readonly messages = new Map<string, MessageState>();
  private readonly progress = new Map<
    string,
    { snapshot: JsonObject; fullAt: number }
  >();

  constructor(
    emit: (event: JsonObject) => void,
    private readonly thinkingEnabled: () => boolean = () =>
      getPreviewSettings().subagentThinking,
  ) { this.delivery = new PausableFrameQueue(emit); }

  push(frame: JsonObject): void {
    this.delivery.push(this.frames(frame), () => jsonByteSize(frame, 64 * 1024 * 1024));
  }

  setPaused(paused: boolean): void { this.delivery.setPaused(paused); }

  private *frames(frame: JsonObject): Generator<JsonObject> {
    const payload = isJsonObject(frame.payload) ? frame.payload : undefined;
    const event = isJsonObject(payload?.event) ? payload.event : undefined;
    const message = isJsonObject(event?.message) ? event.message : undefined;
    const scope = typeof payload?.id === "string" ? payload.id : "";
    const generationScope = typeof payload?.runId === "string" ? `${scope}\0${payload.runId}` : scope;
    if (frame.kind === "progress" && scope && isJsonObject(payload?.progress)) {
      const previous = this.progress.get(generationScope);
      const full = !previous || Date.now() - previous.fullAt >= 5000;
      const delta: JsonObject = {};
      for (const key of new Set([
        ...Object.keys(previous?.snapshot ?? {}),
        ...Object.keys(payload.progress),
      ])) {
        if (
          full ||
          JSON.stringify(previous?.snapshot[key]) !==
            JSON.stringify(payload.progress[key])
        )
          delta[key] = payload.progress[key] ?? null;
      }
      this.progress.set(generationScope, {
        snapshot: payload.progress,
        fullAt: full ? Date.now() : previous!.fullAt,
      });
      if (Object.keys(delta).length)
        yield {
          ...frame,
          eventId: randomUUID(),
          payload: { ...payload, progress: delta, progressDelta: !full },
        };
      return;
    }
    const phase = event?.type === "irc_message" ? "message_end" : event?.type;
    if (
      !scope ||
      !event ||
      !message ||
      (message.role !== "assistant" &&
        message.role !== "user" &&
        message.role !== "agent") ||
      (phase !== "message_start" &&
        phase !== "message_update" &&
        phase !== "message_end")
    ) {
      yield { ...frame, eventId: randomUUID() };
      if (
        frame.kind === "lifecycle" &&
        (payload?.status === "completed" ||
          payload?.status === "failed" ||
          payload?.status === "aborted")
      ) {
        this.messages.delete(generationScope);
        this.messages.delete(`${generationScope}\0irc`);
        this.progress.delete(generationScope);
      }
      return;
    }

    // IRC 消息可以插进正在生成的回复，不能改变该回复的增量身份与偏移。
    const key = message.role === "agent" ? `${generationScope}\0irc` : generationScope;
    const previous = this.messages.get(key);
    const nativeId =
      typeof event.messageId === "string"
        ? event.messageId
        : typeof message.id === "string"
          ? message.id
          : undefined;
    const same =
      previous &&
      phase !== "message_start" &&
      (!nativeId || previous.sourceId === nativeId);
    const id = same ? previous.id : randomUUID();
    const content = Array.isArray(message.content)
      ? message.content.filter(isJsonObject)
      : [];
    const snapshotText =
      typeof message.content === "string"
        ? message.content
        : content
            .filter((block) => block.type === "text")
            .map((block) => String(block.text ?? ""))
            .join("\n");
    const failedEnd =
      phase === "message_end" &&
      (message.stopReason === "error" || message.stopReason === "aborted");
    const text =
      same && failedEnd && !snapshotText ? previous.text : snapshotText;
    const thinkingEnabled = this.thinkingEnabled();
    const thinking = thinkingEnabled
      ? content
          .filter((block) => block.type === "thinking")
          .map((block) => String(block.thinking ?? ""))
          .join("\n")
          .slice(-RECOVERY_CHARS)
      : undefined;
    const tools = content.filter((block) => block.type === "toolCall");
    const toolSnapshot = JSON.stringify(tools);
    const toolsChanged = !same || toolSnapshot !== previous.tools;
    const thinkingChanged = !same || thinking !== previous.thinking || thinkingEnabled !== previous.thinkingEnabled;
    if (
      same &&
      phase === "message_update" &&
      text === previous.text &&
      !toolsChanged &&
      !thinkingChanged
    )
      return;
    // 非追加式修订从零替换；普通 token 流只传上次已发送长度之后的内容。
    const offset =
      same && text.startsWith(previous.text) ? previous.text.length : 0;
    let position = offset;
    for (const delta of splitUtf8Text(text.slice(offset), CHUNK_BYTES).concat(
      text.length === offset ? [""] : [],
    )) {
      const end = position + delta.length;
      const last = end === text.length;
      let tailOffset = Math.max(0, end - RECOVERY_CHARS);
      const tailStart = text.charCodeAt(tailOffset);
      if (tailStart >= 0xdc00 && tailStart <= 0xdfff) tailOffset++;
      yield {
        kind: frame.kind,
        eventId: randomUUID(),
        payload: {
          ...payload,
          id: scope,
          event: {
            type: "message_patch",
            messageId: id,
            role: message.role,
            phase: last ? phase : "message_update",
            textOffset: position,
            textDelta: text.slice(position, end),
            ...(last && (offset === 0 || phase === "message_end")
              ? {
                  textTailOffset: tailOffset,
                  textTail: text.slice(tailOffset, end),
                }
              : {}),
            ...(last
              ? {
                  ...(thinkingChanged || phase === "message_end" ? { thinking, thinkingEnabled } : {}),
                  ...(toolsChanged || phase === "message_end" ? { tools } : {}),
                }
              : {}),
          },
        },
      };
      position = end;
    }
    if (phase === "message_end") this.messages.delete(key);
    else
      this.messages.set(key, {
        id,
        sourceId: nativeId,
        text,
        tools: toolSnapshot,
        thinking,
        thinkingEnabled,
      });
  }

  clear(): void {
    this.delivery.clear();
    this.messages.clear();
    this.progress.clear();
  }
}
