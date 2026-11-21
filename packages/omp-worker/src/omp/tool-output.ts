import { constants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { utf8Prefix } from "@ompiui/protocol";

const OUTPUT_CHUNK_BYTES = 128 * 1024;
const WINDOWS_LOCAL_ROOT_MAX_CHARS = 180;

export async function readSessionToolOutput(
  sessionFile: string,
  sessionId: string,
  artifactId: string,
  offset: number,
  revision?: string,
) {
  if (!/^(0|[1-9]\d*)$/.test(artifactId)) {
    throw Object.assign(new Error("Invalid tool output artifact id"), { code: "INVALID_REQUEST" });
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw Object.assign(new Error("Invalid tool output offset"), { code: "INVALID_REQUEST" });
  }

  let resolvedSessionFile = sessionFile;
  try { resolvedSessionFile = await fs.realpath(sessionFile); } catch {}
  if (!resolvedSessionFile.endsWith(".jsonl")) {
    throw Object.assign(new Error("Session artifact directory is unavailable"), { code: "NOT_FOUND" });
  }
  const artifactsDir = resolvedSessionFile.slice(0, -".jsonl".length);
  let localRoot = path.resolve(artifactsDir, "local");
  if (process.platform === "win32" && localRoot.length >= WINDOWS_LOCAL_ROOT_MAX_CHARS) {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    localRoot = path.join(tmpdir(), "omp-local", safeSessionId && safeSessionId !== "." && safeSessionId !== ".." ? safeSessionId : "session");
  }

  const root = await fs.realpath(localRoot).catch(() => undefined);
  if (!root) throw Object.assign(new Error("Tool output artifact not found"), { code: "NOT_FOUND" });
  const candidate = path.join(root, `${artifactId}.log`);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await fs.open(candidate, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    const pathInfo = await fs.lstat(candidate);
    if (!before.isFile() || pathInfo.isSymbolicLink() || !pathInfo.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino) {
      throw Object.assign(new Error("Tool output artifact not found"), { code: "NOT_FOUND" });
    }
    const currentRevision = `${before.size}:${before.mtimeMs}`;
    if (revision && revision !== currentRevision) {
      throw Object.assign(new Error("Tool output changed while loading"), { code: "OUTPUT_CHANGED" });
    }
    if (offset > before.size) throw Object.assign(new Error("Invalid tool output offset"), { code: "INVALID_REQUEST" });
    const buffer = Buffer.allocUnsafe(Math.min(OUTPUT_CHUNK_BYTES + 4, before.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.toString("utf8", 0, bytesRead);
    const data = utf8Prefix(text, OUTPUT_CHUNK_BYTES);
    const nextOffset = offset + Buffer.byteLength(data, "utf8");
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw Object.assign(new Error("Tool output changed while loading"), { code: "OUTPUT_CHANGED" });
    }
    return {
      data,
      nextOffset,
      totalBytes: before.size,
      hasMore: nextOffset < before.size,
      revision: currentRevision,
    };
  } finally {
    await handle.close();
  }
}
