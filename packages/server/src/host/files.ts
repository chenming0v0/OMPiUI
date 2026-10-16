import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type {
  FileListResponse,
  FileNodeDto,
  FileOperationResponse,
  FileReadResponse,
} from "@ompiui/protocol";
import { jsonByteSize } from "@ompiui/protocol";
import { PathSafetyError, resolveWorkspacePath } from "./path-safety.ts";
import { workspacePathKey, type WorkspaceRecord } from "./workspace-store.ts";
import { acquireWorkspaceMutationLock } from "./workspace-lock.ts";
import { mapConcurrent, QueryPool, requestAborted } from "./query-pool.ts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
const DEFAULT_DIR_ENTRIES = 1000;
const MAX_DIR_ENTRIES = 2000;
const MAX_PENDING_MUTATION_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACE_MUTATION_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_MUTATIONS = 128;
const MAX_WORKSPACE_MUTATIONS = 32;
const workspaceMutations = new Map<
  string,
  { pool: QueryPool; bytes: number; count: number }
>();
let pendingMutationBytes = 0;
let pendingMutations = 0;
const directoryPages = new Map<
  string,
  { modified: number; at: number; names: string[]; fingerprint: string }
>();

export async function listFiles(
  ws: WorkspaceRecord,
  relativePath: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<FileListResponse> {
  assertWorkspaceCurrent(ws);
  const resolved = resolveWorkspacePath(ws.canonicalRoot, relativePath);
  if (!resolved.exists)
    throw new PathSafetyError("INVALID_REQUEST", "path does not exist");
  const directory = await lstat(resolved.absolute);
  if (!directory.isDirectory())
    throw new PathSafetyError("INVALID_REQUEST", "not a directory");

  const limit = Math.min(
    Math.max(opts.limit ?? DEFAULT_DIR_ENTRIES, 1),
    MAX_DIR_ENTRIES,
  );
  let cached = directoryPages.get(resolved.absolute);
  if (
    !cached ||
    cached.modified !== directory.mtimeMs ||
    Date.now() - cached.at > 5000
  ) {
    const names = (await readdir(resolved.absolute)).sort((a, b) =>
      a.localeCompare(b),
    );
    cached = {
      names,
      modified: directory.mtimeMs,
      at: Date.now(),
      fingerprint: createHash("sha256")
        .update(names.join("\0"))
        .digest("base64url")
        .slice(0, 12),
    };
    directoryPages.set(resolved.absolute, cached);
    let namesCount = [...directoryPages.values()].reduce(
      (total, page) => total + page.names.length,
      0,
    );
    for (const [key, page] of directoryPages) {
      if (directoryPages.size <= 32 && namesCount <= 100000) break;
      if (key === resolved.absolute) continue;
      namesCount -= page.names.length;
      directoryPages.delete(key);
    }
  }
  const { names, fingerprint } = cached;
  const cursor = decodeCursor(opts.cursor);
  if (cursor.fingerprint && cursor.fingerprint !== fingerprint)
    throw staleRevision();
  const offset = cursor.offset;
  const page = names.slice(offset, offset + limit);
  const described = await mapConcurrent(page, 32, name => describeEntry(ws, resolved.relative, name));
  const entries: FileNodeDto[] = [];
  let bytes = 8192;
  let consumed = 0;
  for (const entry of described) {
    const cost = entry ? Buffer.byteLength(JSON.stringify(entry)) + 1 : 0;
    if (bytes + cost > 512 * 1024) break;
    consumed++;
    bytes += cost;
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    });
  const nextOffset = offset + consumed;
  return {
    path: resolved.relative,
    entries,
    total: names.length,
    truncated: nextOffset < names.length,
    nextCursor:
      nextOffset < names.length
        ? encodeCursor(nextOffset, fingerprint)
        : undefined,
  };
}

