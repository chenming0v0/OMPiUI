import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// worker 的 stderr 是 inherit 到 server 的：桌面壳（Tauri）只保留最近 24
// 行内存缓冲，进程退出后全丢。这里把 worker 自己的 stderr 也追加写到
// 和 server 相同的日志目录，崩溃后可回溯（server 侧的 handleExit 日志在
// server 进程里写，worker 进程内的 uncaughtException 等在这里写）。
function wireWorkerStderrFileLog(): void {
  if (process.env.PIUI_FILE_LOG === "0") return
  let logDir: string | undefined
  const day = () => new Date().toISOString().slice(0, 10)
  let file: string | undefined
  let currentDay = ""
  const write = (chunk: string) => {
    try {
      if (!file || currentDay !== day()) {
        currentDay = day()
        if (!logDir) {
          const env = process.env.PIUI_DATA_DIR?.trim()
          logDir = env
            ? resolve(env)
            : process.platform === "win32" && process.env.APPDATA
              ? join(process.env.APPDATA, "com.ompiui.desktop")
              : join(homedir(), ".ompiui")
          logDir = join(logDir, "logs")
          mkdirSync(logDir, { recursive: true })
        }
        file = join(logDir!, `ompiui-server-${currentDay}.log`)
      }
      appendFileSync(file, `[${new Date().toISOString()}] ${chunk}`)
    } catch {
      /* 磁盘/权限问题不阻塞 */
    }
  }
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") write(chunk)
    return orig(chunk as never, ...(rest as never[]))
  }) as typeof process.stderr.write
}
wireWorkerStderrFileLog()

import type { JsonObject, JsonValue, PiRegistrySnapshot } from "@ompiui/protocol"
import { isJsonObject, problemFromError, PROTOCOL_VERSION, validateParams } from "@ompiui/protocol"
import { OmpRpcSession, type OmpSessionOptions } from "./omp/omp-session.js"
import { OmpCatalog } from "./omp/omp-catalog.js"
import { OmpProviderAuth } from "./omp/omp-auth.js"
import { OMP_SDK_VERSION } from "./omp/constants.js"
import { MockPiSession, MockCatalog } from "./runtime/mock-session.js"
import { COMMAND_HANDLERS, createRegistryDescribeCapability, listCommandCapabilities, resolveExtensionTarget, type CommandContext } from "./command-table.js"
import { assertRuntimeTargetBindings } from "./runtime-contract.js"
import { createWorkerCommandScheduler } from "./worker-command-scheduler.js"
import { getDriverMode } from "./driver.js"
import {
  PI_WORKER_HEARTBEAT_INTERVAL_MS,
  PI_WORKER_PROTOCOL_VERSION,
  type WorkerHostCall,
  type WorkerHostReply,
  type WorkerMessage,
  type WorkerParentMessage,
  type WorkerRequest,
} from "./ipc.js"
import type { SessionRuntime } from "./runtime.js"
import * as P from "./params.js"

const workerGeneration = randomUUID()
/**
 * 同一 worker 进程内的多会话 runtime：key = 当前 sessionId。
 * runtime 替换（newSession/switchSession/fork）后 key 迁移到新 sessionId。
 * OMP RPC 模式下每个 runtime 是一个独立的 `omp --mode rpc` 子进程。
 */
const runtimes = new Map<string, SessionRuntime>()

const driver = getDriverMode()

// 会话命令 → 驱动方法绑定门禁：缺实现或缺 target 直接启动失败（响亮，不回退）。
assertRuntimeTargetBindings()

function send(message: WorkerMessage): void {
  try {
    process.send?.(message)
  } catch {
    // 通道已断（parent 消失）：disconnect 处理器会接手做有界清理退出，
    // 这里不能让 ERR_IPC_CHANNEL_CLOSED 炸进 uncaughtException
  }
}

/** 等 IPC flush 完再回调（用于退出前的最后一条消息）；通道不可用时立即回调 */
function sendWithCallback(message: WorkerMessage, callback: () => void): void {
  try {
    if (process.send) {
      process.send(message, () => callback())
      return
    }
  } catch {
    /* channel already gone */
  }
  callback()
}

const ompBin = process.env.OMPI_OMP_BIN?.trim() || undefined
const ompSessionOptions: OmpSessionOptions = { bin: ompBin }

const catalog = driver === "omp" ? new OmpCatalog() : new MockCatalog()
const providerAuth = new OmpProviderAuth(async () => {
  if (catalog instanceof OmpCatalog) return catalog.control.acquire()
  throw Object.assign(new Error("mock driver has no provider auth channel"), { code: "CAPABILITY_DISABLED" })
})

