import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { EventEmitter } from "node:events"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"
import { assertOmpTerminalStopped } from "./terminal-presence.js"
import { managedSessionsRoot } from "./managed-sessions.js"

/**
 * 可选的 OMP 兼容配置覆盖：`~/.ompiui/omp-compat.yml` 存在时以 `--config`
 * 附加到每个 OMPiUI 拉起的 `omp --mode rpc` 进程（只影响 OMPiUI 会话，
 * 不碰用户 CLI）。用于绕过个别网关的怪癖，例如某些 Anthropic 翻译层
 * 会在看到 OMP 的 `wait` 工具时返回 0-token 空响应（`async.enabled: false`
 * 可让 wait 工具退场）。
 */
export function ompCompatConfigArgs(): string[] {
  const path = join(homedir(), ".ompiui", "omp-compat.yml")
  return existsSync(path) ? ["--config", path] : []
}

function noAutoResumeArgs(): string[] {
  const file = join(dirname(managedSessionsRoot()), "runtime-config", "no-auto-resume.yml")
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (!existsSync(file)) writeFileSync(file, "autoResume: false\n", { mode: 0o600 })
  return ["--config", file]
}

/**
 * OMP RPC 客户端：把 `omp --mode rpc` 的 stdio JSONL 协议包成一个 Node 友好的
 * 事件/请求对象。协议参考 oh-my-pi docs/rpc.md —— ready 帧后协商 v2，超过
 * 1MiB 的 stdout 帧以 rpc_chunk 分片无损重组。
 *
 * 这一层是 OMPiUI 的 "OMP SDK 包装"：
 * - request(command) → 关联 id 的 RpcResponse（prompt/abort_and_prompt 只
 *   立即 ACK，完成信号走 prompt_result 事件帧）
 * - 其余 stdout 帧作为 "frame" 事件原样抛出（agent 事件、子代理帧、
 *   extension_ui_request、session_settled……）
 */
export interface OmpRpcClientOptions {
  cwd: string
  /** 可执行文件；缺省 PATH 里的 omp（Windows 用 omp.cmd） */
  bin?: string
  /** 额外 CLI 参数（如 --session-dir） */
  args?: string[]
  env?: NodeJS.ProcessEnv
  protectSession?: boolean
}

export type OmpRpcFrame = JsonObject & { type: string }

export interface OmpRpcResponse {
  id?: string
  type: "response"
  command: string
  success: boolean
  data?: JsonValue
  error?: string
  code?: string
}

export class OmpRpcError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = "OmpRpcError"
  }
}

const CHUNK_TIMEOUT_MS = 30_000

export class OmpRpcClient extends EventEmitter {
  readonly proc: ChildProcess
  private buffer = ""
  private nextId = 0
  private readonly pending = new Map<string, {
    commandType: string
    resolve: (response: OmpRpcResponse) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()
  private readonly chunks = new Map<string, {
    parts: Map<number, string>
    count: number
    byteLength: number
    timer: NodeJS.Timeout
  }>()
  private stderrBuffer: string[] = []
  private exited = false
  private exitCode: number | null = null
  private exitError: Error | undefined
  private readonly exitWaiter: Promise<void>
  private exitWaiterResolve: (() => void) | undefined

  constructor(readonly options: OmpRpcClientOptions) {
    super()
    this.setMaxListeners(100)
    // 优先直接执行原生二进制，避免包含空格的会话路径被 cmd 拆成多个参数。
    let bin = options.bin?.trim() || "omp"
    if (process.platform === "win32") {
      const located = spawnSync("where.exe", [bin], { encoding: "utf8", windowsHide: true })
      const candidates = located.status === 0 ? located.stdout.trim().split(/\r?\n/) : []
      bin = candidates.find(candidate => /\.exe$/i.test(candidate)) ?? candidates[0] ?? bin
    }
    const args = ["--mode", "rpc", ...ompCompatConfigArgs(), ...(options.protectSession ? noAutoResumeArgs() : []), ...(options.args ?? [])]
    this.proc = spawn(bin, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(process.env.OMP_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.OMP_AGENT_DIR } : {}), ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" && !/\.exe$/i.test(bin),
      windowsHide: true,
    })
    this.proc.stdout!.setEncoding("utf8")
    this.proc.stdout!.on("data", chunk => this.handleStdout(chunk))
    this.proc.stderr!.setEncoding("utf8")
    this.proc.stderr!.on("data", chunk => {
      this.stderrBuffer.push(chunk)
      if (this.stderrBuffer.length > 200) this.stderrBuffer.splice(0, this.stderrBuffer.length - 200)
    })
    this.proc.on("error", error => {
      this.exitError = error
    })
    this.proc.on("exit", (code, signal) => {
      this.exited = true
      this.exitCode = code
      const tail = this.stderrBuffer.join("").trim()
      if (!this.exitError) {
        this.exitError = new Error(
          `omp RPC process exited (code=${code ?? "null"} signal=${signal ?? "null"})${tail ? `: ${tail.slice(-2000)}` : ""}`,
        )
      }
      this.failAllPending()
      this.emit("exit", code, signal)
      this.exitWaiterResolve?.()
    })
    this.exitWaiter = new Promise(resolve => {
      this.exitWaiterResolve = resolve
    })
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  private readyPromise: Promise<void> | undefined

