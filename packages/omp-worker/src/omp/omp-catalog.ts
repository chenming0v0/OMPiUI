import { spawn } from "node:child_process";
import {
  existsSync,
  promises as fs,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BranchSyncRequest,
  JsonObject,
  JsonValue,
} from "@ompiui/protocol";
import {
  goalMessagePreview,
  isJsonObject,
  requireJsonValue,
  utf8Prefix,
} from "@ompiui/protocol";
import type { CatalogProvider } from "../runtime.js";
import type { PackagesGateway } from "../command-table.js";
import {
  entriesPageFromEntries,
  imageAttachmentFromEntry,
  sessionHeadFromParts,
} from "../runtime/pagination.js";
import { OmpRpcClient, unwrapResponse } from "./rpc-client.js";
import { detectOmpVersion } from "./omp-version.js";
import { OMP_SDK_VERSION } from "./constants.js";
import { sessionTreePage } from "../runtime/session-tree.js";
import {
  assertOmpSessionFile,
  isManagedSessionFile,
  isOmpSessionFile,
  managedSessionsRoot,
  ompSessionRootFor,
  ompSessionRoots,
} from "./managed-sessions.js";
import { ompAgentDirectory } from "./omp-directories.js";
import { sessionConfigFromBranch } from "./session-config.js";
import { BranchPageReader } from "../runtime/branch-pages.js";
import {
  resolveOmpConfigCommand,
  type OmpConfigCommand,
} from "./omp-config-command.js";
import { scanJsonl, mapLimited, type JsonlPosition } from "./jsonl-reader.js";
import { readSubagentPreview } from "./subagent-preview.js";
import { readSubagentSync } from "./subagent-sync.js";
import type { SubagentSyncRequest } from "@ompiui/protocol";

/**
 * OmpCatalog —— CatalogProvider 的 OMP 实现。
 *
 * OMP RPC 没有"列出所有会话"的命令，但会话本身就是 JSONL 文件
 * （~/.omp/agent/sessions/<encoded-cwd>/*.jsonl，fork 自 Pi 的格式）：
 * - 第 1 行 {type:"title", title}（重命名会追加新 title 行）
 * - 第 2 行 {type:"session", version, id, timestamp, cwd}
 * 之后是 message/model_change/branch_summary... 条目。
 * 目录扫描 + 头部解析即可实现 list/preview/delete，无需进程内 SDK。
 *
 * 模型列表通过短生命周期的控制 RPC 进程 get_available_models 获取。
 */

export function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/");
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (/^file:\/\//i.test(trimmed)) {
    return path.resolve(fileURLToPath(trimmed));
  }
  if (trimmed === "~") return homedir();
  if (
    trimmed.startsWith("~/") ||
    (process.platform === "win32" && trimmed.startsWith("~\\"))
  ) {
    return path.resolve(homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function ompAgentDir(): string {
  return ompAgentDirectory();
}

/** OMP 子代理会话目录：<parent>.jsonl 去后缀的同名目录 */
function childSessionDir(parentSessionFile: string): string | null {
  const target = resolveUserPath(parentSessionFile);
  if (!target.endsWith(".jsonl")) return null;
  return target.slice(0, -".jsonl".length);
}

/** 磁盘预览丢弃的元数据条目（与 OmpRpcSession.adaptEntry 的丢弃清单一致） */
const DROPPED_META_ENTRY_TYPES = new Set([
  "title",
  "title_change",
  "model_usage",
  "session",
  "session_init",
]);

/** 父会话标题缓存：mtime 不变就不重读整文件（listChildSessions 的卡死帮凶） */
const subagentTitleCache = new Map<
  string,
  { mtime: number; titles: Map<string, string>; position?: JsonlPosition }
>();
/** 子会话摘要缓存：文件没变就复用（历史子会话挂载时不再次 JSON.parse） */
const sessionSummaryCache = new Map<
  string,
  {
    mtime: number;
    titlesStamp: string;
    summary: SessionFileSummary | null;
    position?: JsonlPosition;
    fallbackTitle?: boolean;
  }
>();
const sessionIdIndex = new Map<string, string>();

/**
 * 会话 JSONL 行 → 预览条目。元数据行（title/title_change/session/
 * session_init/model_usage）换成 omp.dropped 占位：直接透传会让前端渲染
 * 成 unknown 行，整行丢弃又会断掉活跃分支回溯的 parentId 链。
 */
export function previewEntriesFromLines(
  raw: string[],
  fallbackIdPrefix: string,
): JsonObject[] {
  const entries: JsonObject[] = [];
  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isJsonObject(parsed)) continue;
      entries.push(previewEntry(parsed, fallbackIdPrefix, entries.length));
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
}

function previewEntry(
  parsed: JsonObject,
  prefix: string,
  index: number,
): JsonObject {
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (DROPPED_META_ENTRY_TYPES.has(type))
    return {
      type: "omp.dropped",
      id: typeof parsed.id === "string" ? parsed.id : `${prefix}:${index}`,
      parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      droppedType: type,
      ...(type === "session_init" && typeof parsed.resolvedModel === "string"
        ? { resolvedModel: parsed.resolvedModel }
        : {}),
    };
  return {
    ...parsed,
    id: typeof parsed.id === "string" ? parsed.id : `${prefix}:${index}`,
  };
}

/** OMP 给每个子代理注入的包装提示词，不能当会话标题。 */
const WRAPPING_ASSIGNMENT = /^complete assignment thoroughly\b/i;

function firstUsefulTitle(...candidates: Array<unknown>): string | undefined {
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const line = value
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean);
    if (!line || WRAPPING_ASSIGNMENT.test(line)) continue;
    return line;
  }
  return undefined;
}

