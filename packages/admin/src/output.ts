import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export function captureLines(
  stream: Readable,
  append: (line: string) => void,
): void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  stream.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) append(line);
    if (pending.length > 8_192) {
      append(pending.slice(0, 8_192));
      pending = "";
    }
  });
  stream.on("end", () => {
    pending += decoder.end();
    if (pending) append(pending);
  });
}
