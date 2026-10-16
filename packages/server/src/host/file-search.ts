import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  FileNameSearchResponse,
  FileSearchStats,
  FileTextSearchResponse,
  WorkspaceTextSearchMatch,
} from "@ompiui/protocol";
import type { WorkspaceRecord } from "./workspace-store.ts";
import { resolveWorkspacePath } from "./path-safety.ts";
import { jsonByteSize, utf8Prefix } from "@ompiui/protocol";
import { QueryPool, requestAborted } from "./query-pool.ts";

const searchPool = new QueryPool(4);
type SearchFlight = {
  controller: AbortController;
  users: number;
  settled: boolean;
  value: Promise<FileNameSearchResponse | FileTextSearchResponse>;
};
const searchFlights = new Map<string, SearchFlight>();

function sharedSearch<T extends FileNameSearchResponse | FileTextSearchResponse>(
  key: string,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(requestAborted());
  let flight = searchFlights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const owned: SearchFlight = {
      controller,
      users: 0,
      settled: false,
      value: Promise.resolve().then(() => operation(controller.signal)).finally(() => {
        owned.settled = true;
        if (searchFlights.get(key) === owned) searchFlights.delete(key);
      }),
    };
    searchFlights.set(key, owned);
    flight = owned;
  }
  const owned = flight;
  owned.users++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, value?: FileNameSearchResponse | FileTextSearchResponse) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      if (--owned.users === 0 && !owned.settled) {
        if (searchFlights.get(key) === owned) searchFlights.delete(key);
        owned.controller.abort();
      }
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(requestAborted());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    owned.value.then(value => finish(undefined, value), error => finish(error));
  });
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".turbo",
  "target",
]);
const MAX_RESULTS = 200;
const MAX_VISIT = 50_000;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_TEXT_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 8192;
const MAX_SUBMATCHES = 200;
// 按计数器和整数耗时的最大长度预留完整封装；
// JSON 中有限非负整数的最长表示为 23 字节。
const MAX_RESULT_STATS: FileSearchStats = {
  visited: MAX_VISIT,
  scannedFiles: MAX_VISIT,
  scannedBytes: MAX_TEXT_TOTAL_BYTES,
  durationMs: Number.MAX_VALUE,
  truncated: false,
  limitReason: "results",
};

export async function searchFilesByName(
  ws: WorkspaceRecord,
  query: string,
  opts: {
    type?: "file" | "directory";
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FileNameSearchResponse> {
  const normalizedQuery = query.trim();
  assertQuerySize(normalizedQuery);
  const key = `name:${ws.canonicalRoot}\0${normalizedQuery}\0${opts.type ?? ""}\0${opts.limit ?? ""}`;
  return sharedSearch(key, opts.signal, signal =>
    searchPool.run(signal, () => searchFilesByNameInSlot(ws, normalizedQuery, { ...opts, signal })),
  );
}

async function searchFilesByNameInSlot(
  ws: WorkspaceRecord,
  query: string,
  opts: { type?: "file" | "directory"; limit?: number; signal?: AbortSignal },
): Promise<FileNameSearchResponse> {
  const started = performance.now();
  const needle = query.trim().toLocaleLowerCase();
  assertQuerySize(needle);
  const limit = boundedLimit(opts.limit);
  const paths: string[] = [];
  let visited = 0;
  let scannedFiles = 0;
  let limitReason: FileSearchStats["limitReason"];
  if (needle) {
    await walkWorkspace(ws, opts.signal, async (entry) => {
      visited++;
      if (!entry.isDirectory) scannedFiles++;
      if (
        entry.relative.toLocaleLowerCase().includes(needle) &&
        (!opts.type || (opts.type === "directory") === entry.isDirectory)
      ) {
        paths.push(entry.relative);
      }
      if (paths.length >= limit) {
        limitReason = "results";
        return false;
      }
      if (visited >= MAX_VISIT) {
        limitReason = "entries";
        return false;
      }
      return true;
    });
  }
  return {
    query,
    paths,
    stats: stats(started, visited, scannedFiles, 0, limitReason),
  };
}

export async function searchWorkspaceText(
  ws: WorkspaceRecord,
  pattern: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<FileTextSearchResponse> {
  const key = `text:${ws.canonicalRoot}\0${pattern}\0${opts.limit ?? ""}`;
  return sharedSearch(key, opts.signal, signal =>
    searchPool.run(signal, () => searchWorkspaceTextInSlot(ws, pattern, { ...opts, signal })),
  );
}

async function searchWorkspaceTextInSlot(
  ws: WorkspaceRecord,
  pattern: string,
  opts: { limit?: number; signal?: AbortSignal },
): Promise<FileTextSearchResponse> {
  const started = performance.now();
  assertQuerySize(pattern);
  const needle = pattern.trim();
  const limit = boundedLimit(opts.limit);
  const matcher = needle ? new RegExp(escapeRegExp(needle), "giu") : undefined;
  const matches: WorkspaceTextSearchMatch[] = [];
  let visited = 0;
  let scannedFiles = 0;
  let scannedBytes = 0;
  const resultBudget = {
    remaining: MAX_RESULT_BYTES - jsonByteSize({
      data: { query: pattern, matches: [], stats: MAX_RESULT_STATS },
    }, MAX_RESULT_BYTES),
  };
  let limitReason: FileSearchStats["limitReason"];
  if (needle) {
    await walkWorkspace(ws, opts.signal, async (entry) => {
      visited++;
      if (entry.isDirectory) {
        if (visited >= MAX_VISIT) {
          limitReason = "entries";
          return false;
        }
        return true;
      }
      if (visited >= MAX_VISIT) {
        limitReason = "entries";
        return false;
      }
      let fileStat;
      let safeAbsolute: string;
      try {
        const resolved = resolveWorkspacePath(ws.canonicalRoot, entry.relative);
        safeAbsolute = resolved.absolute;
        fileStat = await stat(safeAbsolute);
      } catch {
        throwIfAborted(opts.signal);
        return true;
      }
      throwIfAborted(opts.signal);
      if (!fileStat.isFile() || fileStat.size > MAX_TEXT_FILE_BYTES)
        return true;
      if (scannedBytes + fileStat.size > MAX_TEXT_TOTAL_BYTES) {
        limitReason = "bytes";
        return false;
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(safeAbsolute, { signal: opts.signal });
      } catch {
        throwIfAborted(opts.signal);
        return true;
      }
      throwIfAborted(opts.signal);
      if (
        buffer.length > MAX_TEXT_FILE_BYTES ||
        scannedBytes + buffer.length > MAX_TEXT_TOTAL_BYTES
      ) {
        limitReason = "bytes";
        return false;
      }
      try {
        const verified = resolveWorkspacePath(ws.canonicalRoot, entry.relative);
        if (verified.absolute !== safeAbsolute) return true;
      } catch {
        return true;
      }
      if (buffer.includes(0)) return true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        return true;
      }
      scannedFiles++;
      scannedBytes += buffer.length;
      const clipped = collectTextMatches(
        buffer.toString("utf8"),
        entry.relative,
        matcher!,
        matches,
        limit,
        resultBudget,
      );
      if (clipped) {
        limitReason = "bytes";
        return false;
      }
      if (matches.length >= limit) {
        limitReason = "results";
        return false;
      }
      return true;
    });
  }
  return {
    query: pattern,
    matches,
    stats: stats(started, visited, scannedFiles, scannedBytes, limitReason),
  };
}

interface WalkEntry {
  relative: string;
  absolute: string;
  isDirectory: boolean;
}

async function walkWorkspace(
  ws: WorkspaceRecord,
  signal: AbortSignal | undefined,
  visit: (entry: WalkEntry) => boolean | Promise<boolean>,
): Promise<void> {
  const directories = [""];
  while (directories.length > 0) {
    throwIfAborted(signal);
    const relativeDirectory = directories.pop()!;
    let absoluteDirectory: string;
    try {
      absoluteDirectory = resolveWorkspacePath(
        ws.canonicalRoot,
        relativeDirectory,
      ).absolute;
    } catch {
      continue;
    }
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      throwIfAborted(signal);
      continue;
    }
    throwIfAborted(signal);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const childDirectories: string[] = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const isDirectory = entry.isDirectory();
      if (isDirectory && SKIP_DIRS.has(entry.name)) continue;
      if (
        !(await visit({
          relative,
          absolute: path.join(absoluteDirectory, entry.name),
          isDirectory,
        }))
      )
        return;
      if (isDirectory) childDirectories.push(relative);
    }
    for (let index = childDirectories.length - 1; index >= 0; index--)
      directories.push(childDirectories[index]!);
  }
}

