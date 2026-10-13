import type { ServerResponse } from "node:http";

let pendingBytes = 0;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

/** 压缩前预留正文和压缩工作区，直到响应交付或连接关闭才归还。 */
export function reserveHttpOutput(res: ServerResponse, bytes: number): { hold(): () => void } | undefined {
  const cost = bytes * 2;
  if (pendingBytes + cost > MAX_PENDING_BYTES) return undefined;
  pendingBytes += cost;
  let released = false;
  let closed = false;
  let holds = 0;
  const release = () => {
    closed = true;
    if (released || holds > 0) return;
    released = true;
    clearTimeout(timer);
    pendingBytes -= cost;
    res.removeListener("finish", release);
    res.removeListener("close", release);
  };
  const timer = setTimeout(() => res.destroy(), 300_000);
  timer.unref();
  res.once("finish", release);
  res.once("close", release);
  return {
    hold() {
      holds++;
      return () => {
        holds--;
        if (closed) release();
      };
    },
  };
}

export function writeHttpOutput(res: ServerResponse, payload: string | Buffer): void {
  const buffer = typeof payload === "string" ? Buffer.from(payload) : payload;
  let offset = 0;
  const pump = () => {
    if (res.destroyed || res.writableEnded) return;
    while (offset < buffer.length) {
      const end = Math.min(buffer.length, offset + 64 * 1024);
      const chunk = buffer.subarray(offset, end);
      offset = end;
      if (!res.write(chunk)) {
        res.once("drain", pump);
        return;
      }
    }
    res.end();
  };
  res.once("close", () => res.removeListener("drain", pump));
  pump();
}
