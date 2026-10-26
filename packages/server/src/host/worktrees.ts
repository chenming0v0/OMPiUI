import path from "node:path";
import fs from "node:fs/promises";
import { runGit, invalidateGitCache } from "./git.ts";
import type { GitWorktree, GitWorktreeCatalog } from "@ompiui/protocol";

const mutations = new Map<string, string>();
const pendingAttachments = new Map<string, number>();
function key(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Match Git's physical paths, including targets below a junction or symlink. */
async function resolveWorktreeTarget(target: string): Promise<string> {
  let ancestor = target;
  for (;;) {
    try {
      const real = await fs.realpath(ancestor);
      return ancestor === target ? real : path.resolve(real, path.relative(ancestor, target));
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/** Block a new host attachment while its checkout is being mutated. */
export function assertWorktreeAvailable(cwd: string): void {
  for (const target of mutations.values()) {
    const relative = path.relative(target, key(cwd));
    if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw Object.assign(new Error("Worktree mutation is in progress; wait before opening a native session"), { code: "WORKSPACE_BUSY" });
    }
  }
}

/** Mutation/launch admission is synchronous; browsing never takes this gate. */
export function beginWorktreeAttachment(cwd: string): () => void {
  assertWorktreeAvailable(cwd);
  const directory = key(cwd);
  pendingAttachments.set(directory, (pendingAttachments.get(directory) ?? 0) + 1);
  return () => {
    const count = (pendingAttachments.get(directory) ?? 1) - 1;
    if (count) pendingAttachments.set(directory, count);
    else pendingAttachments.delete(directory);
  };
}
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await runGit(cwd, args, { signal });
  if (result.code !== 0) throw Object.assign(new Error(result.stderr.toString("utf8").trim() || `git ${args[0]} failed`), { code: "FILE_CONFLICT" });
  return result.stdout.toString("utf8");
}

/** NUL-separated porcelain keeps spaces, Unicode, and quoted Git paths exact. */
export async function listGitWorktrees(cwd: string, signal?: AbortSignal): Promise<GitWorktreeCatalog> {
  const records = (await git(cwd, ["worktree", "list", "--porcelain", "-z"], signal)).split("\0\0").filter(Boolean);
  const worktrees: GitWorktree[] = records.map(record => {
    const fields = record.split("\0");
    const value = (name: string) => fields.find(field => field.startsWith(`${name} `))?.slice(name.length + 1);
    const root = value("worktree");
    if (!root) throw new Error("Git returned a worktree without a path");
    return { path: root, head: value("HEAD") ?? null, branch: value("branch") ?? null,
      detached: fields.includes("detached"), bare: fields.includes("bare"),
      locked: fields.some(field => field === "locked" || field.startsWith("locked ")),
      lockReason: value("locked") ?? null,
      prunable: fields.some(field => field === "prunable" || field.startsWith("prunable ")) };
  });
  if (!worktrees.length) throw new Error("Git returned no worktrees");
  return { primaryRoot: worktrees[0].path, worktrees };
}

/** Explicit mutations only; never force, clean, prune, or remove a branch. */
export async function mutateGitWorktree(cwd: string, operation: "create" | "remove", target: string, branch: string | undefined,
  assertUnused: ((target: string) => void) | undefined, signal?: AbortSignal): Promise<GitWorktreeCatalog> {
  const resolved = await resolveWorktreeTarget(path.resolve(cwd, target));
  const catalog = await listGitWorktrees(cwd, signal);
  const rootKey = key(catalog.primaryRoot);
  if (mutations.has(rootKey)) throw Object.assign(new Error("Another worktree operation is in progress"), { code: "WORKSPACE_BUSY" });
  mutations.set(rootKey, key(resolved));
  try {
    if (operation === "create") {
      if (!branch?.trim()) throw Object.assign(new Error("A new branch name is required"), { code: "INVALID_REQUEST" });
      // Match the official addWorktree preflight before creating a branch.
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory() || (await fs.readdir(resolved)).length) {
          throw Object.assign(new Error(`Worktree path is already occupied: ${resolved}`), { code: "FILE_CONFLICT" });
        }
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      await git(cwd, ["check-ref-format", "--branch", branch], signal);
      // Git enforces occupied paths and already-checked-out branches; no --force.
      await git(cwd, ["worktree", "add", "-b", branch, "--", resolved, "HEAD"], signal);
    } else {
      const entry = catalog.worktrees.find(item => key(item.path) === key(resolved));
      if (!entry || key(entry.path) === rootKey || entry.bare || entry.locked || entry.prunable) {
        throw Object.assign(new Error("Select a present, unlocked linked worktree; the primary checkout cannot be removed"), { code: "FORBIDDEN" });
      }
      for (const directory of pendingAttachments.keys()) {
        const relative = path.relative(key(entry.path), directory);
        if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
          throw Object.assign(new Error("A native session is opening in this worktree; nothing was removed"), { code: "WORKSPACE_BUSY" });
        }
      }
      assertUnused?.(entry.path);
      // Recheck dirt via Git; worktree remove itself also checks it at mutation time.
      if (await git(entry.path, ["status", "--porcelain", "-z", "--untracked-files=all"], signal)) {
        throw Object.assign(new Error("Worktree has modified or untracked files; commit or move them first. Nothing was removed."), { code: "FILE_CONFLICT" });
      }
      await git(cwd, ["worktree", "remove", "--", entry.path], signal);
    }
    invalidateGitCache(cwd);
    return await listGitWorktrees(cwd, signal);
  } finally { mutations.delete(rootKey); }
}