function callHost(call: WorkerHostCall): Promise<void> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHostCalls.delete(id)
      reject(Object.assign(new Error("OMPiUI host call timed out"), { code: "HOST_CALL_TIMEOUT" }))
    }, 15_000)
    timer.unref()
    pendingHostCalls.set(id, { resolve, reject, timer })
    process.send?.({ kind: "hostCall", id, generation: workerGeneration, call }, error => {
      if (!error) return
      const pending = pendingHostCalls.get(id)
      if (pending) clearTimeout(pending.timer)
      pendingHostCalls.delete(id)
      reject(error)
    })
  })
}

const pendingHostCalls = new Map<string, {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}>()

function subscribeRuntimeEvents(current: SessionRuntime): Array<() => void> {
  const unsubs: Array<() => void> = []
  unsubs.push(current.onPiEvent((event, meta) => send({
    kind: "event",
    generation: workerGeneration,
    sessionId: current.getSessionId(),
    channel: "pi.event",
    event,
    meta,
  })))
  unsubs.push(current.onHead(head => send({
    kind: "event",
    generation: workerGeneration,
    sessionId: current.getSessionId(),
    channel: "session.head",
    head: head as unknown as JsonObject,
  })))
  if (current.onActivity) {
    unsubs.push(current.onActivity(status => send({
      kind: "event",
      generation: workerGeneration,
      sessionId: current.getSessionId(),
      channel: "session.activity",
      event: { status: status as unknown as JsonValue },
    })))
  }
  if (current.onExtensionUi) {
    unsubs.push(current.onExtensionUi(event => send({
      kind: "event",
      generation: workerGeneration,
      sessionId: current.getSessionId(),
      channel: "extension.ui",
      event: toJsonObject(event),
    })))
  }
  if (current instanceof OmpRpcSession) {
    // OMP 子代理帧（lifecycle/progress/event）→ omp.subagent 通道
    unsubs.push(current.onSubagentFrame(event => send({
      kind: "event",
      generation: workerGeneration,
      sessionId: current.getSessionId(),
      channel: "omp.subagent",
      event,
    })))
    unsubs.push(current.onCrash(error => {
      console.error(`[ompiui-worker] omp rpc process crashed for session ${current.getSessionId()}: ${error.message}`)
    }))
  }
  return unsubs
}

function toJsonObject(value: unknown): JsonObject {
  const json = JSON.parse(JSON.stringify(value)) as unknown
  if (!isJsonObject(json)) {
    throw Object.assign(new Error("value is not a JSON object"), { code: "NATIVE_DATA_NOT_JSON" })
  }
  return json
}

async function openRuntime(params: JsonObject): Promise<JsonValue> {
  const cwd = P.reqString(params, "cwd")
  const sessionFile = P.optString(params, "sessionFile")
  const opened = driver === "omp"
    ? await OmpRpcSession.open(cwd, sessionFile, ompSessionOptions)
    : await MockPiSession.open(cwd, sessionFile)
  const sessionId = opened.getSessionId()
  const unsubs = subscribeRuntimeEvents(opened)
  runtimes.set(sessionId, opened)
  try {
    await setRuntimeRegistryBaseline(sessionId, opened)
  } catch (error) {
    runtimes.delete(sessionId)
    registryDigests.delete(sessionId)
    unsubs.forEach(unsub => unsub())
    await opened.dispose()
    throw error
  }
  return {
    sessionId,
    sessionFile: opened.getSessionFile() ?? null,
    cwd: opened.getCwd(),
    state: await opened.getState(),
  }
}

async function closeRuntime(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return
  const current = runtimes.get(sessionId)
  if (!current) return
  runtimes.delete(sessionId)
  registryDigests.delete(sessionId)
  await current.dispose()
}

const ctx: CommandContext = {
  get runtime() {
    return undefined
  },
  driver,
  catalog,
  auth: providerAuth,
  packages: catalog,
  requireRuntime(): SessionRuntime {
    throw Object.assign(new Error("OMP runtime is not open"), { code: "RUNTIME_NOT_OPEN" })
  },
}

let registryRevision = 1
const registryDigests = new Map<string, string | undefined>()
let registryCheck: Promise<void> = Promise.resolve()

async function setRuntimeRegistryBaseline(sessionId: string, current: SessionRuntime): Promise<void> {
  registryDigests.set(sessionId, stableStringify(await current.getRegistry()))
}

function queueRegistryChangeCheck(current: SessionRuntime, reason: string): Promise<void> {
  registryCheck = registryCheck.then(() => detectRegistryChange(current, reason), () => detectRegistryChange(current, reason))
  return registryCheck
}

