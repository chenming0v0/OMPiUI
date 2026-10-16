import { isJsonObject, jsonByteSize, splitUtf8Text, type JsonObject } from "@ompiui/protocol";
import { PausableFrameQueue } from "./pausable-frame-queue.js";

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

/** 在快照合并之后计算主消息块增量，消息开始/结束仍为恢复边界。 */
export class MainMessageStream {
  private previous?: JsonObject;
  private readonly delivery: PausableFrameQueue<{ event: JsonObject; live?: { id: string; revision: number } }>;

  constructor(
    emit: (
      event: JsonObject,
      live?: { id: string; revision: number },
    ) => void,
  ) { this.delivery = new PausableFrameQueue(frame => emit(frame.event, frame.live)); }

  push(event: JsonObject, live?: { id: string; revision: number }): void {
    this.delivery.push(this.frames(event, live), () => jsonByteSize(event, 64 * 1024 * 1024));
  }

  setPaused(paused: boolean): void { this.delivery.setPaused(paused); }
  clear(): void { this.delivery.clear(); this.previous = undefined; }

  private *frames(event: JsonObject, live?: { id: string; revision: number }): Generator<{ event: JsonObject; live?: { id: string; revision: number } }> {
    const message = isJsonObject(event.message) ? event.message : undefined;
    if (
      event.type !== "message_update" ||
      !message ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      if (event.type === "message_start") this.previous = message;
      if (event.type === "message_end") this.previous = undefined;
      yield { event, live };
      return;
    }
    let pending: JsonObject | undefined;
    for (const patch of this.patches(message)) {
      if (pending) yield { event: pending, live };
      pending = patch;
    }
    if (pending) yield { event: { ...pending, complete: true }, live };
    this.previous = message;
  }

  private *patches(message: JsonObject): Generator<JsonObject> {
    const content = Array.isArray(message.content) ? message.content : [];
    const oldContent = Array.isArray(this.previous?.content)
      ? this.previous.content
      : [];
    const { content: _content, ...metadata } = message;
    for (let index = 0; index < content.length; index++) {
      const block = content[index];
      if (!isJsonObject(block)) continue;
      const oldBlock = oldContent[index];
      const old = isJsonObject(oldBlock) ? oldBlock : undefined;
      const field =
        block.type === "text"
          ? "text"
          : block.type === "thinking"
            ? "thinking"
            : undefined;
      if (block.type === "toolCall" && isJsonObject(block.arguments)) {
        const oldArgs = old && isJsonObject(old.arguments) ? old.arguments : {};
        const { arguments: _arguments, ...header } = block;
        // 空参数也必须保留工具块，避免接收端缺少中间下标或保留旧参数。
        if (Object.keys(block.arguments).length === 0 && !jsonEqual(block, old)) {
          yield {
            type: "message_patch",
            metadata,
            index,
            block,
            blockCount: content.length,
          };
        }
        for (const [argument, value] of Object.entries(block.arguments)) {
          const previous = oldArgs[argument];
          if (typeof value === "string") {
            const before = typeof previous === "string" ? previous : "";
            let offset = value.startsWith(before) ? before.length : 0;
            for (const delta of splitUtf8Text(
              value.slice(offset),
              16 * 1024,
            ).concat(offset === value.length ? [""] : [])) {
              yield {
                type: "message_patch",
                metadata,
                index,
                block: header,
                field: "arguments",
                argument,
                offset,
                delta,
                argumentKeys: Object.keys(block.arguments),
                blockCount: content.length,
              };
              offset += delta.length;
            }
          } else if (!jsonEqual(value, previous)) {
            yield {
              type: "message_patch",
              metadata,
              index,
              block: header,
              field: "arguments",
              argument,
              value,
              argumentKeys: Object.keys(block.arguments),
              blockCount: content.length,
            };
          }
        }
        continue;
      }
      if (!field) {
        if (!jsonEqual(block, old)) {
          yield { type: "message_patch", metadata, index, block };
        }
        continue;
      }
      const text = typeof block[field] === "string" ? block[field] : "";
      const before =
        old && old.type === block.type && typeof old[field] === "string"
          ? old[field]
          : "";
      let offset = text.startsWith(before) ? before.length : 0;
      const { [field]: _text, ...header } = block;
      delete header.thinkingSignature;
      delete header.textSignature;
      for (const delta of splitUtf8Text(text.slice(offset), 16 * 1024).concat(
        offset === text.length ? [""] : [],
      )) {
        yield {
          type: "message_patch",
          metadata,
          index,
          block: header,
          field,
          offset,
          delta,
          blockCount: content.length,
        };
        offset += delta.length;
      }
    }
  }
}
