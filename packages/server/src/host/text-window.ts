import { utf8Suffix } from "@ompiui/protocol";

/** 热路径只追加和裁剪块；挂接重放时才拼接完整窗口。 */
export class TextWindow {
  private chunks: Array<{ text: string; bytes: number }> = [];
  private head = 0;
  bytes = 0;
  length = 0;

  constructor(private readonly limit: number) {}

  append(text: string, bytes = Buffer.byteLength(text)): void {
    if (!text) return;
    this.chunks.push({ text, bytes });
    this.bytes += bytes;
    this.length += text.length;
    while (this.bytes > this.limit) {
      const first = this.chunks[this.head]!;
      const excess = this.bytes - this.limit;
      if (first.bytes <= excess) {
        this.bytes -= first.bytes;
        this.length -= first.text.length;
        this.head++;
      } else {
        const tail = utf8Suffix(first.text, first.bytes - excess);
        const retained = Buffer.byteLength(tail);
        this.bytes -= first.bytes - retained;
        this.length -= first.text.length - tail.length;
        this.chunks[this.head] = { text: tail, bytes: retained };
      }
    }
    if (this.head > 256 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  toString(): string {
    return this.chunks
      .slice(this.head)
      .map((chunk) => chunk.text)
      .join("");
  }

  sliceFrom(offsetChars: number, maxBytes: number): { text: string; chars: number } {
    let skip = Math.max(0, offsetChars);
    const parts: string[] = [];
    let bytes = 0;
    let chars = 0;
    for (let index = this.head; index < this.chunks.length; index++) {
      const chunk = this.chunks[index]!;
      if (skip >= chunk.text.length) {
        skip -= chunk.text.length;
        continue;
      }
      let text = skip ? chunk.text.slice(skip) : chunk.text;
      skip = 0;
      const available = maxBytes - bytes;
      if (Buffer.byteLength(text) > available) {
        const encoded = Buffer.from(text);
        let end = Math.max(0, available);
        while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
        text = encoded.subarray(0, end).toString("utf8");
      }
      if (!text) break;
      parts.push(text);
      bytes += Buffer.byteLength(text);
      chars += text.length;
      if (bytes >= maxBytes) break;
    }
    return { text: parts.join(""), chars };
  }

  tail(maxBytes: number): { text: string; chars: number } {
    let remaining = maxBytes;
    const parts: string[] = [];
    for (let index = this.chunks.length - 1; index >= this.head && remaining > 0; index--) {
      const chunk = this.chunks[index]!;
      if (chunk.bytes <= remaining) {
        parts.push(chunk.text);
        remaining -= chunk.bytes;
        continue;
      }
      const bytes = Buffer.from(chunk.text);
      let start = Math.max(0, bytes.length - remaining);
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      parts.push(bytes.subarray(start).toString("utf8"));
      remaining = 0;
    }
    parts.reverse();
    const text = parts.join("");
    return { text, chars: text.length };
  }
}
