import { existsSync, promises as fs, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { isJsonObject, requireJsonValue } from "@ompiui/protocol"
import type { CatalogProvider } from "../runtime.js"
import type { PackagesGateway } from "../command-table.js"
import { entriesPageFromEntries, sessionHeadFromParts } from "../runtime/pagination.js"
import { OmpRpcClient, unwrapResponse } from "./rpc-client.js"
import { OMP_SDK_VERSION } from "./constants.js"

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
  return cwd.replace(/\\/g, "/")
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim()
  if (/^file:\/\//i.test(trimmed)) {
    return path.resolve(fileURLToPath(trimmed))
  }
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"))) {
    return path.resolve(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

export function ompAgentDir(): string {
  const env = process.env.OMP_AGENT_DIR?.trim()
  if (env) return resolveUserPath(env)
  return path.join(homedir(), ".omp", "agent")
}

/** OMP 子代理会话目录：<parent>.jsonl 去后缀的同名目录 */
function childSessionDir(parentSessionFile: string): string | null {
  const target = resolveUserPath(parentSessionFile)
  if (!target.endsWith(".jsonl")) return null
  return target.slice(0, -".jsonl".length)
}

function sessionsRoot(): string {
  return path.join(ompAgentDir(), "sessions")
}

interface SessionFileSummary {
  id: string
  cwd: string
  path: string
  name: string | null
  firstMessage: string | null
  created: string | null
  modified: number
  messageCount: number
}

async function summarizeSessionFile(filePath: string): Promise<SessionFileSummary | null> {
  let content: string
  try {
    content = await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }
  const lines = content.split("\n")
  let id = ""
  let cwd = ""
  let created: string | null = null
  let name: string | null = null
  let firstMessage: string | null = null
  let messageCount = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: JsonObject
    try {
      const parsed = JSON.parse(trimmed)
      if (!isJsonObject(parsed)) continue
      entry = parsed
    } catch {
      continue
    }
    const type = entry.type
    if (type === "session") {
      id = typeof entry.id === "string" ? entry.id : ""
      cwd = typeof entry.cwd === "string" ? entry.cwd : ""
      created = typeof entry.timestamp === "string" ? entry.timestamp : null
      if (!name && typeof entry.name === "string") name = entry.name
    } else if (type === "title") {
      if (typeof entry.title === "string" && entry.title) name = entry.title
    } else if (type === "message") {
      messageCount += 1
      if (!firstMessage && isJsonObject(entry.message) && entry.message.role === "user") {
        const content = entry.message.content
        if (typeof content === "string") firstMessage = content
        else if (Array.isArray(content)) {
          const text = content.find(block => isJsonObject(block) && block.type === "text")
          if (isJsonObject(text) && typeof text.text === "string") firstMessage = text.text
        }
      }
    }
  }
  if (!id || !cwd) return null
  let modified = 0
  try {
    modified = statSync(filePath).mtimeMs
  } catch {
    /* keep 0 */
  }
  return { id, cwd, path: filePath, name, firstMessage, created, modified, messageCount }
}

function listSessionFiles(): string[] {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const dir of readdirSync(root)) {
    const dirPath = path.join(root, dir)
    try {
      if (!statSync(dirPath).isDirectory()) continue
    } catch {
      continue
    }
    try {
      for (const file of readdirSync(dirPath)) {
        if (file.endsWith(".jsonl")) files.push(path.join(dirPath, file))
      }
    } catch {
      /* unreadable dir */
    }
  }
  return files
}