interface SessionFileSummary {
  id: string;
  cwd: string;
  path: string;
  name: string | null;
  firstMessage: string | null;
  created: string | null;
  modified: number;
  messageCount: number;
}

type DiskBranchEntry = JsonObject & { id: string };

type DiskPageParams = BranchSyncRequest & {
  cursor?: string;
  limit?: number;
  maxBytes?: number;
};

type DiskBranchCache = {
  modified: number;
  entries: readonly DiskBranchEntry[];
  reader: BranchPageReader<DiskBranchEntry>;
  allEntries: JsonObject[];
  position?: JsonlPosition;
};

async function summarizeSessionFile(
  filePath: string,
  childTitles?: Map<string, string>,
): Promise<SessionFileSummary | null> {
  const cached = sessionSummaryCache.get(filePath);
  let id = cached?.summary?.id ?? "";
  let cwd = cached?.summary?.cwd ?? "";
  let created = cached?.summary?.created ?? null;
  let name = cached?.summary?.name ?? null;
  let firstMessage = cached?.summary?.firstMessage ?? null;
  let messageCount = cached?.summary?.messageCount ?? 0;
  let fallbackTitle = cached?.fallbackTitle ?? false;
  let isSubagent = false;
  let position: JsonlPosition;
  try {
    position = await scanJsonl(
      filePath,
      cached?.position,
      (entry) => {
        const type = entry.type;
        if (type === "session") {
          id = typeof entry.id === "string" ? entry.id : "";
          cwd = typeof entry.cwd === "string" ? entry.cwd : "";
          created =
            typeof entry.timestamp === "string" ? entry.timestamp : null;
          if (!name) name = firstUsefulTitle(entry.name) ?? name;
        } else if (type === "title" || type === "title_change") {
          // title 是固定宽度首行槽；OMP 18.x 的自动/手动标题写在后续 title_change。
          // 空槽和包装提示词都不能盖掉已有标题；后写入的用户改名覆盖先前的。
          const titled = firstUsefulTitle(entry.title);
          if (titled) {
            name = titled;
            fallbackTitle = false;
          }
        } else if (type === "session_init") {
          isSubagent = typeof entry.agent === "string" && Boolean(entry.agent);
          if (!name) {
            name =
              firstUsefulTitle(
                childTitles?.get(path.basename(filePath, ".jsonl")),
                entry.agent,
              ) ?? name;
            fallbackTitle = true;
          }
        } else if (type === "message") {
          messageCount += 1;
          if (
            !firstMessage &&
            isJsonObject(entry.message) &&
            entry.message.role === "user"
          ) {
            const content = entry.message.content;
            if (typeof content === "string") firstMessage = content;
            else if (Array.isArray(content)) {
              const text = content.find(
                (block) => isJsonObject(block) && block.type === "text",
              );
              if (isJsonObject(text) && typeof text.text === "string")
                firstMessage = text.text;
            }
          }
        }
      },
      () => {
        id = "";
        cwd = "";
        created = null;
        name = null;
        firstMessage = null;
        messageCount = 0;
        fallbackTitle = false;
      },
    );
  } catch {
    return null;
  }
  if (!name && (isSubagent || childTitles)) {
    const taskName = path.basename(filePath, ".jsonl");
    name = firstUsefulTitle(childTitles?.get(taskName), taskName) ?? taskName;
    fallbackTitle = true;
  }
  if (fallbackTitle && childTitles)
    name =
      firstUsefulTitle(
        childTitles.get(path.basename(filePath, ".jsonl")),
        name,
      ) ?? name;
  if (!id || !cwd) return null;
  const summary = {
    id,
    cwd,
    path: filePath,
    name: name ? utf8Prefix(name, 512) : name,
    firstMessage: firstMessage
      ? utf8Prefix(goalMessagePreview(firstMessage), 1024)
      : firstMessage,
    created,
    modified: position.modified,
    messageCount,
  };
  sessionSummaryCache.set(filePath, {
    mtime: position.modified,
    titlesStamp: "",
    summary,
    position,
    fallbackTitle,
  });
  sessionIdIndex.set(id, filePath);
  if (sessionIdIndex.size > 4096)
    sessionIdIndex.delete(sessionIdIndex.keys().next().value!);
  return summary;
}

