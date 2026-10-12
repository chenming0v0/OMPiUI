import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { isJsonObject, type JsonObject } from "@ompiui/protocol";

export interface JsonlPosition {
  offset: number;
  size: number;
  modified: number;
  prefix: string;
  inode: number;
}

/** 只扫描新读入的块；完整行才拼接一次，避免长行反复全缓冲扫描。 */
export async function* jsonlEntries(
  file: FileHandle,
  start: number,
  size: number,
): AsyncGenerator<{
  entry: unknown;
  bytes: number;
  newline: boolean;
  valid: boolean;
}> {
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(64 * 1024);
  let fragments: string[] = [];
  let bytes = 0;
  let offset = start;
  while (offset < size) {
    const read = await file.read(
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (!read.bytesRead) break;
    offset += read.bytesRead;
    const parts = decoder.write(buffer.subarray(0, read.bytesRead)).split("\n");
    for (let index = 0; index < parts.length; index++) {
      fragments.push(parts[index]!);
      bytes += Buffer.byteLength(parts[index]!);
      if (bytes > 64 * 1024 * 1024)
        throw Object.assign(new Error("session line exceeds 64 MiB"), {
          code: "FILE_TOO_LARGE",
        });
      if (index === parts.length - 1) continue;
      const line = fragments.join("");
      let entry: unknown;
      let valid = true;
      try {
        entry = JSON.parse(line);
      } catch {
        valid = false;
      }
      yield { entry, bytes: bytes + 1, newline: true, valid };
      fragments = [];
      bytes = 0;
    }
  }
  const tail = decoder.end();
  fragments.push(tail);
  bytes += Buffer.byteLength(tail);
  if (bytes) {
    const line = fragments.join("");
    let entry: unknown;
    let valid = true;
    try {
      entry = JSON.parse(line);
    } catch {
      valid = false;
    }
    yield { entry, bytes, newline: false, valid };
  }
}

/** 固定头改变、原地改写或截短时重读；追加时仅解析新完整行。 */
export async function scanJsonl(
  path: string,
  previous: JsonlPosition | undefined,
  consume: (entry: JsonObject, reset: boolean) => void,
  onReset: () => void,
): Promise<JsonlPosition> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (
      previous &&
      previous.size === stat.size &&
      previous.modified === stat.mtimeMs &&
      previous.inode === stat.ino
    )
      return previous;
    const header = Buffer.alloc(Math.min(4096, stat.size));
    await file.read(header, 0, header.length, 0);
    const prefix = header.toString("base64");
    const oldHeader = previous
      ? Buffer.from(previous.prefix, "base64")
      : undefined;
    const reset =
      !previous ||
      previous.inode !== stat.ino ||
      stat.size <= previous.size ||
      !header.subarray(0, oldHeader?.length).equals(oldHeader!);
    if (reset) onReset();
    let offset = reset ? 0 : previous!.offset;
    let lines = 0;
    for await (const line of jsonlEntries(file, offset, stat.size)) {
      if (!line.newline && !line.valid) break;
      offset += line.bytes;
      if (isJsonObject(line.entry)) consume(line.entry, reset);
      if (++lines % 128 === 0) await yieldTurn();
    }
    return {
      offset,
      size: stat.size,
      modified: stat.mtimeMs,
      prefix,
      inode: stat.ino,
    };
  } finally {
    await file.close();
  }
}

export async function mapLimited<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  concurrency = 8,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await work(items[index]!);
      }
    }),
  );
  return results;
}
