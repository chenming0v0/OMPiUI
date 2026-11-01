import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { JSONParser } from "@streamparser/json"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"
import { runtimePolicyArgs } from "./runtime-policy.js"
import { RpcLineReader } from "./rpc-line-reader.js"
import { OmpStdinSender, type StdinWriteHandle } from "./stdin-sender.js"
import { ompCommandEnvironment, resolveOmpCommand } from "./omp-command.js"
import { RuntimeBridgeTransport, type RuntimeBridgeOperation } from "./runtime-bridge.js"
import { ToolInteractionChannel } from "./tool-interaction-channel.js"


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
  /** 对 UI 主动启动的会话应用进程级配置与 bash 调用限制，不影响用户 CLI。 */
  applyRuntimePolicy?: boolean
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
  constructor(message: string, readonly code?: string, readonly delivery?: "unsent" | "unknown") {
    super(message)
    this.name = "OmpRpcError"
  }
}

const CHUNK_TIMEOUT_MS = 30_000
/** exit 后等待 stdout 读到 EOF(close)的有界宽限;到期即按已缓冲内容收尾 */
const EXIT_STDOUT_GRACE_MS = 1_000
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024
const MAX_CHUNK_PAYLOAD_BYTES = 256 * 1024
const MAX_CHUNK_COUNT = 4096
const MAX_CHUNK_ENTRIES = 32
const MAX_TOTAL_CHUNK_BYTES = 64 * 1024 * 1024
const MAX_CHUNK_ID_BYTES = 256

export class OmpRpcClient extends EventEmitter {
  readonly proc: ChildProcess
  readonly toolInteractionChannel?: ToolInteractionChannel
  private readonly stdoutReader: RpcLineReader
  private stdinSender?: OmpStdinSender
  private nextId = 0
  private readonly runtimeBridge = new RuntimeBridgeTransport()
  private readonly pending = new Map<string, {
    commandType: string
    resolve: (response: OmpRpcResponse) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
    write?: StdinWriteHandle
  }>()
  private readonly chunks = new Map<string, {
    parts: Map<number, Buffer>
    count: number
    byteLength: number
    receivedBytes: number
    metadataBytes: number
    createdAt: number
    deadline: number
    timer?: NodeJS.Timeout
  }>()
  private stderrBuffer: string[] = []
  private chunkBytes = 0
  private outputPausedAt?: number
  private exited = false
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  private exitReason = "unexpected_exit"
  private exitError: Error | undefined
  private readonly exitWaiter: Promise<void>
  private exitWaiterResolve: (() => void) | undefined