async function summarizeSessionFileCached(
  filePath: string,
  childTitles?: Map<string, string>,
): Promise<SessionFileSummary | null> {
  let mtime = 0;
  let size = 0;
  let inode = 0;
  try {
    const stat = await fs.stat(filePath);
    mtime = stat.mtimeMs;
    size = stat.size;
    inode = stat.ino;
  } catch {
    sessionSummaryCache.delete(filePath);
    return null;
  }
  // titlesStamp：父会话标题映射变了才重算 name（子会话文件本身没变）
  const titlesStamp = childTitles
    ? [...childTitles.entries()]
        .map(([id, title]) => `${id}=${title}`)
        .join("|")
    : "";
  const cached = sessionSummaryCache.get(filePath);
  if (
    cached &&
    cached.mtime === mtime &&
    cached.position?.size === size &&
    cached.position.inode === inode &&
    cached.titlesStamp === titlesStamp
  )
    return cached.summary;
  const summary = await summarizeSessionFile(filePath, childTitles);
  const updated = sessionSummaryCache.get(filePath);
  sessionSummaryCache.set(filePath, {
    mtime,
    titlesStamp,
    summary,
    position: updated?.position,
    fallbackTitle: updated?.fallbackTitle,
  });
  while (sessionSummaryCache.size > 4096)
    sessionSummaryCache.delete(sessionSummaryCache.keys().next().value!);
  return summary;
}

/** 子会话的包装提示词不是标题；从父 task 的具名任务和结果摘要取名。 */
async function readSubagentTitles(
  parentSessionFile: string,
): Promise<Map<string, string>> {
  let mtime = 0;
  let size = 0;
  try {
    const stat = await fs.stat(parentSessionFile);
    mtime = stat.mtimeMs;
    size = stat.size;
  } catch {
    return new Map();
  }
  const cached = subagentTitleCache.get(parentSessionFile);
  if (cached && cached.mtime === mtime && cached.position?.size === size)
    return cached.titles;
  const titles = new Map(cached?.titles);
  const position = await scanJsonl(
    parentSessionFile,
    cached?.position,
    (entry) => {
      if (entry.type !== "message" || !isJsonObject(entry.message)) return;
      const message = entry.message;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (
            !isJsonObject(block) ||
            block.type !== "toolCall" ||
            block.name !== "task" ||
            !isJsonObject(block.arguments)
          )
            continue;
          if (!Array.isArray(block.arguments.tasks)) continue;
          for (const task of block.arguments.tasks) {
            if (
              !isJsonObject(task) ||
              typeof task.name !== "string" ||
              !task.name
            )
              continue;
            titles.set(
              task.name,
              firstUsefulTitle(task.description, task.name) ?? task.name,
            );
          }
        }
      } else if (
        message.role === "toolResult" &&
        message.toolName === "task" &&
        isJsonObject(message.details)
      ) {
        if (!Array.isArray(message.details.results)) return;
        for (const result of message.details.results) {
          if (
            !isJsonObject(result) ||
            typeof result.id !== "string" ||
            !result.id
          )
            continue;
          titles.set(
            result.id,
            firstUsefulTitle(result.description, result.id) ?? result.id,
          );
        }
      }
    },
    () => titles.clear(),
  );
  subagentTitleCache.set(parentSessionFile, { mtime, titles, position });
  while (subagentTitleCache.size > 32)
    subagentTitleCache.delete(subagentTitleCache.keys().next().value!);
  return titles;
}

function listSessionFiles(): string[] {
  const files: string[] = [];
  for (const root of [...ompSessionRoots(), managedSessionsRoot()]) {
    if (!existsSync(root)) continue;
    // 配置的 PI_CODING_AGENT_SESSION_DIR 为扁平目录(官方 CLI 直接写入该目录,不建 cwd 子目录)。
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(path.join(root, entry.name));
    }
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(root, dir.name);
      try {
        for (const file of readdirSync(dirPath)) {
          if (file.endsWith(".jsonl")) files.push(path.join(dirPath, file));
        }
      } catch {
        /* unreadable directory */
      }
    }
  }
  return files;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  let canonical = resolved;
  try {
    // OMP 会将 Windows 短路径展开后写入会话头；按真实目录匹配同一项目。
    canonical =
      process.platform === "win32"
        ? realpathSync.native(resolved)
        : realpathSync(resolved);
  } catch {
    /* 目录已删除或不可访问时保留原路径。 */
  }
  const normalized = normalizeCwd(canonical);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 短生命周期控制 RPC 进程：跑一条命令就退（模型列表等无会话查询） */