export async function readFileContent(
  ws: WorkspaceRecord,
  relativePath: string,
  ifNoneMatch?: string,
  maxBytes?: number,
): Promise<FileReadResponse> {
  assertWorkspaceCurrent(ws);
  const resolved = resolveWorkspacePath(ws.canonicalRoot, relativePath);
  if (!resolved.exists)
    throw new PathSafetyError("INVALID_REQUEST", "path does not exist");
  if (resolved.restricted)
    throw new PathSafetyError("SYMLINK_ESCAPE", "restricted path");
  const handle = await open(resolved.absolute, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile())
      throw new PathSafetyError("INVALID_REQUEST", "not a file");
    if (opened.size > Math.min(MAX_BINARY_BYTES, maxBytes ?? MAX_BINARY_BYTES))
      throw fileTooLarge("file too large for remote preview");
    const buffer = await handle.readFile();
    if (buffer.length > MAX_BINARY_BYTES)
      throw fileTooLarge("file too large for remote preview");
    const verified = resolveWorkspacePath(ws.canonicalRoot, relativePath);
    if (verified.absolute !== resolved.absolute)
      throw new PathSafetyError(
        "SYMLINK_ESCAPE",
        "file target changed during read",
      );
    const current = await stat(verified.absolute);
    const afterRead = await handle.stat();
    if (!sameFile(current, afterRead))
      throw new PathSafetyError(
        "SYMLINK_ESCAPE",
        "file target changed during read",
      );
    const binary = isBinary(buffer);
    if (!binary && buffer.length > MAX_TEXT_BYTES)
      throw fileTooLarge("text file too large for remote preview");
    const revision = etag(buffer);
    const notModified = ifNoneMatch === revision;
    const result: FileReadResponse = {
      path: resolved.relative,
      content: notModified ? "" : binary ? buffer.toString("base64") : buffer.toString("utf8"),
      encoding: binary ? "base64" : "utf-8",
      type: binary ? "binary" : "text",
      mimeType: mimeType(relativePath, binary),
      size: buffer.length,
      etag: revision,
      ...(notModified ? { notModified: true } : {}),
    };
    if (maxBytes !== undefined && jsonByteSize(result, maxBytes) > maxBytes)
      throw fileTooLarge("encoded file exceeds the preview resource budget");
    return result;
  } finally {
    await handle.close();
  }
}

