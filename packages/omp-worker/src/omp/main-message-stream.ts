import { isJsonObject, splitUtf8Text, type JsonObject } from "@ompiui/protocol";

/** 在快照合并之后计算主消息块增量，消息开始/结束仍为恢复边界。 */
export class MainMessageStream {
  private previous?: JsonObject;

  constructor(
    private readonly emit: (
      event: JsonObject,
      live?: { id: string; revision: number },
    ) => void,
  ) {}

  push(event: JsonObject, live?: { id: string; revision: number }): void {
    const message = isJsonObject(event.message) ? event.message : undefined;
    if (
      event.type !== "message_update" ||
      !message ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      if (event.type === "message_start") this.previous = message;
      if (event.type === "message_end") this.previous = undefined;
      this.emit(event, live);
      return;
    }
    const oldContent = Array.isArray(this.previous?.content)
      ? this.previous.content
      : [];
    const { content: _content, ...metadata } = message;
    let pending: JsonObject | undefined;
    const send = (patch: JsonObject) => {
      if (pending) this.emit(pending, live);
      pending = patch;
    };
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
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
        for (const [argument, value] of Object.entries(block.arguments)) {
          const previous = oldArgs[argument];
          if (typeof value === "string") {
            const before = typeof previous === "string" ? previous : "";
            let offset = value.startsWith(before) ? before.length : 0;
            for (const delta of splitUtf8Text(
              value.slice(offset),
              16 * 1024,
            ).concat(offset === value.length ? [""] : [])) {
              send({
                type: "message_patch",
                metadata,
                index,
                block: header,
                field: "arguments",
                argument,
                offset,
                delta,
                argumentKeys: Object.keys(block.arguments),
                blockCount: message.content.length,
              });
              offset += delta.length;
            }
          } else if (JSON.stringify(value) !== JSON.stringify(previous)) {
            send({
              type: "message_patch",
              metadata,
              index,
              block: header,
              field: "arguments",
              argument,
              value,
              argumentKeys: Object.keys(block.arguments),
              blockCount: message.content.length,
            });
          }
        }
        continue;
      }
      if (!field) {
        if (JSON.stringify(block) !== JSON.stringify(old)) {
          send({ type: "message_patch", metadata, index, block });
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
        send({
          type: "message_patch",
          metadata,
          index,
          block: header,
          field,
          offset,
          delta,
          blockCount: message.content.length,
        });
        offset += delta.length;
      }
    }
    const final = pending as JsonObject | undefined;
    if (final) this.emit({ ...final, complete: true }, live);
    this.previous = message;
  }
}