function pathKey(value: string): string {
  const normalized = normalizeCwd(path.resolve(value))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/** 短生命周期控制 RPC 进程：跑一条命令就退（模型列表等无会话查询） */
async function withControlRpc<T>(cwd: string, run: (client: OmpRpcClient) => Promise<T>): Promise<T> {
  const client = new OmpRpcClient({ cwd, env: { PIUI_EMBEDDED: "1" } })
  try {
    await client.waitForReady(30_000)
    await client.request({ type: "negotiate_protocol", protocolVersion: 2 })
    return await run(client)
  } finally {
    await client.close().catch(() => undefined)
  }
}

/** 进程内共享的长驻控制 RPC（provider 认证流程需要一个稳定 stdin/stdout 对） */
export class OmpControlChannel {
  private client: OmpRpcClient | undefined
  private starting: Promise<OmpRpcClient> | undefined

  constructor(private readonly cwd = homedir()) {}

  async acquire(): Promise<OmpRpcClient> {
    if (this.client && !this.client.hasExited) return this.client
    this.starting ??= (async () => {
      const client = new OmpRpcClient({ cwd: this.cwd, env: { PIUI_EMBEDDED: "1" } })
      await client.waitForReady(30_000)
      await client.request({ type: "negotiate_protocol", protocolVersion: 2 })
      client.on("exit", () => {
        if (this.client === client) this.client = undefined
      })
      this.client = client
      return client
    })()
    try {
      return await this.starting
    } catch (error) {
      this.starting = undefined
      throw error
    }
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.starting = undefined
    if (client) await client.close().catch(() => undefined)
  }
}

export class OmpCatalog implements CatalogProvider, PackagesGateway {
  readonly control = new OmpControlChannel()

  async listSessions(cwd: string): Promise<JsonValue> {
    const wanted = pathKey(cwd)
    const summaries = await this.summarizeAll()
    return summaries.filter(item => pathKey(item.cwd) === wanted).map(toSessionInfo)
  }

  async listAllSessions(): Promise<JsonValue> {
    const summaries = await this.summarizeAll()
    return summaries.map(toSessionInfo)
  }

  private summarizeCache: { at: number; items: SessionFileSummary[] } | null = null

  private async summarizeAll(): Promise<SessionFileSummary[]> {
    // 会话列表扫描全量文件是 catalog 里最贵的操作：2s 缓存
    if (this.summarizeCache && Date.now() - this.summarizeCache.at < 2_000) {
      return this.summarizeCache.items
    }
    const files = listSessionFiles()
    const results = await Promise.all(files.map(file => summarizeSessionFile(file)))
    const items = results.filter((item): item is SessionFileSummary => item !== null)
    items.sort((a, b) => b.modified - a.modified)
    this.summarizeCache = { at: Date.now(), items }
    return items
  }

  async createSession(cwd: string): Promise<JsonValue> {
    // OMP 在 session.open 时自动开新会话：这里返回占位身份，
    // 真实 sessionId 以 openRuntime 返回的 state 为准
    return { sessionId: `pending-${Date.now()}`, sessionFile: null, cwd }
  }

  async previewSession(cwd: string, sessionFile: string, params: { cursor?: string; limit?: number; maxBytes?: number } = {}): Promise<JsonValue> {
    const target = resolveUserPath(sessionFile)
    const summary = await summarizeSessionFile(target)
    if (!summary) throw Object.assign(new Error("session file not found"), { code: "SESSION_NOT_FOUND" })
    return this.previewSummary(summary, params)
  }

  private previewSummary(summary: SessionFileSummary, params: { cursor?: string; limit?: number; maxBytes?: number }): JsonValue {
    // 读取文件并解析条目（磁盘预览不走 RPC 进程）
    const entries: JsonObject[] = []
    const raw = existsSync(summary.path) ? readLinesSync(summary.path) : []
    for (const line of raw) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (isJsonObject(parsed) && parsed.type !== "title" && parsed.type !== "session") {
          entries.push({ ...parsed, id: typeof parsed.id === "string" ? parsed.id : `${summary.id}:${entries.length}` })
        }
      } catch {
        /* skip malformed line */
      }
    }
    const branch = activeBranchFromEntries(entries)
    const header: JsonObject = { version: 3, id: summary.id, cwd: summary.cwd, name: summary.name }
    const head = sessionHeadFromParts({
      sdkVersion: OMP_SDK_VERSION,
      revision: 0,
      sessionFormatVersion: 3,
      header,
      leafId: typeof branch.at(-1)?.id === "string" ? branch.at(-1)!.id as string : null,
      entryCount: entries.length,
    }, [summary.id, header, entries.length])
    const page = entriesPageFromEntries(head, branch, {
      cursor: params.cursor,
      limit: params.limit ?? 100,
      maxBytes: params.maxBytes ?? 2 * 1024 * 1024,
    }, entry => entry)
    const state: JsonObject = {
      sessionId: summary.id,
      sessionFile: summary.path,
      sessionName: summary.name,
      cwd: summary.cwd,
      model: null,
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      messageCount: summary.messageCount,
      pendingMessageCount: 0,
      availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      isIdle: true,
      isBashRunning: false,
      hasPendingBashMessages: false,
      isRetrying: false,
      retryAttempt: 0,
      queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
      supportsThinking: true,
      activeTools: [],
      scopedModels: [],
      contextUsage: null,
      sessionStats: null,
      retry: null,
      compaction: null,
      head,
    }
    return requireJsonValue({ state, branch: page })
  }

  async previewSessionById(sessionId: string, params: { cursor?: string; limit?: number; maxBytes?: number } = {}): Promise<JsonValue> {
    const summaries = await this.summarizeAll()
    const match = summaries.find(item => item.id === sessionId)
    if (match) return this.previewSummary(match, params)
    // 顶层扫描没有（OMP 子代理会话嵌套在 <父会话名>/ 目录里）→ 深度查找兜底，
    // 让子会话在重载/深链后也能按 id 预览
    const found = await this.findSessionById(sessionId)
    if (found && typeof found.sessionFile === "string" && typeof found.cwd === "string") {
      return this.previewSession(found.cwd, found.sessionFile, params)
    }
    throw Object.assign(new Error(`session not found: ${sessionId}`), { code: "SESSION_NOT_FOUND" })
  }

  /**
   * 列出父会话文件旁的 OMP 子代理会话（<parent>.jsonl 同名目录下的 *.jsonl，
   * 与 OMP 子代理落盘布局一致）。顶层列表刻意不扫这一层，避免刷屏主列表。
   */
  async listChildSessions(parentSessionFile: string): Promise<JsonValue> {
    const dir = childSessionDir(parentSessionFile)
    if (!dir || !existsSync(dir)) return []
    let names: string[] = []
    try {
      names = readdirSync(dir).filter(name => name.endsWith(".jsonl"))
    } catch {
      return []
    }
    const results = await Promise.all(names.map(name => summarizeSessionFile(path.join(dir, name))))
    return results
      .filter((item): item is SessionFileSummary => item !== null)
      .sort((a, b) => b.modified - a.modified)
      .map(toSessionInfo)
  }

  /**
   * 按 session id 解析会话文件：先查顶层扫描，再扫子代理嵌套目录（读文件头
   * 匹配 id）。深度查找每次全量读头，仅在显式打开/重载子会话时触发。
   */
  async findSessionById(sessionId: string): Promise<JsonObject | null> {
    const top = await this.summarizeAll()
    const hit = top.find(item => item.id === sessionId)
    if (hit) return { id: hit.id, cwd: hit.cwd, sessionFile: hit.path }
    const root = sessionsRoot()
    if (!existsSync(root)) return null
    let projects: string[] = []
    try {
      projects = readdirSync(root)
    } catch {
      return null
    }
    for (const project of projects) {
      const projectPath = path.join(root, project)
      let entries
      try {
        entries = readdirSync(projectPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const childDir = path.join(projectPath, entry.name)
        let names: string[] = []
        try {
          names = readdirSync(childDir).filter(name => name.endsWith(".jsonl"))
        } catch {
          continue
        }
        for (const name of names) {
          const summary = await summarizeSessionFile(path.join(childDir, name))
          if (summary && summary.id === sessionId) {
            return { id: summary.id, cwd: summary.cwd, sessionFile: summary.path }
          }
        }
      }
    }
    return null
  }

  async deleteSession(cwd: string, sessionFile: string): Promise<void> {
    const target = resolveUserPath(sessionFile)
    const root = path.resolve(sessionsRoot())
    if (!existsSync(target)) return
    const realRoot = await fs.realpath(root)
    const realTarget = await fs.realpath(target)
    const rootKey = process.platform === "win32" ? realRoot.toLowerCase() : realRoot
    const targetKey = process.platform === "win32" ? realTarget.toLowerCase() : realTarget
    if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep)) {
      throw Object.assign(new Error("session file is outside the OMP session directory"), { code: "PATH_OUTSIDE_WORKSPACE" })
    }
    await fs.unlink(target)
    this.summarizeCache = null
  }

  async listModels(): Promise<JsonValue> {
    return this.withControl(async client => {
      const response = await client.request({ type: "get_available_models" }, 60_000)
      const data = unwrapResponse<JsonValue>(response)
      const list = isJsonObject(data) && Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : []
      return list.filter(isJsonObject).map(model => ({
        ...model,
        provider: model.provider ?? "unknown",
      }))
    })
  }

  private async withControl<T>(run: (client: OmpRpcClient) => Promise<T>): Promise<T> {
    const client = await this.control.acquire()
    return run(client)
  }

  getSettings(cwd: string): JsonValue {
    return { workspacePath: cwd, projectTrusted: true, global: {}, project: {}, effective: {}, errors: [] }
  }

  async patchSettings(cwd: string): Promise<JsonValue> {
    // OMP 的配置源是 ~/.omp/agent/config.yml + models.yml（YAML），
    // web 端设置先回显成功；行为层设置请用 OMP CLI / 手动编辑配置
    return this.getSettings(cwd)
  }

  getProjectTrust(cwd: string): JsonValue {
    return { workspacePath: cwd, required: false, decision: null, defaultDecision: "always", trusted: true }
  }

  setProjectTrust(cwd: string): JsonValue {
    return this.getProjectTrust(cwd)
  }

  list(): JsonValue {
    return []
  }

  async manage(): Promise<JsonValue> {
    return []
  }

  async resolve(): Promise<JsonValue> {
    return { resolved: [], missing: [] }
  }

  async resolveSources(): Promise<JsonValue> {
    return { resolved: [], missing: [] }
  }

  async changeSource(): Promise<JsonValue> {
    return { changed: false, packages: [] }
  }

  installedPath(): JsonValue {
    return null
  }

  async checkUpdates(): Promise<JsonValue> {
    return { updates: [] }
  }

  async dispose(): Promise<void> {
    await this.control.close()
  }
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
    allMessagesText: summary.firstMessage ?? "",
  }
}

function readLinesSync(filePath: string): string[] {
  try {
    return readFileSync(filePath, "utf8").split("\n")
  } catch {
    return []
  }
}

function activeBranchFromEntries(entries: JsonObject[]): JsonObject[] {
  // 活跃分支 = 从最后一个条目沿 parentId 回溯到根
  const byId = new Map(entries.map(entry => [typeof entry.id === "string" ? entry.id : "", entry]))
  let cursor: string | null = entries.at(-1) && typeof entries.at(-1)!.id === "string" ? entries.at(-1)!.id as string : null
  const pathEntries: JsonObject[] = []
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const entry = byId.get(cursor)
    if (!entry) break
    pathEntries.push(entry)
    cursor = typeof entry.parentId === "string" ? entry.parentId : null
  }
  pathEntries.reverse()
  if (pathEntries.length === 0) return entries
  return pathEntries
}