export async function writeFileContent(
  ws: WorkspaceRecord,
  relativePath: string,
  content: string,
  opts: {
    ifMatch?: string;
    encoding?: "utf-8" | "base64";
    returnContent?: boolean;
    createOnly?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<FileReadResponse> {
  return withWorkspaceMutation(
    ws,
    2 * (content.length + relativePath.length + (opts.ifMatch?.length ?? 0)),
    opts.signal,
    () => writeFileContentLocked(ws, relativePath, content, opts),
  );
}

async function writeFileContentLocked(
  ws: WorkspaceRecord,
  relativePath: string,
  content: string,
  opts: {
    ifMatch?: string;
    encoding?: "utf-8" | "base64";
    returnContent?: boolean;
    createOnly?: boolean;
  },
): Promise<FileReadResponse> {
  const resolved = resolveWorkspacePath(ws.canonicalRoot, relativePath);
  if (resolved.restricted)
    throw new PathSafetyError("SYMLINK_ESCAPE", "restricted path");
  let existingMode: number | undefined;
  if (resolved.exists) {
    if (opts.createOnly) throw conflict("file already exists");
    const stat = await lstat(resolved.absolute);
    if (!stat.isFile())
      throw new PathSafetyError("INVALID_REQUEST", "not a file");
    existingMode = stat.mode;
    if (opts.ifMatch && opts.ifMatch.trim() !== "*") {
      const current = await readFile(resolved.absolute);
      if (etag(current) !== normalizeEtag(opts.ifMatch)) throw staleRevision();
    }
  } else if (opts.ifMatch) {
    throw staleRevision();
  }

  const buffer = decodeContent(content, opts.encoding);
  if (
    buffer.length > MAX_BINARY_BYTES ||
    (opts.encoding !== "base64" && buffer.length > MAX_TEXT_BYTES)
  ) {
    throw fileTooLarge("file too large");
  }
  const parent = path.dirname(resolved.absolute);
  await mkdir(parent, { recursive: true });
  const parentRelative = path.posix.dirname(resolved.relative);
  resolveWorkspacePath(
    ws.canonicalRoot,
    parentRelative === "." ? "" : parentRelative,
  );
  const temporary = path.join(
    parent,
    `.${path.basename(resolved.absolute)}.ompiui-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, buffer, { flag: "wx", mode: existingMode });
    const latest = resolveWorkspacePath(ws.canonicalRoot, relativePath);
    if (latest.absolute !== resolved.absolute)
      throw new PathSafetyError(
        "SYMLINK_ESCAPE",
        "file target changed during write",
      );
    if (opts.createOnly && latest.exists) throw conflict("file already exists");
    if (opts.ifMatch && !latest.exists) throw staleRevision();
    if (opts.ifMatch && opts.ifMatch.trim() !== "*") {
      if (!latest.exists) throw staleRevision();
      const current = await readFile(latest.absolute);
      if (etag(current) !== normalizeEtag(opts.ifMatch)) throw staleRevision();
    }
    await rename(temporary, resolved.absolute);
    if (existingMode !== undefined)
      await chmod(resolved.absolute, existingMode);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const binary = opts.encoding === "base64";
  return {
    path: resolved.relative,
    content: opts.returnContent === false ? "" : (binary ? buffer.toString("base64") : buffer.toString("utf8")),
    encoding: binary ? "base64" : "utf-8",
    type: binary ? "binary" : "text",
    mimeType: mimeType(relativePath, binary),
    size: buffer.length,
    etag: etag(buffer),
  };
}

export async function createWorkspaceEntry(
  ws: WorkspaceRecord,
  relativePath: string,
  type: "file" | "directory",
  opts: {
    content?: string;
    encoding?: "utf-8" | "base64";
    overwrite?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<FileOperationResponse | FileReadResponse> {
  return withWorkspaceMutation(
    ws,
    2 * (relativePath.length + (opts.content?.length ?? 0)),
    opts.signal,
    () => createWorkspaceEntryLocked(ws, relativePath, type, opts),
  );
}

async function createWorkspaceEntryLocked(
  ws: WorkspaceRecord,
  relativePath: string,
  type: "file" | "directory",
  opts: {
    content?: string;
    encoding?: "utf-8" | "base64";
    overwrite?: boolean;
  },
): Promise<FileOperationResponse | FileReadResponse> {
  const resolved = resolveWorkspacePath(ws.canonicalRoot, relativePath);
  if (resolved.relative === "")
    throw new PathSafetyError(
      "INVALID_REQUEST",
      "workspace root already exists",
    );
  if (type === "directory") {
    if (resolved.exists && !opts.overwrite)
      throw conflict("directory already exists");
    if (resolved.exists && !(await lstat(resolved.absolute)).isDirectory())
      throw conflict("path is not a directory");
    await mkdir(resolved.absolute, { recursive: true });
    return { path: resolved.relative, type: "directory" };
  }
  if (resolved.exists && !opts.overwrite) throw conflict("file already exists");
  return writeFileContentLocked(ws, relativePath, opts.content ?? "", {
    encoding: opts.encoding,
    createOnly: !opts.overwrite,
  });
}

export async function moveWorkspaceEntry(
  ws: WorkspaceRecord,
  from: string,
  to: string,
  overwrite = false,
  signal?: AbortSignal,
): Promise<FileOperationResponse> {
  return withWorkspaceMutation(
    ws,
    2 * (from.length + to.length),
    signal,
    () => moveWorkspaceEntryLocked(ws, from, to, overwrite),
  );
}

async function moveWorkspaceEntryLocked(
  ws: WorkspaceRecord,
  from: string,
  to: string,
  overwrite: boolean,
): Promise<FileOperationResponse> {
  const source = resolveWorkspacePath(ws.canonicalRoot, from);
  const target = resolveWorkspacePath(ws.canonicalRoot, to);
  if (!source.exists || source.relative === "")
    throw new PathSafetyError("INVALID_REQUEST", "source does not exist");
  if (target.relative === "")
    throw new PathSafetyError(
      "INVALID_REQUEST",
      "cannot replace workspace root",
    );
  if (source.relative === target.relative) {
    // No-op move; rename would clobber the target it was already renamed from.
    const moved = await lstat(source.absolute);
    return {
      path: source.relative,
      type: moved.isDirectory() ? "directory" : "file",
    };
  }
  const latestSource = resolveWorkspacePath(ws.canonicalRoot, from);
  if (latestSource.absolute !== source.absolute)
    throw new PathSafetyError("SYMLINK_ESCAPE", "source changed during move");
  const targetParent = path.posix.dirname(target.relative);
  resolveWorkspacePath(
    ws.canonicalRoot,
    targetParent === "." ? "" : targetParent,
  );
  const targetPath = target.isSymlink
    ? lexicalPath(ws, target.relative)
    : target.absolute;
  const sourceLexicalPath = lexicalPath(ws, source.relative);
  if (
    process.platform === "win32" &&
    sourceLexicalPath.toLowerCase() === targetPath.toLowerCase() &&
    sourceLexicalPath !== targetPath
  ) {
    const intermediate = `${sourceLexicalPath}.ompiui-case-${randomUUID()}`;
    await rename(sourceLexicalPath, intermediate);
    try {
      await rename(intermediate, targetPath);
    } catch (error) {
      await rename(intermediate, sourceLexicalPath).catch(() => undefined);
      throw error;
    }
    const moved = await lstat(targetPath);
    return {
      path: target.relative,
      type: moved.isDirectory() ? "directory" : "file",
    };
  }
  let backupPath: string | undefined;
  if (target.exists) {
    if (!overwrite) throw conflict("target already exists");
    backupPath = `${targetPath}.ompiui-backup-${randomUUID()}`;
    await rename(targetPath, backupPath);
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  const sourcePath = source.isSymlink ? sourceLexicalPath : source.absolute;
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    if (backupPath) await rename(backupPath, targetPath).catch(() => undefined);
    throw error;
  }
  if (backupPath) await rm(backupPath, { recursive: true, force: true });
  const moved = await lstat(targetPath);
  return {
    path: target.relative,
    type: moved.isDirectory() ? "directory" : "file",
  };
}

export async function deleteWorkspaceEntry(
  ws: WorkspaceRecord,
  relativePath: string,
  recursive = false,
  signal?: AbortSignal,
): Promise<void> {
  return withWorkspaceMutation(
    ws,
    2 * relativePath.length,
    signal,
    () => deleteWorkspaceEntryLocked(ws, relativePath, recursive),
  );
}

async function deleteWorkspaceEntryLocked(
  ws: WorkspaceRecord,
  relativePath: string,
  recursive: boolean,
): Promise<void> {
  const resolved = resolveWorkspacePath(ws.canonicalRoot, relativePath);
  if (!resolved.exists || resolved.relative === "")
    throw new PathSafetyError("INVALID_REQUEST", "path does not exist");
  const target = resolved.isSymlink
    ? lexicalPath(ws, resolved.relative)
    : resolved.absolute;
  const stat = await lstat(target);
  if (stat.isDirectory() && !recursive) {
    const children = await readdir(target);
    if (children.length > 0) throw conflict("directory is not empty");
  }
  await rm(target, {
    recursive: recursive && stat.isDirectory(),
    force: false,
  });
}

async function describeEntry(
  ws: WorkspaceRecord,
  parent: string,
  name: string,
): Promise<FileNodeDto | null> {
  const relative = parent ? `${parent}/${name}` : name;
  const lexical = lexicalPath(ws, relative);
  try {
    const stat = await lstat(lexical);
    if (stat.isSymbolicLink()) {
      try {
        resolveWorkspacePath(ws.canonicalRoot, relative);
        return {
          name,
          path: relative,
          type: "symlink",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch (error) {
        if (error instanceof PathSafetyError)
          return { name, path: relative, type: "symlink", restricted: true };
        throw error;
      }
    }
    return {
      name,
      path: relative,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.isFile() ? stat.size : undefined,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function lexicalPath(ws: WorkspaceRecord, relative: string): string {
  return path.join(ws.canonicalRoot, ...relative.split("/"));
}

function decodeContent(
  content: string,
  encoding: "utf-8" | "base64" = "utf-8",
): Buffer {
  if (typeof content !== "string")
    throw new PathSafetyError("INVALID_REQUEST", "content must be a string");
  if (encoding === "base64") {
    const normalized = content.replace(/\s/g, "");
    if (
      normalized.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
      throw new PathSafetyError("INVALID_REQUEST", "invalid base64 content");
    }
    return Buffer.from(normalized, "base64");
  }
  return Buffer.from(content, "utf8");
}

function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function mimeType(filePath: string, binary: boolean): string {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    ".css": "text/css",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".mjs": "text/javascript",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ts": "text/typescript",
    ".tsx": "text/typescript-jsx",
    ".txt": "text/plain",
    ".wasm": "application/wasm",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xml": "application/xml",
  };
  return (
    known[extension] ?? (binary ? "application/octet-stream" : "text/plain")
  );
}

function etag(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

function normalizeEtag(value: string): string {
  return value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(`${offset}:${fingerprint}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): {
  offset: number;
  fingerprint?: string;
} {
  if (!cursor) return { offset: 0 };
  if (!/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new PathSafetyError("INVALID_REQUEST", "invalid directory cursor");
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = decoded.match(/^(\d+):([A-Za-z0-9_-]{12})$/);
  if (!match)
    throw new PathSafetyError("INVALID_REQUEST", "invalid directory cursor");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new PathSafetyError("INVALID_REQUEST", "invalid directory cursor");
  return { offset: value, fingerprint: match[2] };
}

function staleRevision(): Error {
  return Object.assign(new Error("etag mismatch"), {
    code: "STALE_REVISION" as const,
  });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: "FILE_CONFLICT" as const });
}

function fileTooLarge(message: string): Error {
  return Object.assign(new Error(message), { code: "FILE_TOO_LARGE" as const });
}

function assertWorkspaceCurrent(ws: WorkspaceRecord): void {
  if (ws.rootIdentity === undefined) return;
  try {
    const resolved = realpathSync.native(path.resolve(ws.canonicalRoot));
    const identity = fileIdentity(statSync(resolved));
    if (
      workspacePathKey(resolved) !== workspacePathKey(ws.canonicalRoot) ||
      identity !== ws.rootIdentity
    ) {
      throw workspaceReplaced(ws.canonicalRoot);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "WORKSPACE_REPLACED"
    )
      throw error;
    throw workspaceReplaced(ws.canonicalRoot);
  }
}

function fileIdentity(value: { dev: number; ino: number }): string {
  return `${value.dev}:${value.ino}`;
}

function workspaceReplaced(rootPath: string): Error {
  return Object.assign(new Error(`workspace root was replaced: ${rootPath}`), {
    code: "WORKSPACE_REPLACED",
  });
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  if (left.ino === 0 || right.ino === 0) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

async function withWorkspaceMutation<T>(
  ws: WorkspaceRecord,
  retainedStringBytes: number,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw requestAborted();
  const key = workspacePathKey(ws.canonicalRoot);
  const current = workspaceMutations.get(key);
  // 排队或执行期间计量 UTF-16 存储，包括编码后的上传内容；
  // 任务数上限同时约束空写入请求和 Promise 的额外开销。
  const bytes = retainedStringBytes + 2 * ws.canonicalRoot.length;
  if (
    pendingMutationBytes + bytes > MAX_PENDING_MUTATION_BYTES ||
    pendingMutations >= MAX_PENDING_MUTATIONS ||
    (current?.bytes ?? 0) + bytes > MAX_WORKSPACE_MUTATION_BYTES ||
    (current?.count ?? 0) >= MAX_WORKSPACE_MUTATIONS
  ) {
    throw Object.assign(new Error("workspace mutation capacity reached"), {
      code: "RATE_LIMITED",
      retryable: true,
    });
  }
  const queue = current ?? {
    pool: new QueryPool(1, MAX_WORKSPACE_MUTATIONS - 1),
    bytes: 0,
    count: 0,
  };
  if (!current) workspaceMutations.set(key, queue);
  queue.bytes += bytes;
  queue.count++;
  pendingMutationBytes += bytes;
  pendingMutations++;
  try {
    return await queue.pool.run(signal, async () => {
      const lock = await acquireWorkspaceMutationLock(ws.canonicalRoot, { signal });
      try {
        if (signal?.aborted) throw requestAborted();
        assertWorkspaceCurrent(ws);
        // 取消仅适用于执行前；已提交的写入不能误报为取消，
        // 后续修改也不能与执行中的写入竞争。
        return await operation();
      } finally {
        lock.release();
      }
    });
  } finally {
    queue.bytes -= bytes;
    queue.count--;
    pendingMutationBytes -= bytes;
    pendingMutations--;
    if (queue.count === 0) workspaceMutations.delete(key);
  }
}