async function withControlRpc<T>(
  cwd: string,
  run: (client: OmpRpcClient) => Promise<T>,
): Promise<T> {
  const client = new OmpRpcClient({
    cwd,
    args: ["--no-session"],
    env: { PIUI_EMBEDDED: "1" },
  });
  try {
    await client.waitForReady(30_000);
    await client.request({ type: "negotiate_protocol", protocolVersion: 2 });
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** 进程内共享的长驻控制 RPC（provider 认证流程需要一个稳定 stdin/stdout 对） */
export class OmpControlChannel {
  private client: OmpRpcClient | undefined;
  private starting: Promise<OmpRpcClient> | undefined;

  constructor(private readonly cwd = homedir()) {}

  async acquire(): Promise<OmpRpcClient> {
    if (this.client && !this.client.hasExited) return this.client;
    this.starting ??= (async () => {
      const client = new OmpRpcClient({
        cwd: this.cwd,
        args: ["--no-session"],
        env: { PIUI_EMBEDDED: "1" },
      });
      await client.waitForReady(30_000);
      await client.request({ type: "negotiate_protocol", protocolVersion: 2 });
      client.on("exit", () => {
        if (this.client === client) this.client = undefined;
      });
      this.client = client;
      return client;
    })();
    try {
      return await this.starting;
    } catch (error) {
      this.starting = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}

export class OmpCatalog implements CatalogProvider, PackagesGateway {
  readonly control = new OmpControlChannel();
  private readonly diskBranchCaches = new Map<string, DiskBranchCache>();
  private readonly diskReads = new Map<string, Promise<DiskBranchCache>>();
  private summarizeFlight?: Promise<SessionFileSummary[]>;

  async listSessions(cwd: string): Promise<JsonValue> {
    const wanted = pathKey(cwd);
    const summaries = await this.summarizeAll();
    return summaries
      .filter((item) => pathKey(item.cwd) === wanted)
      .map(toSessionInfo);
  }

  async listAllSessions(): Promise<JsonValue> {
    const summaries = await this.summarizeAll();
    return summaries.map(toSessionInfo);
  }

  private summarizeCache: { at: number; items: SessionFileSummary[] } | null =
    null;

  private async summarizeAll(): Promise<SessionFileSummary[]> {
    // 会话列表扫描全量文件是 catalog 里最贵的操作：2s 缓存
    if (this.summarizeCache && Date.now() - this.summarizeCache.at < 2_000) {
      return this.summarizeCache.items;
    }
    if (this.summarizeFlight) return this.summarizeFlight;
    this.summarizeFlight = (async () => {
      const results = await mapLimited(listSessionFiles(), (file) =>
        summarizeSessionFileCached(file),
      );
      const items = results.filter(
        (item): item is SessionFileSummary => item !== null,
      );
      items.sort((a, b) => b.modified - a.modified);
      this.summarizeCache = { at: Date.now(), items };
      return items;
    })().finally(() => {
      this.summarizeFlight = undefined;
    });
    return this.summarizeFlight;
  }

  async createSession(cwd: string): Promise<JsonValue> {
    // OMP 在 session.open 时自动开新会话：这里返回占位身份，
    // 真实 sessionId 以 openRuntime 返回的 state 为准
    return { sessionId: `pending-${Date.now()}`, sessionFile: null, cwd };
  }

  async previewSession(
    cwd: string,
    sessionFile: string,
    params: DiskPageParams = {},
  ): Promise<JsonValue> {
    const target = resolveUserPath(sessionFile);
    assertOmpSessionFile(target);
    const summary = await summarizeSessionFileCached(target);
    if (!summary)
      throw Object.assign(new Error("session file not found"), {
        code: "SESSION_NOT_FOUND",
      });
    return this.previewSummary(
      summary,
      params,
      (await detectOmpVersion()) ?? OMP_SDK_VERSION,
    );
  }

  private async diskEntries(
    summary: SessionFileSummary,
  ): Promise<DiskBranchCache> {
    const flight = this.diskReads.get(summary.path);
    if (flight) return flight;
    const previous = this.diskBranchCaches.get(summary.path);
    const reading = (async () => {
      const cache: DiskBranchCache = previous ?? {
        modified: 0,
        entries: [],
        allEntries: [],
        reader: new BranchPageReader(),
      };
      const position = await scanJsonl(
        summary.path,
        cache.position,
        (entry) =>
          cache.allEntries.push(
            previewEntry(entry, summary.id, cache.allEntries.length),
          ),
        () => {
          cache.allEntries = [];
          cache.reader.clear();
        },
      );
      if (position !== cache.position) {
        cache.entries = activeBranchFromEntries(cache.allEntries).filter(
          (entry): entry is DiskBranchEntry => typeof entry.id === "string",
        );
        cache.position = position;
        cache.modified = position.modified;
      }
      this.diskBranchCaches.delete(summary.path);
      this.diskBranchCaches.set(summary.path, cache);
      let bytes = [...this.diskBranchCaches.values()].reduce(
        (total, item) => total + (item.position?.size ?? 0),
        0,
      );
      for (const [key, item] of this.diskBranchCaches) {
        if (this.diskBranchCaches.size <= 32 && bytes <= 128 * 1024 * 1024)
          break;
        if (key === summary.path) continue;
        bytes -= item.position?.size ?? 0;
        this.diskBranchCaches.delete(key);
      }
      return cache;
    })().finally(() => this.diskReads.delete(summary.path));
    this.diskReads.set(summary.path, reading);
    return reading;
  }

  private async previewSummary(
    summary: SessionFileSummary,
    params: DiskPageParams,
    sdkVersion: string = OMP_SDK_VERSION,
    stateOnly = false,
  ): Promise<JsonValue> {
    const cache = await this.diskEntries(summary);
    const entries = cache.allEntries;
    const branch = [...cache.entries];
    const config = sessionConfigFromBranch(branch);
    const header: JsonObject = {
      version: 3,
      id: summary.id,
      cwd: summary.cwd,
      name: summary.name,
    };
    const head = sessionHeadFromParts(
      {
        sdkVersion,
        revision: summary.modified,
        sessionFormatVersion: 3,
        header,
        leafId:
          typeof branch.at(-1)?.id === "string"
            ? (branch.at(-1)!.id as string)
            : null,
        entryCount: entries.length,
      },
      [summary.id, summary.path],
    );
    const page = stateOnly
      ? undefined
      : cache.reader.read(
          head,
          branch,
          {
            cursor: params.cursor,
            syncCursor: params.syncCursor,
            beforeId: params.beforeId,
            limit: params.limit ?? 100,
            maxBytes: params.maxBytes ?? 2 * 1024 * 1024,
          },
          (entry) => entry,
        );
    const state: JsonObject = {
      sessionId: summary.id,
      readOnly: false,
      diskPreview: true,
      sessionFile: summary.path,
      sessionName: summary.name,
      cwd: summary.cwd,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      isStreaming: false,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      messageCount: summary.messageCount,
      pendingMessageCount: 0,
      availableThinkingLevels: [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
      isIdle: true,
      isBashRunning: false,
      hasPendingBashMessages: false,
      isRetrying: false,
      retryAttempt: 0,
      queue: {
        steering: [],
        followUp: [],
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
      },
      supportsThinking: true,
      activeTools: [],
      scopedModels: [],
      contextUsage: null,
      sessionStats: null,
      retry: null,
      compaction: null,
      head,
    };
    return requireJsonValue({ state, branch: page });
  }

  async readSession(
    sessionId: string,
    query: string,
    params: JsonObject = {},
  ): Promise<JsonValue> {
    const found = await this.findSessionById(sessionId);
    if (!found || typeof found.sessionFile !== "string") {
      throw Object.assign(new Error("session file not found"), {
        code: "SESSION_NOT_FOUND",
      });
    }
    const summary = await summarizeSessionFileCached(found.sessionFile);
    if (!summary)
      throw Object.assign(new Error("session file not found"), {
        code: "SESSION_NOT_FOUND",
      });
    const pageParams = {
      cursor: typeof params.cursor === "string" ? params.cursor : undefined,
      syncCursor:
        typeof params.syncCursor === "string" ? params.syncCursor : undefined,
      beforeId:
        typeof params.beforeId === "string" ? params.beforeId : undefined,
      limit: typeof params.limit === "number" ? params.limit : 100,
      maxBytes:
        typeof params.maxBytes === "number" ? params.maxBytes : 2 * 1024 * 1024,
    };
    if (query === "state.get" || query === "branch.get") {
      const preview = await this.previewSummary(
        summary,
        pageParams,
        OMP_SDK_VERSION,
        query === "state.get",
      );
      if (!isJsonObject(preview)) throw new Error("Invalid session preview");
      return preview[query === "state.get" ? "state" : "branch"]!;
    }
    if (query === "subagent.messages") {
      if (typeof params.sessionFile !== "string")
        throw notFoundError("subagent session file required");
      return readChildSessionPreviewPage(
        params.sessionFile,
        typeof params.fromByte === "number" ? params.fromByte : 0,
        params.sync as SubagentSyncRequest | undefined,
      );
    }
    const entries = (await this.diskEntries(summary)).allEntries;
    if (query === "tree.get") return sessionTreePage(entries, sessionHeadFromParts({
      sdkVersion: OMP_SDK_VERSION, revision: summary.modified, header: { id: summary.id },
      leafId: null, entryCount: entries.length,
    }, [summary.id, summary.path]), pageParams);
    if (query === "attachment.get") {
      const entry = entries.find((item) => item.id === params.entryId);
      if (!entry) throw notFoundError("entry not found");
      return imageAttachmentFromEntry(
        entry,
        Number(params.blockIndex),
        typeof params.offset === "number" ? params.offset : 0,
      );
    }
    if (query === "entries.get") {
      const head = sessionHeadFromParts(
        {
          sdkVersion: OMP_SDK_VERSION,
          revision: summary.modified,
          header: { id: summary.id, cwd: summary.cwd },
          leafId:
            String(activeBranchFromEntries(entries).at(-1)?.id ?? "") || null,
          entryCount: entries.length,
        },
        [summary.id, summary.path],
      );
      return entriesPageFromEntries(
        head,
        entries,
        pageParams,
        (entry) => entry,
      );
    }
    throw Object.assign(new Error(`Unsupported disk query: ${query}`), {
      code: "CAPABILITY_DISABLED",
    });
  }

  async copySession(sessionId: string): Promise<JsonObject> {
    const found = await this.findSessionById(sessionId);
    if (
      !found ||
      typeof found.sessionFile !== "string" ||
      typeof found.cwd !== "string"
    ) {
      throw Object.assign(new Error("session file not found"), {
        code: "SESSION_NOT_FOUND",
      });
    }
    assertOmpSessionFile(found.sessionFile);
    // 显式复制也走官方 fork：原生目录、全新身份与关联附件一起保留。
    const client = new OmpRpcClient({
      cwd: found.cwd,
      args: ["--fork", found.sessionFile],
      applyRuntimePolicy: true,
      bin: process.env.OMPI_OMP_BIN,
      env: { PIUI_EMBEDDED: "1" },
    });
    try {
      await client.waitForReady();
      const state = unwrapResponse<JsonObject>(
        await client.request({ type: "get_state" }),
      );
      if (
        !isJsonObject(state) ||
        typeof state.sessionId !== "string" ||
        typeof state.sessionFile !== "string"
      ) {
        throw new Error("Invalid forked session identity");
      }
      this.summarizeCache = null;
      return {
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        cwd: found.cwd,
      };
    } finally {
      await client.close();
    }
  }

  async previewSessionById(
    sessionId: string,
    params: DiskPageParams = {},
  ): Promise<JsonValue> {
    const summaries = await this.summarizeAll();
    const match = summaries.find((item) => item.id === sessionId);
    if (match)
      return this.previewSummary(
        match,
        params,
        (await detectOmpVersion()) ?? OMP_SDK_VERSION,
      );
    // 顶层扫描没有（OMP 子代理会话嵌套在 <父会话名>/ 目录里）→ 深度查找兜底，
    // 让子会话在重载/深链后也能按 id 预览
    const found = await this.findSessionById(sessionId);
    if (
      found &&
      typeof found.sessionFile === "string" &&
      typeof found.cwd === "string"
    ) {
      return this.previewSession(found.cwd, found.sessionFile, params);
    }
    throw Object.assign(new Error(`session not found: ${sessionId}`), {
      code: "SESSION_NOT_FOUND",
    });
  }

  /**
   * 列出父会话文件旁的 OMP 子代理会话（<parent>.jsonl 同名目录下的 *.jsonl，
   * 与 OMP 子代理落盘布局一致）。顶层列表刻意不扫这一层，避免刷屏主列表。
   */
  async listChildSessions(parentSessionFile: string): Promise<JsonValue> {
    assertOmpSessionFile(resolveUserPath(parentSessionFile));
    const dir = childSessionDir(parentSessionFile);
    if (!dir || !existsSync(dir)) return [];
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const titles = await readSubagentTitles(resolveUserPath(parentSessionFile));
    const results = await mapLimited(names, (name) =>
      summarizeSessionFileCached(path.join(dir, name), titles),
    );
    return results
      .filter((item): item is SessionFileSummary => item !== null)
      .sort((a, b) => b.modified - a.modified)
      .map(toSessionInfo);
  }

  /**
   * 按会话文件直查磁盘身份：只读这一份 jsonl，不扫兄弟子会话、也不读父会话。
   * 打开子会话 / 回填转录走这条路径，避免 listChildSessions 把 worker 打满。
   */
  async findSessionByFile(sessionFile: string): Promise<JsonObject | null> {
    const target = resolveUserPath(sessionFile);
    if (!target.endsWith(".jsonl") || !isOmpSessionFile(target)) return null;
    const summary = await summarizeSessionFileCached(target);
    if (!summary) return null;
    return {
      id: summary.id,
      cwd: summary.cwd,
      sessionFile: summary.path,
      name: summary.name,
    };
  }

  /**
   * 按 session id 解析会话文件：先查顶层扫描，再扫原生与 WebUI 托管目录
   * 下的子代理会话。顶层列表仍不包含子会话，重载/深链可按 id 读取。
   */
  private readonly sessionLookupFlights = new Map<string, Promise<JsonObject | null>>();

  async findSessionById(sessionId: string): Promise<JsonObject | null> {
    const existing = this.sessionLookupFlights.get(sessionId);
    if (existing) return existing;
    const flight = this.findSessionByIdOnce(sessionId).finally(() => {
      if (this.sessionLookupFlights.get(sessionId) === flight) this.sessionLookupFlights.delete(sessionId);
    });
    this.sessionLookupFlights.set(sessionId, flight);
    return flight;
  }

  private async findSessionByIdOnce(sessionId: string): Promise<JsonObject | null> {
    const indexed = sessionIdIndex.get(sessionId);
    if (indexed && isOmpSessionFile(indexed)) {
      const found = await this.findSessionByFile(indexed);
      if (found?.id === sessionId)
        return { id: found.id, cwd: found.cwd, sessionFile: found.sessionFile };
      sessionIdIndex.delete(sessionId);
    }
    const top = await this.summarizeAll();
    const hit = top.find((item) => item.id === sessionId);
    if (hit) return { id: hit.id, cwd: hit.cwd, sessionFile: hit.path };
    for (const root of [...ompSessionRoots(), managedSessionsRoot()]) {
      if (!existsSync(root)) continue;
      let projects: string[] = [];
      try {
        projects = readdirSync(root);
      } catch {
        continue;
      }
      for (const project of projects) {
        const projectPath = path.join(root, project);
        let entries;
        try {
          entries = readdirSync(projectPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const childDir = path.join(projectPath, entry.name);
          let names: string[] = [];
          try {
            names = readdirSync(childDir).filter((name) =>
              name.endsWith(".jsonl"),
            );
          } catch {
            continue;
          }
          for (const name of names) {
            const filePath = path.join(childDir, name);
            const header = await sessionFileId(filePath);
            if (header !== sessionId) continue;
            const summary = await summarizeSessionFileCached(filePath);
            if (summary && summary.id === sessionId) {
              return {
                id: summary.id,
                cwd: summary.cwd,
                sessionFile: summary.path,
              };
            }
          }
        }
      }
    }
    return null;
  }

  async deleteSession(cwd: string, sessionFile: string): Promise<void> {
    const target = resolveUserPath(sessionFile);
    const root = path.resolve(
      isManagedSessionFile(target)
        ? managedSessionsRoot()
        : ompSessionRootFor(target),
    );
    if (!existsSync(target)) return;
    const realRoot = await fs.realpath(root);
    const realTarget = await fs.realpath(target);
    const rootKey =
      process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
    const targetKey =
      process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
    if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep)) {
      throw Object.assign(
        new Error("session file is outside the OMP session directory"),
        { code: "PATH_OUTSIDE_WORKSPACE" },
      );
    }
    await fs.unlink(target);
    this.summarizeCache = null;
    sessionSummaryCache.delete(target);
    subagentTitleCache.delete(target);
  }

  async listModels(): Promise<JsonValue> {
    return this.withControl(async (client) => {
      const response = await client.request(
        { type: "get_available_models" },
        60_000,
      );
      const data = unwrapResponse<JsonValue>(response);
      const list =
        isJsonObject(data) && Array.isArray(data.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];
      return list.filter(isJsonObject).map((model) => ({
        ...model,
        provider: model.provider ?? "unknown",
      }));
    });
  }

  private async withControl<T>(
    run: (client: OmpRpcClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.control.acquire();
    return run(client);
  }

  getSettings(cwd: string): JsonValue {
    return {
      workspacePath: cwd,
      projectTrusted: true,
      global: {},
      project: {},
      effective: {},
      errors: [],
    };
  }

  async patchSettings(cwd: string): Promise<JsonValue> {
    // OMP 的配置源是 ~/.omp/agent/config.yml + models.yml（YAML），
    // web 端设置先回显成功；行为层设置请用 OMP CLI / 手动编辑配置
    return this.getSettings(cwd);
  }

  private configCommand: OmpConfigCommand | undefined;

  /**
   * 跑 `omp config ...` 子命令读写全局配置（RPC 协议没有 config 面，
   * OMP CLI 走 Settings registry，写 ~/.omp/agent/config.yml；
   * 运行中的 `omp --mode rpc` 进程监听该文件并在 ~200ms 内重载）。
   */
  private async runOmpConfigCli(
    cliArgs: string[],
    timeoutMs = 60_000,
  ): Promise<string> {
    const { command, args } = (this.configCommand ??=
      resolveOmpConfigCommand());
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, [...args, ...cliArgs], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`omp config timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(
              `omp config exited with ${code}: ${stderr.trim().slice(0, 400) || "no stderr"}`,
            ),
          );
      });
    });
  }

  async getModelRoles(): Promise<JsonValue> {
    const stdout = await this.runOmpConfigCli([
      "config",
      "get",
      "modelRoles",
      "--json",
    ]);
    try {
      const parsed = JSON.parse(stdout) as { value?: JsonValue };
      return isJsonObject(parsed.value) ? parsed.value : {};
    } catch {
      throw new Error("omp config get modelRoles returned invalid JSON");
    }
  }

  async setModelRoles(roles: JsonObject): Promise<JsonValue> {
    const record: Record<string, string> = {};
    for (const [role, value] of Object.entries(roles)) {
      if (typeof value === "string" && value.trim())
        record[role] = value.trim();
    }
    await this.runOmpConfigCli([
      "config",
      "set",
      "modelRoles",
      JSON.stringify(record),
    ]);
    return record;
  }

  getProjectTrust(cwd: string): JsonValue {
    return {
      workspacePath: cwd,
      required: false,
      decision: null,
      defaultDecision: "always",
      trusted: true,
    };
  }

  setProjectTrust(cwd: string): JsonValue {
    return this.getProjectTrust(cwd);
  }

  list(): JsonValue {
    return [];
  }

  async manage(): Promise<JsonValue> {
    return [];
  }

  async resolve(): Promise<JsonValue> {
    return { extensions: [], skills: [], prompts: [], themes: [] };
  }

  async resolveSources(): Promise<JsonValue> {
    return { extensions: [], skills: [], prompts: [], themes: [] };
  }

  async changeSource(): Promise<JsonValue> {
    return { changed: false, packages: [] };
  }

  installedPath(): JsonValue {
    return null;
  }

  async checkUpdates(): Promise<JsonValue> {
    return [];
  }

  async dispose(): Promise<void> {
    await this.control.close();
  }
}

async function sessionFileId(filePath: string): Promise<string | undefined> {
  try {
    const file = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
        try {
          const entry: unknown = JSON.parse(line);
          if (
            isJsonObject(entry) &&
            entry.type === "session" &&
            typeof entry.id === "string"
          )
            return entry.id;
        } catch {
          /* 只读头部的未完成尾行不参与查找。 */
        }
      }
    } finally {
      await file.close();
    }
  } catch {
    /* 文件可能在扫描期间被删除。 */
  }
  return undefined;
}

function toSessionInfo(summary: SessionFileSummary): JsonObject {
  return {
    id: summary.id,
    path: summary.path,
    cwd: summary.cwd,
    name: summary.name,
    firstMessage: summary.firstMessage,
    created: summary.created,
    modified: summary.modified,
    messageCount: summary.messageCount,
  };
}

function readLinesSync(filePath: string): string[] {
  try {
    return readFileSync(filePath, "utf8").split("\n");
  } catch {
    return [];
  }
}

function notFoundError(message: string): Error {
  return Object.assign(new Error(message), { code: "NOT_FOUND" });
}

/**
 * 读子代理会话文件的消息条目（磁盘转录回填）。
 *
 * OMP 的子代理注册表是进程内的（RpcSubagentRegistry），终态 run 还会被
 * 删除——新拉起的 `omp --mode rpc` 进程对历史子会话文件一律报
 * "Unknown subagent session file"。转录本来就落盘在子会话 jsonl 里，
 * 直接读文件即可。安全约束：目标必须是原生 OMP 或 WebUI 托管 sessions
 * 根内的 .jsonl（realpath 归一后校验，与 deleteSession 同款防穿越）。
 */
async function childSessionPath(sessionFile: string): Promise<string> {
  const target = resolveUserPath(sessionFile);
  if (!target.endsWith(".jsonl")) throw notFoundError("session file not found");
  const root = path.resolve(
    isManagedSessionFile(target)
      ? managedSessionsRoot()
      : ompSessionRootFor(target),
  );
  let realRoot = root;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    /* sessions 根不存在时按原路径校验（后续 startsWith 必然失败） */
  }
  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch {
    throw notFoundError("session file not found");
  }
  const rootKey =
    process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
  const targetKey =
    process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep)) {
    throw Object.assign(
      new Error("session file is outside the OMP session directory"),
      { code: "PATH_OUTSIDE_WORKSPACE" },
    );
  }
  return realTarget;
}

/** 以有界 UTF-8 字节页传送 JSONL，超大单行也能跨页无损续读。 */
export async function readChildSessionPage(
  sessionFile: string,
  fromByte = 0,
): Promise<JsonObject> {
  if (!Number.isSafeInteger(fromByte) || fromByte < 0) {
    throw Object.assign(new Error("invalid transcript byte cursor"), {
      code: "INVALID_REQUEST",
    });
  }
  const file = await fs.open(await childSessionPath(sessionFile), "r");
  try {
    const { size } = await file.stat();
    const reset = fromByte > size;
    const from = reset ? 0 : fromByte;
    const limit = 256 * 1024;
    const buffer = Buffer.alloc(Math.min(limit + 3, Math.max(0, size - from)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, from);
    let end = Math.min(limit, bytesRead);
    if (bytesRead > end)
      while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
    let transcript: string;
    try {
      transcript = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, end),
      );
    } catch {
      throw Object.assign(
        new Error("invalid UTF-8 transcript cursor or content"),
        { code: "INVALID_REQUEST" },
      );
    }
    return {
      sessionFile,
      fromByte: from,
      nextByte: from + end,
      reset,
      hasMore: from + end < size,
      transcript,
    };
  } finally {
    await file.close();
  }
}

export async function readChildSessionPreviewPage(
  sessionFile: string,
  fromByte = 0,
  sync?: SubagentSyncRequest,
): Promise<JsonObject> {
  const filePath = await childSessionPath(sessionFile);
  return sync
    ? readSubagentSync(filePath, fromByte, sync)
    : readSubagentPreview(filePath, fromByte);
}

export async function readChildSessionMessages(
  sessionFile: string,
): Promise<JsonObject[]> {
  const messages: JsonObject[] = [];
  let fromByte = 0;
  let pending = "";
  for (;;) {
    const page = await readChildSessionPage(sessionFile, fromByte);
    pending += String(page.transcript);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (!page.hasMore && pending) {
      lines.push(pending);
      pending = "";
    }
    for (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line);
        if (
          isJsonObject(entry) &&
          entry.type === "message" &&
          isJsonObject(entry.message)
        )
          messages.push(entry.message);
      } catch {
        /* 未落完的末行留给后续读取。 */
      }
    }
    if (!page.hasMore) return messages;
    fromByte = Number(page.nextByte);
  }
}

function activeBranchFromEntries(entries: JsonObject[]): JsonObject[] {
  // Lifecycle exits from a stale second process must not select an older branch.
  const byId = new Map(
    entries.map((entry) => [
      typeof entry.id === "string" ? entry.id : "",
      entry,
    ]),
  );
  const leaf = [...entries]
    .reverse()
    .find(
      (entry: JsonObject) =>
        !(entry.type === "custom" && entry.customType === "session_exit"),
    );
  let cursor: string | null = typeof leaf?.id === "string" ? leaf.id : null;
  const pathEntries: JsonObject[] = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    pathEntries.push(entry);
    cursor = typeof entry.parentId === "string" ? entry.parentId : null;
  }
  pathEntries.reverse();
  if (pathEntries.length === 0) return entries;
  return pathEntries;
}
