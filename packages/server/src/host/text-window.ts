import { utf8Suffix } from "@ompiui/protocol";

/** 热路径只追加和裁剪块；挂接重放时才拼接完整窗口。 */
export class TextWindow {
  private chunks: Array<{ text: string; bytes: number }> = [];
  private head = 0;
  bytes = 0;
  length = 0;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
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
}