  /** 等 ready 帧（协议保证是第一个 stdout 帧） */
  waitForReady(timeoutMs = 30_000): Promise<void> {
    this.readyPromise ??= new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new OmpRpcError(`omp RPC process exited before ready: ${this.stderrTail.slice(-500)}`, "OMP_EXITED"))
        return
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new OmpRpcError(`omp RPC ready frame timed out: ${this.stderrTail.slice(-500)}`, "OMP_TIMEOUT"))
      }, timeoutMs)
      timer.unref()
      const onFrame = (frame: OmpRpcFrame) => {
        if (frame.type !== "ready") return
        cleanup()
        resolve()
      }
      const onExit = () => {
        cleanup()
        reject(new OmpRpcError(`omp RPC process exited before ready: ${this.stderrTail.slice(-500)}`, "OMP_EXITED"))
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.off("frame", onFrame)
        this.off("exit", onExit)
      }
      this.on("frame", onFrame)
      this.on("exit", onExit)
    })
    return this.readyPromise
  }

  /** 子进程退出（或已退出）时 resolve；可选超时后返回 */
  waitForExit(timeoutMs?: number): Promise<void> {
    if (this.exited) return Promise.resolve()
    if (!timeoutMs) return this.exitWaiter
    let timer: NodeJS.Timeout | undefined
    return Promise.race([
      this.exitWaiter,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref()
      }),
    ]).then(() => {
      if (timer) clearTimeout(timer)
    })
  }

  get stderrTail(): string {
    return this.stderrBuffer.join("").slice(-4000)
  }

  get hasExited(): boolean {
    return this.exited
  }

  get exitInfo(): { code: number | null; error?: Error } {
    return { code: this.exitCode, error: this.exitError }
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (!isJsonObject(frame) || typeof frame.type !== "string") continue
      this.dispatchFrame(frame as OmpRpcFrame)
    }
  }

  private dispatchFrame(frame: OmpRpcFrame): void {
    if (frame.type === "rpc_chunk") {
      this.handleChunk(frame)
      return
    }
    if (frame.type === "response") {
      const response = frame as unknown as OmpRpcResponse
      const id = typeof response.id === "string" ? response.id : undefined
      if (id) {
        const pending = this.pending.get(id)
        if (pending) {
          this.pending.delete(id)
          clearTimeout(pending.timer)
          pending.resolve(response)
          return
        }
      }
      // 老版本（< 18.2.11）对未知命令的 error response 不带 id：按 command
      // 名对上 in-flight 请求立刻 reject，而不是干等到超时（issue #5）。
      // 带 id 但 pending 已消失的迟到帧不参与配对，避免误杀新请求。
      if (!id && response.success === false) {
        const pending = this.takePendingByCommand(response.command)
        if (pending) {
          pending.reject(new OmpRpcError(response.error ?? `omp RPC command failed: ${response.command}`, response.code))
          return
        }
      }
      // 无 id 的 response（如 parse 错误）：作为帧抛出
      this.emit("frame", frame)
      return
    }
    this.emit("frame", frame)
  }

  private handleChunk(frame: OmpRpcFrame): void {
    const chunkId = typeof frame.chunkId === "string" ? frame.chunkId : ""
    const index = typeof frame.index === "number" ? frame.index : -1
    const count = typeof frame.count === "number" ? frame.count : 0
    const byteLength = typeof frame.byteLength === "number" ? frame.byteLength : 0
    const data = typeof frame.data === "string" ? frame.data : ""
    if (!chunkId || count <= 0 || index < 0 || index >= count || !data) return
    let entry = this.chunks.get(chunkId)
    if (!entry) {
      const timer = setTimeout(() => this.chunks.delete(chunkId), CHUNK_TIMEOUT_MS)
      timer.unref()
      entry = { parts: new Map(), count, byteLength, timer }
      this.chunks.set(chunkId, entry)
    }
    entry.parts.set(index, data)
    if (entry.parts.size < count) return
    clearTimeout(entry.timer)
    this.chunks.delete(chunkId)
    // 校验完整性后按 index 拼接、解码、重组为一个 JSON 对象
    let json = ""
    for (let i = 0; i < count; i++) {
      const part = entry.parts.get(i)
      if (!part) return
      json += Buffer.from(part, "base64").toString("utf8")
    }
    try {
      const reassembled = JSON.parse(json) as unknown
      if (isJsonObject(reassembled) && typeof reassembled.type === "string") {
        this.dispatchFrame(reassembled as OmpRpcFrame)
      }
    } catch {
      /* 重组失败：丢弃 */
    }
    void byteLength
  }

  async request<T extends JsonValue = JsonValue>(command: JsonObject, timeoutMs = 60_000): Promise<OmpRpcResponse & { data?: T }> {
    if (this.options.protectSession && !/^(get_|negotiate_protocol$|set_subagent_subscription$|abort$)/.test(String(command.type))) {
      try {
        await assertOmpTerminalStopped()
      } catch (error) {
        this.kill()
        throw error
      }
    }
    const id = `req_${++this.nextId}`
    const commandType = typeof command.type === "string" ? command.type : ""
    const full: JsonObject = { id, ...command }
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new OmpRpcError("omp RPC process has exited", "OMP_EXITED"))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new OmpRpcError(`omp RPC command timed out: ${String(command.type)}`, "OMP_TIMEOUT"))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, {
        commandType,
        resolve: resolve as (response: OmpRpcResponse) => void,
        reject,
        timer,
      })
      try {
        this.proc.stdin!.write(JSON.stringify(full) + "\n")
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  send(command: JsonObject): void {
    try {
      this.proc.stdin!.write(JSON.stringify(command) + "\n")
    } catch {
      /* 通道已断 */
    }
  }

  writeExtensionUiResponse(response: JsonObject): void {
    this.send(response)
  }

  async close(): Promise<void> {
    if (this.options.protectSession) {
      try {
        await assertOmpTerminalStopped()
      } catch {
        // 终端后来启动时，不允许旧 runtime 在退出阶段回写历史。
        this.kill()
        await this.waitForExit(2_000)
        return
      }
    }
    try {
      this.proc.stdin!.end()
    } catch {
      /* already closed */
    }
    await this.waitForExit(10_000)
    if (!this.exited) {
      try {
        this.proc.kill()
      } catch {
        /* best effort */
      }
      await this.waitForExit(2_000)
    }
  }

  kill(): void {
    try {
      if (process.platform === "win32" && this.proc.pid) {
        spawn("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
          .on("error", () => { this.proc.kill("SIGKILL") })
      } else {
        this.proc.kill("SIGKILL")
      }
    } catch {
      /* best effort */
    }
  }

  /** 按命令名取最早的 in-flight 请求（老版本无 id 错误响应的配对用） */
  private takePendingByCommand(command: string): { reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined {
    if (!command) return undefined
    for (const [id, pending] of this.pending) {
      if (pending.commandType !== command) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      return pending
    }
    return undefined
  }

  private failAllPending(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(this.exitError ?? new OmpRpcError("omp RPC process exited", "OMP_EXITED"))
      this.pending.delete(id)
    }
    for (const [chunkId, entry] of this.chunks) {
      clearTimeout(entry.timer)
      this.chunks.delete(chunkId)
    }
  }
}

/** 解析 OMP RPC 响应：success=false 时抛 OmpRpcError（带 code） */
export function unwrapResponse<T extends JsonValue = JsonValue>(response: OmpRpcResponse): T | undefined {
  if (!response.success) {
    throw new OmpRpcError(response.error ?? "omp RPC command failed", response.code)
  }
  return response.data as T | undefined
}
