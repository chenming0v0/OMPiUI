import type { ServerResponse } from "node:http";
import { brotliCompress, constants, gzip } from "node:zlib";

export type HttpContentEncoding = "br" | "gzip";
const BROTLI_QUALITY = 5;

function encodingQuality(header: string | undefined, encoding: HttpContentEncoding): number {
  let explicit: number | undefined;
  let wildcard: number | undefined;
  for (const value of (header ?? "").split(",")) {
    const [name, ...params] = value.trim().split(";");
    const token = name?.toLowerCase();
    if (token !== encoding && token !== "*") continue;
    const quality = params.find((param) => /^q=/i.test(param.trim()));
    const parsed = quality ? Number(quality.trim().slice(2)) : 1;
    const parsedQuality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    if (token === encoding) explicit = parsedQuality;
    else wildcard = parsedQuality;
  }
  return explicit ?? wildcard ?? 0;
}

export function selectHttpEncoding(header: string | undefined): HttpContentEncoding | undefined {
  const brotli = encodingQuality(header, "br");
  const gzip = encodingQuality(header, "gzip");
  if (brotli > 0 && brotli >= gzip) return "br";
  if (gzip > 0) return "gzip";
  return undefined;
}

export function compressHttpJson(data: string, encoding: HttpContentEncoding): Promise<Buffer> {
  const input = Buffer.from(data);
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, compressed: Buffer) => {
      if (error) reject(error);
      else resolve(compressed);
    };
    if (encoding === "br") {
      brotliCompress(input, {
        params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
      }, callback);
    } else {
      gzip(input, callback);
    }
  });
}

let pendingBytes = 0;
/**
 * 全局待交付正文预算。单响应正文上限 64 MiB，预留按 `bytes * 2` 计
 * （正文 + 压缩工作区），因此这里必须 ≥ 128 MiB，否则合法大响应会被过早拒绝。
 */
export const MAX_PENDING_BYTES = 128 * 1024 * 1024;

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