async function detectRegistryChange(current: SessionRuntime, reason: string): Promise<void> {
  const sessionId = current.getSessionId()
  if (runtimes.get(sessionId) !== current) return
  const next = stableStringify(await current.getRegistry())
  const digest = registryDigests.get(sessionId)
  if (digest === undefined) {
    registryDigests.set(sessionId, next)
    return
  }
  if (next === digest) return
  registryDigests.set(sessionId, next)
  registryRevision += 1
  send({
    kind: "event",
    generation: workerGeneration,
    sessionId,
    channel: "registry.updated",
    event: { revision: registryRevision, sessionId, reason },
  })
}

function stableStringify(value: JsonValue): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sortJson(value[key] ?? null)]),
  )
}

async function execute(command: { type: string; params?: JsonObject; sessionId?: string }): Promise<JsonValue | undefined | void> {
  const params = command.params ?? {}
  if (command.type === "registry.describe") return describeRegistry()
  if (command.type === "session.open") return openRuntime(params)
  if (command.type === "session.close") {
    await closeRuntime(command.sessionId)
    return undefined
  }
  // 会话命令按 sessionId 路由到对应 runtime；找不到即 RUNTIME_REPLACED
  // （替换后 server 尚未同步新身份，或 runtime 已关闭）。
  const current = command.sessionId ? runtimes.get(command.sessionId) : undefined
  if (command.sessionId && !current) {
    throw Object.assign(new Error("OMP runtime no longer owns the requested session"), { code: "RUNTIME_REPLACED" })
  }
  const commandCtx: CommandContext = {
    get runtime() {
      return current
    },
    driver,
    catalog,
    auth: providerAuth,
    packages: catalog,
    requireRuntime(): SessionRuntime {
      if (!current) throw Object.assign(new Error("OMP runtime is not open"), { code: "RUNTIME_NOT_OPEN" })
      return current
    },
  }
  const handler = COMMAND_HANDLERS[command.type]
  if (!handler) {
    // 静态表未命中：OMP slash 命令/工具按注册表路由（invokeCommand 走 prompt）
    if (current) {
      const registry = await current.getRegistry()
      const target = resolveExtensionTarget(registry, command.type)
      if (target === "tool") {
        const tool = registry.tools.find(item => item.name === command.type)
        if (tool?.parameters) validateParams(tool.parameters, params ?? {})
        return current.invokeTool(command.type, params)
      }
      if (target === "command") {
        const args = typeof params?.args === "string" ? params.args : undefined
        return current.invokeCommand(command.type, args)
      }
    }
    throw Object.assign(new Error(`unknown command: ${command.type}`), { code: "UNKNOWN_COMMAND" })
  }
  const result = await handler(commandCtx, params)
  // Runtime replacement (newSession/switchSession/fork) changes the session
  // identity inside the child process; migrate the map key so subsequent
  // requests with the new sessionId find the same runtime.
  if (current) {
    const currentId = current.getSessionId()
    if (command.sessionId !== currentId) {
      runtimes.delete(command.sessionId!)
      runtimes.set(currentId, current)
      const digest = registryDigests.get(command.sessionId!)
      registryDigests.delete(command.sessionId!)
      registryDigests.set(currentId, digest)
    }
  }
  if (current && shouldCheckRegistryAfter(command.type)) {
    await queueRegistryChangeCheck(current, `command:${command.type}`)
  }
  return result
}

const REGISTRY_READ_COMMANDS = new Set(["state.get", "entries.get", "branch.get", "tree.get", "registry.get", "attachment.get", "waitForIdle"])

function shouldCheckRegistryAfter(type: string): boolean {
  if (type.startsWith("session.") || type.startsWith("models.") || type.startsWith("settings.") ||
    type.startsWith("trust.") || type.startsWith("providers.") || type.startsWith("modelRuntime.") ||
    type.startsWith("packages.")) return false
  return !REGISTRY_READ_COMMANDS.has(type)
}

function describeRegistry(): PiRegistrySnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: registryRevision,
    sdkVersion: OMP_SDK_VERSION,
    driver,
    globalCommands: [createRegistryDescribeCapability(), ...listCommandCapabilities("global")],
    sessionCommands: listCommandCapabilities("session"),
  }
}

const schedule = createWorkerCommandScheduler(async command => execute(command))

async function cleanupWorker(): Promise<void> {
  clearInterval(heartbeatTimer)
  // 并发清理所有 runtime，且每个 dispose 有界（omp 子进程退出可能等待
  // stdout 排空）。超时的会话直接放弃等它——进程马上退出。
  await Promise.allSettled([...runtimes.keys()].map(async sessionId => {
    const current = runtimes.get(sessionId)
    if (!current) return
    runtimes.delete(sessionId)
    registryDigests.delete(sessionId)
    await Promise.race([
      current.dispose(),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 3_000)
        timer.unref()
      }),
    ])
  }))
  if (catalog instanceof OmpCatalog) await catalog.dispose().catch(() => undefined)
}