  constructor(readonly options: OmpRpcClientOptions) {
    super()
    this.setMaxListeners(100)
    const env = ompCommandEnvironment(options.env)
    if (options.applyRuntimePolicy) {
      env.OMPIUI_AUTO_TITLE_ENABLED = env.PI_NO_TITLE || options.args?.includes("--no-title") ? "0" : "1"
    }
    if (options.applyRuntimePolicy && !options.args?.includes("--no-ui")) {
      this.toolInteractionChannel = new ToolInteractionChannel()
      Object.assign(env, this.toolInteractionChannel.environment())
    }
    // 与配置命令共用入口解析，脚本由解释器执行，不经过 shell 或 Windows 文件关联。
    const invocation = resolveOmpCommand(options.bin ?? env.OMPI_OMP_BIN, env)
    // --no-ui disables extension UI only; native rpc-ui tool UI remains enabled.
    const args = [...invocation.args, "--mode", options.applyRuntimePolicy ? "rpc-ui" : "rpc", ...(options.args ?? []), ...(options.applyRuntimePolicy ? runtimePolicyArgs(options.bin ?? env.OMPI_OMP_BIN, env) : [])]
    this.proc = spawn(invocation.command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    })
    this.getStdinSender()
    this.stdoutReader = new RpcLineReader(
      line => this.handleStdoutLine(line),
      () => this.proc.stdout!.pause(),
      () => this.proc.stdout!.resume(),
      64,
      message => this.emitProtocolError(message),
    )
    this.proc.stdout!.setEncoding("utf8")
    this.proc.stdout!.on("data", chunk => this.stdoutReader.push(chunk))
    this.proc.stderr!.setEncoding("utf8")
    this.proc.stderr!.on("data", chunk => {
      this.stderrBuffer.push(chunk)
      if (this.stderrBuffer.length > 200) this.stderrBuffer.splice(0, this.stderrBuffer.length - 200)
    })
    this.proc.once("exit", () => this.toolInteractionChannel?.close())
    this.proc.on("error", error => {
      this.toolInteractionChannel?.close()
      this.exitError = error
      this.exitReason = "spawn_error"
    })
    // 等 stdout close 或 exit 后的短宽限期，再按 IPC 背压排空已缓冲帧。
    let exitFinalizing = false
    const finalizeExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.exited || exitFinalizing) return
      exitFinalizing = true
      let finalized = false
      let drainTimeout: NodeJS.Timeout
      const finish = () => {
        if (finalized) return
        finalized = true
        clearTimeout(drainTimeout)
        this.stdoutReader.close()
        this.exited = true
        this.exitCode = code
        this.exitSignal = signal
        const tail = this.stderrBuffer.join("").trim()
        if (!this.exitError) {
          this.exitError = new Error(
            `omp RPC process exited (code=${code ?? "null"} signal=${signal ?? "null"})${tail ? `: ${tail.slice(-2000)}` : ""}`,
          )
        }
        this.failAllPending()
        this.emit("exit", code, signal)
        this.exitWaiterResolve?.()
      }
      drainTimeout = setTimeout(() => {
        this.emitProtocolError("stdout exit drain timed out under IPC backpressure")
        finish()
      }, EXIT_STDOUT_GRACE_MS)
      drainTimeout.unref()
      this.stdoutReader.finish(finish)
    }
    // exit 后给 stdout 一个很短的有界宽限等待 close，让管道中的最终输出先被读完。
    let exitGrace: NodeJS.Timeout | undefined
    this.proc.on("exit", (code, signal) => {
      if (this.exited || exitFinalizing || exitGrace) return
      this.stdinSender?.close(new OmpRpcError("omp RPC process exited", "OMP_EXITED"))
      exitGrace = setTimeout(() => finalizeExit(code, signal), EXIT_STDOUT_GRACE_MS)
      exitGrace.unref()
    })
    this.proc.on("close", (code, signal) => {
      if (exitGrace) clearTimeout(exitGrace)
      exitGrace = undefined
      finalizeExit(code, signal)
    })
    this.exitWaiter = new Promise(resolve => {
      this.exitWaiterResolve = resolve
    })
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  setOutputPaused(paused: boolean): void {
    if (paused && this.outputPausedAt === undefined) {
      this.outputPausedAt = Date.now()
      for (const entry of this.chunks.values()) clearTimeout(entry.timer)
    } else if (!paused && this.outputPausedAt !== undefined) {
      const now = Date.now()
      for (const [id, entry] of this.chunks) {
        entry.deadline += now - Math.max(entry.createdAt, this.outputPausedAt)
        entry.timer = setTimeout(() => this.abortChunk(id, "rpc chunk timed out"), Math.max(1, entry.deadline - now))
        entry.timer.unref()
      }
      this.outputPausedAt = undefined
    }
    this.stdoutReader.setPaused(paused)
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

  get runtimeExitInfo(): JsonObject {
    return { code: this.exitCode, signal: this.exitSignal, reason: this.exitReason, pid: this.pid ?? null }
  }

  private handleStdoutLine(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch (error) {
      this.emitProtocolError(error instanceof Error ? error.message : String(error))
      return
    }
    if (!isJsonObject(frame) || typeof frame.type !== "string") {
      this.emitProtocolError("rpc stdout frame must be an object with a string type")
      return
    }
    this.dispatchFrame(frame as OmpRpcFrame)
  }

  private dispatchFrame(frame: OmpRpcFrame): void {
    if (this.runtimeBridge.handleFrame(frame)) return
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
    if (Buffer.byteLength(chunkId) > MAX_CHUNK_ID_BYTES) {
      this.emitProtocolError("rpc chunk id exceeds metadata limit", "rpc_chunk", "stream")
      return
    }
    if (!chunkId || !Number.isSafeInteger(count) || count < 1 || count > MAX_CHUNK_COUNT) {
      this.abortChunk(chunkId, "invalid rpc chunk id or count")
      return
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || !data) {
      this.abortChunk(chunkId, "invalid rpc chunk index or data")
      return
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_REASSEMBLED_BYTES || count > byteLength) {
      this.abortChunk(chunkId, "invalid rpc chunk length")
      return
    }
    if (data.length > Math.ceil(MAX_CHUNK_PAYLOAD_BYTES / 3) * 4) {
      this.abortChunk(chunkId, "rpc chunk payload too large")
      return
    }
    // 保留原始字节，后续由流式解码器处理跨分片的 UTF-8 字符。
    const bytes = Buffer.from(data, "base64")
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_PAYLOAD_BYTES) {
      this.abortChunk(chunkId, "invalid rpc chunk payload")
      return
    }
    let entry = this.chunks.get(chunkId)
    if (!entry) {
      const metadataBytes = Buffer.byteLength(chunkId)
      if (this.chunks.size >= MAX_CHUNK_ENTRIES || this.chunkBytes + metadataBytes + bytes.byteLength > MAX_TOTAL_CHUNK_BYTES) {
        this.emitProtocolError("rpc chunk buffer limit reached", "rpc_chunk", "stream")
        return
      }
      const timer = this.outputPausedAt === undefined
        ? setTimeout(() => this.abortChunk(chunkId, "rpc chunk timed out"), CHUNK_TIMEOUT_MS) : undefined
      timer?.unref()
      const createdAt = Date.now()
      entry = { parts: new Map(), count, byteLength, receivedBytes: 0, metadataBytes, createdAt, deadline: createdAt + CHUNK_TIMEOUT_MS, timer }
      this.chunks.set(chunkId, entry)
      this.chunkBytes += metadataBytes
    }
    if (entry.count !== count || entry.byteLength !== byteLength) {
      this.abortChunk(chunkId, "rpc chunk metadata mismatch")
      return
    }
    if (entry.parts.has(index)) {
      this.abortChunk(chunkId, "duplicate rpc chunk index")
      return
    }
    if (this.chunkBytes + bytes.byteLength > MAX_TOTAL_CHUNK_BYTES) {
      this.abortChunk(chunkId, "rpc chunk total byte limit reached")
      return
    }
    entry.parts.set(index, bytes)
    entry.receivedBytes += bytes.byteLength
    this.chunkBytes += bytes.byteLength
    if (entry.receivedBytes > MAX_REASSEMBLED_BYTES || (entry.byteLength > 0 && entry.receivedBytes > entry.byteLength)) {
      this.abortChunk(chunkId, "rpc chunk exceeds declared length")
      return
    }
    if (entry.parts.size < entry.count) return
    clearTimeout(entry.timer)
    this.chunks.delete(chunkId)
    this.chunkBytes -= entry.receivedBytes + entry.metadataBytes
    if (entry.byteLength > 0 && entry.receivedBytes !== entry.byteLength) {
      this.emitProtocolError(`rpc chunk ${chunkId} length mismatch: got ${entry.receivedBytes} expected ${entry.byteLength}`, "rpc_chunk", "stream")
      return
    }
    const ordered: Buffer[] = []
    for (let i = 0; i < entry.count; i++) {
      const part = entry.parts.get(i)
      if (!part) {
        this.emitProtocolError(`rpc chunk ${chunkId} missing index ${i}`, "rpc_chunk", "stream")
        return
      }
      ordered.push(part)
    }
    // 流式解析并释放已消费分片，不再物化整帧 Buffer 和 JSON 字符串。
    let reassembled: unknown
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true })
      const parser = new JSONParser({ paths: ["$"], stringBufferSize: 64 * 1024 })
      parser.onValue = ({ value }) => { reassembled = value }
      for (let index = 0; index < ordered.length; index++) {
        parser.write(decoder.decode(ordered[index], { stream: true }))
        entry.parts.delete(index)
        ordered[index] = Buffer.alloc(0)
      }
      parser.write(decoder.decode())
      if (!parser.isEnded) parser.end()
    } catch (error) {
      this.emitProtocolError(`rpc chunk ${chunkId} is not valid UTF-8 or JSON: ${error instanceof Error ? error.message : String(error)}`, "rpc_chunk")
      return
    }
    if (isJsonObject(reassembled) && reassembled.type === "rpc_chunk") {
      this.emitProtocolError("nested rpc chunks are not supported", "rpc_chunk")
    } else if (isJsonObject(reassembled) && typeof reassembled.type === "string") {
      this.dispatchFrame(reassembled as OmpRpcFrame)
    } else {
      this.emitProtocolError("reassembled rpc frame must be an object with a string type", "rpc_chunk")
    }
  }

  /** 丢弃未完成的分片序列并记录协议错误(不静默吞掉) */
  private abortChunk(chunkId: string, reason: string): void {
    const entry = this.chunks.get(chunkId)
    if (entry) {
      clearTimeout(entry.timer)
      this.chunks.delete(chunkId)
      this.chunkBytes -= entry.receivedBytes + entry.metadataBytes
    }
    this.emitProtocolError(`${reason} (${chunkId.slice(0, 128)})`, "rpc_chunk", "stream")
  }

  private emitProtocolError(message: string, originalType?: string, kind: "frame" | "stream" = "frame"): void {
    this.stderrBuffer.push(`[omp-rpc] ${message}\n`)
    if (this.stderrBuffer.length > 200) this.stderrBuffer.splice(0, this.stderrBuffer.length - 200)
    // Surface local protocol failures (chunk loss, decode errors) to the host
    // session so they reach the UI instead of only the exit stderr tail (#367).
    // kind tells the host whether a single frame was dropped ("frame") or the
    // reassembled message stream was aborted with data loss ("stream").
    this.emit("protocolError", message, originalType, kind)
  }

  private getStdinSender(): OmpStdinSender {
    return this.stdinSender ??= new OmpStdinSender(this.proc.stdin!, error => {
      if (this.exited) return
      this.exitError = new OmpRpcError(`omp RPC stdin failed: ${error.message}; command result unknown`, "OMP_STDIN_ERROR", "unknown")
      this.emitProtocolError(this.exitError.message)
      this.failAllPending()
      // JSONL 可能只写出一部分，断开的 stdin 不能继续发送或安全重放。
      this.kill("stdin_error")
    })
  }

  async requestRuntime(operation: RuntimeBridgeOperation, args: JsonObject = {}, timeoutMs = 30_000): Promise<JsonValue> {
    try {
      return await this.runtimeBridge.request(this, operation, args, timeoutMs)
    } catch (error) {
      if (error instanceof OmpRpcError) throw error
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined
      throw new OmpRpcError(error instanceof Error ? error.message : String(error), code)
    }
  }

  async request<T extends JsonValue = JsonValue>(command: JsonObject, timeoutMs = 60_000): Promise<OmpRpcResponse & { data?: T }> {
    const id = typeof command.id === "string" ? command.id : `req_${++this.nextId}`
    const commandType = typeof command.type === "string" ? command.type : ""
    const full: JsonObject = { id, ...command }
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new OmpRpcError("omp RPC process has exited", "OMP_EXITED", "unsent"))
        return
      }
      const timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return
        this.pending.delete(id)
        const sent = pending.write?.sent === true
        pending.write?.cancel()
        reject(new OmpRpcError(
          `omp RPC command timed out: ${commandType}${sent ? "; command result unknown" : "; cancelled before stdin write"}`,
          "OMP_TIMEOUT", sent ? "unknown" : "unsent",
        ))
      }, timeoutMs)
      timer.unref()
      const pending = {
        commandType,
        resolve: resolve as (response: OmpRpcResponse) => void,
        reject,
        timer,
        write: undefined as StdinWriteHandle | undefined,
      }
      this.pending.set(id, pending)
      const writeDone = (error: Error | undefined, sent: boolean): void => {
        if (!error || this.pending.get(id) !== pending) return
        this.pending.delete(id)
        clearTimeout(timer)
        const code = "code" in error && typeof error.code === "string" ? error.code : "OMP_STDIN_ERROR"
        reject(new OmpRpcError(
          `omp RPC stdin write failed: ${error.message}${sent ? "; command result unknown" : "; command not sent"}`,
          code, sent ? "unknown" : "unsent",
        ))
      }
      try {
        pending.write = this.getStdinSender().write(JSON.stringify(full) + "\n", writeDone)
      } catch (error) {
        writeDone(error instanceof Error ? error : new Error(String(error)), false)
      }
    })
  }

  send(command: JsonObject): void {
    if (this.exited) throw new OmpRpcError("omp RPC process has exited", "OMP_EXITED", "unsent")
    this.getStdinSender().write(JSON.stringify(command) + "\n", (error, sent) => {
      if (error) this.emitProtocolError(`stdin ${sent ? "write failed (result unknown)" : "command not sent"}: ${error.message}`)
    })
  }

  writeExtensionUiResponse(response: JsonObject): void {
    this.send(response)
  }

  async close(): Promise<void> {
    this.exitReason = "host_dispose"
    try {
      this.getStdinSender().end()
    } catch {
      /* already closed */
    }
    await this.waitForExit(10_000)
    if (!this.exited) {
      this.kill("graceful_close_timeout")
      await this.waitForExit(2_000)
    }
  }

  kill(reason = "forced_stop"): void {
    this.exitReason = reason
    this.stdinSender?.close(new OmpRpcError("omp RPC process stopping", "OMP_EXITED"))
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
      if (pending.commandType !== command || !pending.write?.sent) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      return pending
    }
    return undefined
  }

  private failAllPending(): void {
    const error = this.exitError ?? new OmpRpcError("omp RPC process exited", "OMP_EXITED")
    this.runtimeBridge.close(error)
    this.stdinSender?.close(error)
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      const sent = pending.write?.sent === true
      pending.reject(new OmpRpcError(
        `${error.message}${sent ? "; command result unknown" : "; command not sent"}`,
        error instanceof OmpRpcError ? error.code : "OMP_EXITED", sent ? "unknown" : "unsent",
      ))
      this.pending.delete(id)
    }
    for (const [chunkId, entry] of this.chunks) {
      clearTimeout(entry.timer)
      this.chunks.delete(chunkId)
    }
    this.chunkBytes = 0
  }
}

/** 解析 OMP RPC 响应：success=false 时抛 OmpRpcError（带 code） */
export function unwrapResponse<T extends JsonValue = JsonValue>(response: OmpRpcResponse): T | undefined {
  if (!response.success) {
    throw new OmpRpcError(response.error ?? "omp RPC command failed", response.code)
  }
  return response.data as T | undefined
}
