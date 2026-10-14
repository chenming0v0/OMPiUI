import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream";

/**
 * Static hosting for the web client — lets a browser (desktop or phone) hit
 * the server directly. API routes stay under /api; everything else falls back
 * to index.html so the SPA router keeps working on refresh.
 */

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Resolve a URL path inside root; returns undefined for traversal attempts. */
export function resolveStaticPath(
  root: string,
  urlPath: string,
): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const absolute = resolve(root, `.${normalize(decoded)}`);
  const rootWithSep = resolve(root) + sep;
  if (absolute !== resolve(root) && !absolute.startsWith(rootWithSep))
    return undefined;
  return absolute;
}

export interface StaticServer {
  /** True when the request was handled (file or SPA fallback served). */
  serve(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean;
}

export function createStaticServer(root: string): StaticServer | undefined {
  const indexHtml = join(root, "index.html");
  if (!existsSync(indexHtml)) return undefined;
  const canonicalRoot = realpathSync(root);
  const canonicalIndex = realpathSync(indexHtml);

  const isInsideRoot = (candidate: string): boolean => {
    const rootWithSep = canonicalRoot.endsWith(sep)
      ? canonicalRoot
      : canonicalRoot + sep;
    return candidate === canonicalRoot || candidate.startsWith(rootWithSep);
  };

  if (!isInsideRoot(canonicalIndex)) return undefined;

  const sendFile = (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    headOnly: boolean,
    cache: boolean,
  ): boolean => {
    const stat = statSync(path);
    const compress =
      !req.headers.range &&
      /\.(html|[cm]?js|css|json|svg|map|webmanifest)$/.test(path) &&
      stat.size >= 1024 &&
      String(req.headers["accept-encoding"] ?? "")
        .split(",")
        .some(
          (value) =>
            /^gzip(?:\s*;|$)/.test(value.trim()) &&
            !/q=0(?:\.0*)?(?:\s|$)/.test(value),
        );
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}${compress ? "-gzip" : ""}"`;
    const headers: Record<string, string | number> = {
      "content-type": contentType(path),
      "cache-control": cache
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      etag,
      "last-modified": stat.mtime.toUTCString(),
      vary: "Accept-Encoding",
      "accept-ranges": "bytes",
    };
    if (
      String(req.headers["if-none-match"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .some((value) => value === "*" || value === etag) ||
      (!req.headers["if-none-match"] &&
        req.headers["if-modified-since"] &&
        stat.mtimeMs < Date.parse(req.headers["if-modified-since"]) + 1000)
    ) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (
      req.headers.range &&
      (!req.headers["if-range"] ||
        req.headers["if-range"] === headers["last-modified"])
    ) {
      if (req.headers.range.includes(",")) {
        const ranges = req.headers.range.slice("bytes=".length).split(",").map(part => {
          const match = /^(\d*)-(\d*)$/.exec(part.trim());
          if (!match || (!match[1] && !match[2])) return undefined;
          const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
          const end = match[1] && match[2] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
          return start <= end && start < stat.size ? { start, end } : undefined;
        });
        if (ranges.length === 0 || ranges.some(range => !range) || ranges.length > 16) {
          res.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}` });
          res.end();
          return true;
        }
        const boundary = `ompiui-${Math.random().toString(16).slice(2)}`;
        const parts = ranges as Array<{ start: number; end: number }>;
        const partHeaders = parts.map(range => `--${boundary}\r\nContent-Type: ${contentType(path)}\r\nContent-Range: bytes ${range.start}-${range.end}/${stat.size}\r\n\r\n`);
        const length = parts.reduce((total, range, index) => total + Buffer.byteLength(partHeaders[index]!) + range.end - range.start + 1 + 2, 0) + Buffer.byteLength(`--${boundary}--\r\n`);
        res.writeHead(206, { ...headers, "content-type": `multipart/byteranges; boundary=${boundary}`, "content-length": length });
        if (headOnly) {
          res.end();
          return true;
        }
        pipeline(async function* (options = {}) {
          const signal = options.signal!;
          for (let index = 0; index < parts.length; index++) {
            signal.throwIfAborted();
            yield partHeaders[index]!;
            signal.throwIfAborted();
            const range = parts[index]!;
            const source = createReadStream(path, { start: range.start, end: range.end, signal });
            try {
              yield* source;
            } finally {
              source.destroy();
            }
            yield "\r\n";
          }
          signal.throwIfAborted();
          yield `--${boundary}--\r\n`;
        }, res, error => {
          if (error) res.destroy(error);
        });
        return true;
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2])) {
        res.writeHead(416, {
          ...headers,
          "content-range": `bytes */${stat.size}`,
        });
        res.end();
        return true;
      }
      start = range[1]
        ? Number(range[1])
        : Math.max(0, stat.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end;
      if (start > end || start >= stat.size) {
        res.writeHead(416, {
          ...headers,
          "content-range": `bytes */${stat.size}`,
        });
        res.end();
        return true;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
    }
    if (compress) headers["content-encoding"] = "gzip";
    else headers["content-length"] = Math.max(0, end - start + 1);
    res.writeHead(status, headers);
    if (headOnly) {
      res.end();
      return true;
    }
    const source = createReadStream(
      path,
      stat.size ? { start, end } : undefined,
    );
    const failed = (error: NodeJS.ErrnoException | null) => {
      if (error) res.destroy(error);
    };
    if (compress) pipeline(source, createGzip(), res, failed);
    else pipeline(source, res, failed);
    return true;
  };

  return {
    serve(req, res, urlPath) {
      const headOnly = req.method === "HEAD";
      const resolved = resolveStaticPath(root, urlPath);
      if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
        let physicalPath: string;
        try {
          physicalPath = realpathSync(resolved);
        } catch {
          return false;
        }
        if (!isInsideRoot(physicalPath)) return false;
        const fingerprinted =
          /[.-][0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|jpg|svg|webp)$/.test(
            physicalPath,
          );
        return sendFile(req, res, physicalPath, headOnly, fingerprinted);
      }
      // SPA fallback：客户端路由的路径都回 index.html
      if (!extname(urlPath)) {
        return sendFile(req, res, canonicalIndex, headOnly, false);
      }
      return false;
    },
  };
}