const unsubscribeProviderAuth = providerAuth.onEvent(event => send({
  kind: "event",
  generation: workerGeneration,
  channel: "provider.auth",
  event: toJsonObject(event),
}))

const heartbeatTimer = setInterval(() => {
  send({ kind: "heartbeat", generation: workerGeneration, timestamp: Date.now() })
}, PI_WORKER_HEARTBEAT_INTERVAL_MS)
heartbeatTimer.unref()

// 子进程的异步疏忽产生的 unhandledRejection：记录并继续，单个 RPC 调用的
// promise 泄漏不应杀死 worker。uncaughtException = 进程级错误，记录后有界
// 清理并退出，重建交还 supervisor。
process.on("unhandledRejection", (reason) => {
  console.error(`[ompiui-worker] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
})

let fatalExitStarted = false

async function fatalExit(code: number): Promise<void> {
  const force = setTimeout(() => process.exit(code), 3_000)
  force.unref()
  try {
    await cleanupWorker()
  } catch {
    /* best effort */
  }
  process.exit(code)
}

process.on("uncaughtException", (error) => {
  console.error(`[ompiui-worker] uncaught exception: ${error?.stack ?? error}`)
  if (fatalExitStarted) return
  fatalExitStarted = true
  void fatalExit(1)
})

function toResponseData(data: JsonValue | undefined | void): JsonValue | undefined {
  return data === undefined ? undefined : data as JsonValue
}

process.on("message", (value: unknown) => {
  const message = value as WorkerParentMessage
  if (message?.kind === "hostReply") {
    const reply = message as WorkerHostReply
    const pending = pendingHostCalls.get(reply.id)
    if (!pending || reply.generation !== workerGeneration) return
    pendingHostCalls.delete(reply.id)
    clearTimeout(pending.timer)
    if (reply.ok) pending.resolve()
    else pending.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
    return
  }
  const request = message as WorkerRequest
  if (!request || request.kind !== "request" || typeof request.id !== "string") return
  if (request.generation !== workerGeneration) {
    send({
      kind: "response",
      id: request.id,
      generation: workerGeneration,
      ok: false,
      error: { code: "WORKER_PROTOCOL_MISMATCH", message: "OMP worker generation mismatch" },
    })
    return
  }
  if (!request.command || typeof request.command.type !== "string") {
    send({
      kind: "response",
      id: request.id,
      generation: workerGeneration,
      ok: false,
      error: { code: "INVALID_REQUEST", message: "malformed worker request" },
    })
    return
  }
  if (request.command.type === "dispose") {
    void schedule.close(cleanupWorker).then(
      () => {
        sendWithCallback({ kind: "response", id: request.id, generation: workerGeneration, ok: true }, () => process.exit(0))
        setTimeout(() => process.exit(0), 1_000).unref()
      },
      error => {
        sendWithCallback({
          kind: "response",
          id: request.id,
          generation: workerGeneration,
          ok: false,
          error: problemFromError(error),
        }, () => process.exit(1))
        setTimeout(() => process.exit(1), 1_000).unref()
      },
    )
    return
  }
  if (request.command.type === "session.close") {
    void schedule({ ...request.command, sessionId: request.sessionId }).then(
      () => {
        send({ kind: "response", id: request.id, generation: workerGeneration, ok: true })
      },
      error => {
        send({
          kind: "response",
          id: request.id,
          generation: workerGeneration,
          ok: false,
          error: problemFromError(error),
        })
      },
    )
    return
  }
  void schedule({ ...request.command, sessionId: request.sessionId }).then(
    data => {
      send({ kind: "response", id: request.id, generation: workerGeneration, ok: true, data: toResponseData(data) })
    },
    error => {
      send({
        kind: "response",
        id: request.id,
        generation: workerGeneration,
        ok: false,
        error: problemFromError(error),
      })
    },
  )
})

process.on("disconnect", () => {
  clearInterval(heartbeatTimer)
  for (const pending of pendingHostCalls.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error("OMPiUI host disconnected"))
  }
  pendingHostCalls.clear()
  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()
  void (async () => {
    let exitCode = 0
    try {
      await schedule.close(cleanupWorker)
    } catch (error) {
      console.error(`[ompiui-worker] disconnect cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      exitCode = 1
    }
    process.exit(exitCode)
  })()
})

if (ompBin) {
  console.info(`[ompiui-worker] omp binary: ${ompBin}`)
}

send({
  kind: "hello",
  workerProtocolVersion: PI_WORKER_PROTOCOL_VERSION,
  piSdkVersion: OMP_SDK_VERSION,
  piSdkVerified: true,
  generation: workerGeneration,
  processId: process.pid,
  heartbeatIntervalMs: PI_WORKER_HEARTBEAT_INTERVAL_MS,
})
