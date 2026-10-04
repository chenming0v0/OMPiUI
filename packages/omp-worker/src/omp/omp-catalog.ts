import { spawn, spawnSync } from "node:child_process"
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
import { detectOmpVersion } from "./omp-version.js"
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

/** 磁盘预览丢弃的元数据条目（与 OmpRpcSession.adaptEntry 的丢弃清单一致） */
const DROPPED_META_ENTRY_TYPES = new Set(["title", "title_change", "model_usage", "session", "session_init"])

/** 父会话标题缓存：mtime 不变就不重读整文件（listChildSessions 的卡死帮凶） */
const subagentTitleCache = new Map<string, { mtime: number; titles: Map<string, string> }>()
/** 子会话摘要缓存：文件没变就复用（历史子会话挂载时不再次 JSON.parse） */
const sessionSummaryCache = new Map<string, { mtime: number; titlesStamp: string; summary: SessionFileSummary | null }>()

/**
 * 会话 JSONL 行 → 预览条目。元数据行（title/title_change/session/
 * session_init/model_usage）换成 omp.dropped 占位：直接透传会让前端渲染
 * 成 unknown 行，整行丢弃又会断掉活跃分支回溯的 parentId 链。
 */
export function previewEntriesFromLines(raw: string[], fallbackIdPrefix: string): JsonObject[] {
  const entries: JsonObject[] = []
  for (const line of raw) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!isJsonObject(parsed)) continue
      const type = typeof parsed.type === "string" ? parsed.type : ""
      if (DROPPED_META_ENTRY_TYPES.has(type)) {
        entries.push({
          type: "omp.dropped",
          id: typeof parsed.id === "string" ? parsed.id : `${fallbackIdPrefix}:${entries.length}`,
          parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
          timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
          droppedType: type,
        })
        continue
      }
      entries.push({ ...parsed, id: typeof parsed.id === "string" ? parsed.id : `${fallbackIdPrefix}:${entries.length}` })
    } catch {
      /* skip malformed line */
    }
  }
  return entries
}

/** OMP 给每个子代理注入的包装提示词，不能当会话标题。 */
const WRAPPING_ASSIGNMENT = /^complete assignment thoroughly\b/i