function collectTextMatches(
  content: string,
  relativePath: string,
  matcher: RegExp,
  results: WorkspaceTextSearchMatch[],
  limit: number,
  budget: { remaining: number },
): boolean {
  let clipped = false;
  let charOffset = 0;
  let byteOffset = 0;
  let lineNumber = 1;
  while (charOffset <= content.length && results.length < limit) {
    const newline = content.indexOf("\n", charOffset);
    const end = newline < 0 ? content.length : newline;
    const rawLine = content.slice(charOffset, end);
    const original = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const line = utf8Prefix(original, MAX_LINE_BYTES);
    if (line.length < original.length) clipped = true;
    const submatches: WorkspaceTextSearchMatch["submatches"] = [];
    matcher.lastIndex = 0;
    let measured = 0;
    let measuredBytes = 0;
    for (const match of line.matchAll(matcher)) {
      const start = match.index;
      const matchEnd = start + match[0].length;
      measuredBytes += Buffer.byteLength(line.slice(measured, start));
      const matchBytes = Buffer.byteLength(match[0]);
      submatches.push({
        start: measuredBytes,
        end: measuredBytes + matchBytes,
        match: { text: match[0] },
      });
      measured = matchEnd;
      measuredBytes += matchBytes;
      if (submatches.length >= MAX_SUBMATCHES) {
        clipped = true;
        break;
      }
    }
    if (submatches.length > 0) {
      const candidate: WorkspaceTextSearchMatch = {
        path: { text: relativePath },
        lines: { text: line },
        line_number: lineNumber,
        absolute_offset: byteOffset,
        submatches,
      };
      const bytes = jsonByteSize(candidate, budget.remaining) + (results.length > 0 ? 1 : 0);
      if (bytes > budget.remaining) return true;
      results.push(candidate);
      budget.remaining -= bytes;
    }
    if (newline < 0) break;
    const consumed = content.slice(charOffset, newline + 1);
    byteOffset += Buffer.byteLength(consumed, "utf8");
    charOffset = newline + 1;
    lineNumber++;
  }
  return clipped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertQuerySize(query: string): void {
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    throw Object.assign(
      new Error(`query must be at most ${MAX_QUERY_BYTES} bytes`),
      { code: "INVALID_REQUEST" },
    );
  }
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw Object.assign(
      new Error(`limit must be an integer between 1 and ${MAX_RESULTS}`),
      { code: "INVALID_REQUEST" },
    );
  }
  return limit;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error("search cancelled"), {
    code: "REQUEST_ABORTED",
  });
}

function stats(
  started: number,
  visited: number,
  scannedFiles: number,
  scannedBytes: number,
  limitReason: FileSearchStats["limitReason"],
): FileSearchStats {
  return {
    visited,
    scannedFiles,
    scannedBytes,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    truncated: limitReason !== undefined,
    limitReason,
  };
}