function firstUsefulTitle(...candidates: Array<unknown>): string | undefined {
  for (const value of candidates) {
    if (typeof value !== "string") continue
    const line = value.split("\n").map(part => part.trim()).find(Boolean)
    if (!line || WRAPPING_ASSIGNMENT.test(line)) continue
    return line
  }
  return undefined
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

async function summarizeSessionFile(filePath: string, childTitles?: Map<string, string>): Promise<SessionFileSummary | null> {
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
  let isSubagent = false
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
      if (!name) name = firstUsefulTitle(entry.name) ?? name
    } else if (type === "title" || type === "title_change") {
      // title 是固定宽度首行槽；OMP 18.x 的自动/手动标题写在后续 title_change。
      // 空槽和包装提示词都不能盖掉已有标题；后写入的用户改名覆盖先前的。
      const titled = firstUsefulTitle(entry.title)
      if (titled) name = titled
    } else if (type === "session_init") {
      isSubagent = typeof entry.agent === "string" && Boolean(entry.agent)
      if (!name) {
        name = firstUsefulTitle(childTitles?.get(path.basename(filePath, ".jsonl")), entry.agent) ?? name
      }
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
  if (!name && (isSubagent || childTitles)) {
    const taskName = path.basename(filePath, ".jsonl")
    name = firstUsefulTitle(childTitles?.get(taskName), taskName) ?? taskName
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

async function summarizeSessionFileCached(filePath: string, childTitles?: Map<string, string>): Promise<SessionFileSummary | null> {
  let mtime = 0
  try {
    mtime = statSync(filePath).mtimeMs
  } catch {
    sessionSummaryCache.delete(filePath)
    return null
  }
  // titlesStamp：父会话标题映射变了才重算 name（子会话文件本身没变）
  const titlesStamp = childTitles ? [...childTitles.entries()].map(([id, title]) => `${id}=${title}`).join("|") : ""
  const cached = sessionSummaryCache.get(filePath)
  if (cached && cached.mtime === mtime && cached.titlesStamp === titlesStamp) return cached.summary
  const summary = await summarizeSessionFile(filePath, childTitles)
  sessionSummaryCache.set(filePath, { mtime, titlesStamp, summary })
  return summary
}

/** 子会话的包装提示词不是标题；从父 task 的具名任务和结果摘要取名。 */
function readSubagentTitles(parentSessionFile: string): Map<string, string> {
  let mtime = 0
  try {
    mtime = statSync(parentSessionFile).mtimeMs
  } catch {
    return new Map()
  }
  const cached = subagentTitleCache.get(parentSessionFile)
  if (cached && cached.mtime === mtime) return cached.titles
  const titles = new Map<string, string>()
  for (const line of readLinesSync(parentSessionFile)) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isJsonObject(entry) || entry.type !== "message" || !isJsonObject(entry.message)) continue
    const message = entry.message
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isJsonObject(block) || block.type !== "toolCall" || block.name !== "task" || !isJsonObject(block.arguments)) continue
        if (!Array.isArray(block.arguments.tasks)) continue
        for (const task of block.arguments.tasks) {
          if (!isJsonObject(task) || typeof task.name !== "string" || !task.name) continue
          titles.set(task.name, firstUsefulTitle(task.description, task.name) ?? task.name)
        }
      }
    } else if (message.role === "toolResult" && message.toolName === "task" && isJsonObject(message.details)) {
      if (!Array.isArray(message.details.results)) continue
      for (const result of message.details.results) {
        if (!isJsonObject(result) || typeof result.id !== "string" || !result.id) continue
        titles.set(result.id, firstUsefulTitle(result.description, result.id) ?? result.id)
      }
    }
  }
  subagentTitleCache.set(parentSessionFile, { mtime, titles })
  return titles
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
    const results = await Promise.all(files.map(file => summarizeSessionFileCached(file)))
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
    const summary = await summarizeSessionFileCached(target)
    if (!summary) throw Object.assign(new Error("session file not found"), { code: "SESSION_NOT_FOUND" })
    return this.previewSummary(summary, params, await detectOmpVersion() ?? OMP_SDK_VERSION)
  }

  private previewSummary(summary: SessionFileSummary, params: { cursor?: string; limit?: number; maxBytes?: number }, sdkVersion: string = OMP_SDK_VERSION): JsonValue {
    // 读取文件并解析条目（磁盘预览不走 RPC 进程）
    const raw = existsSync(summary.path) ? readLinesSync(summary.path) : []
    const entries = previewEntriesFromLines(raw, summary.id)
    const branch = activeBranchFromEntries(entries)
    const header: JsonObject = { version: 3, id: summary.id, cwd: summary.cwd, name: summary.name }
    const head = sessionHeadFromParts({
      sdkVersion,
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
    if (match) return this.previewSummary(match, params, await detectOmpVersion() ?? OMP_SDK_VERSION)
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
    const titles = readSubagentTitles(resolveUserPath(parentSessionFile))
    const results = await Promise.all(names.map(name => summarizeSessionFileCached(path.join(dir, name), titles)))
    return results
      .filter((item): item is SessionFileSummary => item !== null)
      .sort((a, b) => b.modified - a.modified)
      .map(toSessionInfo)
  }

  /**
   * 按会话文件直查磁盘身份：只读这一份 jsonl，不扫兄弟子会话、也不读父会话。
   * 打开子会话 / 回填转录走这条路径，避免 listChildSessions 把 worker 打满。
   */
  async findSessionByFile(sessionFile: string): Promise<JsonObject | null> {
    const target = resolveUserPath(sessionFile)
    if (!target.endsWith(".jsonl")) return null
    const summary = await summarizeSessionFileCached(target)
    if (!summary) return null
    return { id: summary.id, cwd: summary.cwd, sessionFile: summary.path, name: summary.name }
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
          const summary = await summarizeSessionFileCached(path.join(childDir, name))
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
    sessionSummaryCache.delete(target)
    subagentTitleCache.delete(target)
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

  private ompBinCache: string | undefined

  /**
   * 解析 omp 可执行文件的绝对路径。win32 上 spawn 不走 shell 时解析不到
   * PATH 里的 .cmd/.exe，需要 where.exe 先定位；解析不到回落 "omp"（带 shell）。
   */
  private async resolveOmpBin(): Promise<string> {
    if (this.ompBinCache !== undefined) return this.ompBinCache
    try {
      const probe = process.platform === "win32"
        ? spawnSync("where.exe", ["omp"], { encoding: "utf8" })
        : spawnSync("which", ["omp"], { encoding: "utf8" })
      const lines = probe.status === 0 ? probe.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : []
      // 优先 .exe（可脱离 shell 直接拉起），.cmd/.bat 兜底
      this.ompBinCache = lines.find(line => /\.exe$/i.test(line)) ?? lines[0] ?? "omp"
    } catch {
      this.ompBinCache = "omp"
    }
    return this.ompBinCache
  }

  /**
   * 跑 `omp config ...` 子命令读写全局配置（RPC 协议没有 config 面，
   * OMP CLI 走 Settings registry，写 ~/.omp/agent/config.yml；
   * 运行中的 `omp --mode rpc` 进程监听该文件并在 ~200ms 内重载）。
   */
  private async runOmpConfigCli(cliArgs: string[], timeoutMs = 60_000): Promise<string> {
    const bin = await this.resolveOmpBin()
    const useShell = process.platform === "win32" && bin === "omp"
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, cliArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(useShell ? { shell: true } : {}),
      })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`omp config timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", chunk => { stdout += chunk })
      child.stderr?.on("data", chunk => { stderr += chunk })
      child.on("error", error => {
        clearTimeout(timer)
        reject(error)
      })
      child.on("exit", code => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(`omp config exited with ${code}: ${stderr.trim().slice(0, 400) || "no stderr"}`))
      })
    })
  }

  async getModelRoles(): Promise<JsonValue> {
    const stdout = await this.runOmpConfigCli(["config", "get", "modelRoles", "--json"])
    try {
      const parsed = JSON.parse(stdout) as { value?: JsonValue }
      return isJsonObject(parsed.value) ? parsed.value : {}
    } catch {
      throw new Error("omp config get modelRoles returned invalid JSON")
    }
  }

  async setModelRoles(roles: JsonObject): Promise<JsonValue> {
    const record: Record<string, string> = {}
    for (const [role, value] of Object.entries(roles)) {
      if (typeof value === "string" && value.trim()) record[role] = value.trim()
    }
    await this.runOmpConfigCli(["config", "set", "modelRoles", JSON.stringify(record)])
    return record
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
    return { extensions: [], skills: [], prompts: [], themes: [] }
  }

  async resolveSources(): Promise<JsonValue> {
    return { extensions: [], skills: [], prompts: [], themes: [] }
  }

  async changeSource(): Promise<JsonValue> {
    return { changed: false, packages: [] }
  }

  installedPath(): JsonValue {
    return null
  }

  async checkUpdates(): Promise<JsonValue> {
    return []
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

function notFoundError(message: string): Error {
  return Object.assign(new Error(message), { code: "NOT_FOUND" })
}

/**
 * 读子代理会话文件的消息条目（磁盘转录回填）。
 *
 * OMP 的子代理注册表是进程内的（RpcSubagentRegistry），终态 run 还会被
 * 删除——新拉起的 `omp --mode rpc` 进程对历史子会话文件一律报
 * "Unknown subagent session file"。转录本来就落盘在子会话 jsonl 里，
 * 直接读文件即可。安全约束：目标必须是 OMP sessions 根内的 .jsonl
 * （realpath 归一后校验，与 deleteSession 同款防穿越）。
 */
export async function readChildSessionMessages(sessionFile: string): Promise<JsonObject[]> {
  const target = resolveUserPath(sessionFile)
  if (!target.endsWith(".jsonl")) throw notFoundError("session file not found")
  const root = path.resolve(sessionsRoot())
  let realRoot = root
  try {
    realRoot = await fs.realpath(root)
  } catch {
    /* sessions 根不存在时按原路径校验（后续 startsWith 必然失败） */
  }
  let realTarget: string
  try {
    realTarget = await fs.realpath(target)
  } catch {
    throw notFoundError("session file not found")
  }
  const rootKey = process.platform === "win32" ? realRoot.toLowerCase() : realRoot
  const targetKey = process.platform === "win32" ? realTarget.toLowerCase() : realTarget
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep)) {
    throw Object.assign(
      new Error("session file is outside the OMP session directory"),
      { code: "PATH_OUTSIDE_WORKSPACE" },
    )
  }
  const entries = previewEntriesFromLines(readLinesSync(realTarget), "")
  return entries
    .filter(entry => entry.type === "message" && isJsonObject(entry.message))
    .map(entry => entry.message as JsonObject)
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
