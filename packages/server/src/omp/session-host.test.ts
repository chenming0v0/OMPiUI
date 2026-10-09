import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JsonObject } from "@ompiui/protocol"
import { EventHub } from "../event-hub.ts"
import { getDriverMode } from "@ompiui/omp-worker"
import type { WorkerSession } from "./worker-client.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import { SessionHost } from "./session-host.ts"

test("SessionHost notifies the session list when the session file materializes on disk", async () => {
  const sessionFile = join(tmpdir(), `piui-session-host-${randomUUID()}.jsonl`)
  let emitEvent!: (event: { channel: string; head?: unknown }) => void
  process.env.OMPIUI_DRIVER = "mock"
  const worker = {
    command: async () => ({}),
    getSessionId: () => "session-1",
    getSessionFile: () => sessionFile,
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: (listener: (event: { channel: string; head?: unknown }) => void) => {
      emitEvent = listener
      return () => {}
    },
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async (type: string, params?: JsonObject) => {
      if (type === "session.findByFile") return { id: "session-1", cwd: "." }
      if (type === "session.preview") return { state: null }
      return { entries: [] }
    },
    open: async () => worker,
  } as unknown as RuntimeSupervisor
  const hub = new EventHub()
  const host = new SessionHost(supervisor, hub)

  const updated: unknown[] = []
  const off = hub.subscribe(event => {
    if (event.channel === "sessions.updated") updated.push(event.payload)
  })

  await host.openSession(".", sessionFile)
  // attach 会发一条 attached；清掉，只观察 head 推进的通知
  updated.length = 0
  // head 但文件未落盘（setSessionName 等只改内存）：不是 materialized，
  // 列表磁盘扫描看不到它——不能广播，否则前端重拉后列表永远不出现。
  emitEvent({ channel: "session.head", head: { revision: 1, entryCount: 1 } })
  assert.equal(updated.length, 0)

  // 文件首次落盘 + head：materialized 必发（列表可扫到）
  writeFileSync(sessionFile, '{"type":"session","version":1}\n')
  emitEvent({ channel: "session.head", head: { revision: 2, entryCount: 2 } })
  assert.equal(updated.length, 1)
  assert.deepEqual(updated[0], {
    sessionId: "session-1",
    materialized: true,
  })

  // 原生语义：后续 head 推进（新消息）不再广播列表事件——列表 = 磁盘扫描，
  // 文件已存在，重扫结果不会变；排序/消息数由下一次生命周期事件或显式
  // 刷新时更新。
  emitEvent({ channel: "session.head", head: { revision: 3 } })
  emitEvent({ channel: "session.head", head: { revision: 4, entryCount: 4 } })
  assert.equal(updated.length, 1)

  delete process.env.OMPIUI_DRIVER
  off()
  host.dispose()
  rmSync(sessionFile, { force: true })
})

test("SessionHost rejects reopening a runtime while it is closing", async () => {
  process.env.OMPIUI_DRIVER = "mock"
  let releaseAbort!: () => void
  let opens = 0
  const worker = {
    command: async (type: string) => {
      if (type === "abort") return new Promise<void>(resolve => { releaseAbort = resolve })
      return {}
    },
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async (type: string) => {
      if (type === "session.findByFile") return { id: "session-1", cwd: "." }
      if (type === "session.preview") return { state: null }
      return { entries: [] }
    },
    open: async () => {
      opens += 1
      return worker
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  await host.openSession(".", "session-1.jsonl")
  const closing = host.closeSession("session-1")
  await assert.rejects(host.openSession(".", "session-1.jsonl"), { code: "RUNTIME_CLOSING" })

  releaseAbort()
  await closing
  await host.openSession(".", "session-1.jsonl")
  assert.equal(opens, 2)
  delete process.env.OMPIUI_DRIVER
})

test("SessionHost retries a busy session.open attach", async () => {
  process.env.OMPIUI_DRIVER = "mock"
  let opens = 0
  const worker = {
    command: async () => ({}),
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async (type: string) => {
      if (type === "session.findByFile") return { id: "session-1", cwd: "." }
      if (type === "session.preview") return { state: null }
      return { entries: [] }
    },
    open: async () => {
      opens += 1
      if (opens === 1) throw Object.assign(new Error("lock is busy"), { code: "SESSION_BUSY" })
      return worker
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  const opened = await host.openSession(".", "session-1.jsonl")
  assert.equal(opened.sessionId, "session-1")
  assert.equal(opens, 2)
  host.dispose()
  delete process.env.OMPIUI_DRIVER
})

test("SessionHost reuses an idle runtime for a session switch", async () => {
  process.env.OMPIUI_DRIVER = "mock"
  let opens = 0
  const worker = {
    command: async (type: string) => {
      if (type === "switchSession") {
        return {
          operation: "switch",
          sourceSessionId: "session-1",
          targetSessionId: "session-2",
          targetSessionFile: "session-2.jsonl",
          targetCwd: ".",
          cancelled: false,
        }
      }
      if (type === "state.get") return { sessionId: "session-2" }
      return {}
    },
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async (type: string) => {
      if (type === "session.findByFile") return { id: "session-2", cwd: "." }
      if (type === "session.preview") return { state: null }
      return { entries: [] }
    },
    open: async () => {
      opens += 1
      return worker
    },
    replaceRuntimeLease: async () => {},
  } as unknown as RuntimeSupervisor
  const hub = new EventHub()
  const host = new SessionHost(supervisor, hub)

  const updated: unknown[] = []
  const off = hub.subscribe(event => {
    if (event.channel === "sessions.updated") updated.push(event.payload)
  })

  await host.openSession(".", "session-1.jsonl")
  const opened = await host.openSession(".", "session-2.jsonl", undefined, "session-1")
  off()

  assert.equal(opens, 1)
  assert.equal(opened.sessionId, "session-2")
  assert.equal(host.getAttached("session-1"), undefined)
  assert.equal(host.getAttached("session-2")?.sessionFile, "session-2.jsonl")

  // runtime 复用必须带 reason 标记——前端据此跳过 pane remap（分屏隔离）
  const replaced = updated.find(p => (p as { replaced?: boolean }).replaced === true)
  assert.ok(replaced, "expected a sessions.updated replaced event")
  assert.deepEqual(replaced, {
    replaced: true,
    sourceSessionId: "session-1",
    targetSessionId: "session-2",
    targetSessionFile: "session-2.jsonl",
    targetCwd: ".",
    reason: "runtime-reuse",
  })
  delete process.env.OMPIUI_DRIVER
  host.dispose()
})

test("SessionHost routes extension commands by name through the runtime registry", async () => {
  process.env.OMPIUI_DRIVER = "mock"
  const executed: Array<{ type: string; params?: unknown }> = []
  const worker = {
    command: async (type: string, params?: unknown) => {
      if (type === "registry.get") {
        return {
          sdkVersion: "0.84.0",
          tools: [],
          activeTools: [],
          commands: [{ name: "my-ext-command", description: "extension command" }],
          extensions: [],
          eventHandlers: [],
        }
      }
      if (type === "state.get") return {}
      executed.push({ type, params })
      return { ok: true }
    },
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async (type: string) => {
      if (type === "session.findByFile") return { id: "session-1", cwd: "." }
      if (type === "session.preview") return { state: null }
      return { entries: [] }
    },
    open: async () => worker,
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  await host.openSession(".", "session-1.jsonl")

  const submitted = await host.executeSessionCommand("session-1", "my-ext-command", { args: "hello" }) as { promise: Promise<unknown> }
  await submitted.promise
  assert.deepEqual(executed, [{ type: "my-ext-command", params: { args: "hello" } }])

  // 注册表里没有的命令仍然响亮 404，不落到 worker。
  await assert.rejects(
    async () => { await host.executeSessionCommand("session-1", "does.not.exist") },
    { code: "UNKNOWN_COMMAND" },
  )
  assert.deepEqual(executed, [{ type: "my-ext-command", params: { args: "hello" } }])
  host.dispose()
  delete process.env.OMPIUI_DRIVER
})

test("SessionHost rejects unknown session commands on a cold session without spawning a worker", async () => {
  let opens = 0
  const supervisor = {
    onEvent: () => () => {},
    open: async () => {
      opens += 1
      throw new Error("should not spawn")
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  await assert.rejects(
    async () => { await host.executeSessionCommand("cold-session", "my-ext-command") },
    { code: "UNKNOWN_COMMAND" },
  )
  assert.equal(opens, 0)
  host.dispose()
})

test("SessionHost validates extension tool arguments against Pi's own tool schema", async () => {
  process.env.OMPIUI_DRIVER = "mock"
  const executed: Array<{ type: string; params?: unknown }> = []
  const worker = {
    command: async (type: string, params?: unknown) => {
      if (type === "registry.get") {
        return {
          sdkVersion: "0.84.0",
          tools: [{
            name: "my-tool",
            description: "extension tool",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          }],
          activeTools: [],
          commands: [],
          extensions: [],
          eventHandlers: [],
        }
      }
      if (type === "state.get") return {}
      executed.push({ type, params })
      return { ok: true }
    },
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async (type: string) => {
      if (type === "session.findByFile") return { id: "session-1", cwd: "." }
      if (type === "session.preview") return { state: null }
      return { entries: [] }
    },
    open: async () => worker,
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  await host.openSession(".", "session-1.jsonl")

  // 畸形入参：schema 来自 Pi 的工具定义，在 HTTP 边界响亮 400。
  await assert.rejects(
    async () => { await host.executeSessionCommand("session-1", "my-tool", { value: 42 }) },
    { code: "INVALID_REQUEST" },
  )
  assert.deepEqual(executed, [])

  const submitted = await host.executeSessionCommand("session-1", "my-tool", { value: "ok" }) as { promise: Promise<unknown> }
  await submitted.promise
  assert.deepEqual(executed, [{ type: "my-tool", params: { value: "ok" } }])
  host.dispose()
  delete process.env.OMPIUI_DRIVER
})

test("SessionHost reaps an idle runtime without prewarming", async () => {
  process.env.OMPIUI_DRIVER = "mock"
  let prewarmed = 0
  const worker = {
    command: async (type: string) => type === "state.get" ? { sessionId: "idle-session" } : {},
    getSessionId: () => "idle-session",
    getSessionFile: () => "idle-session.jsonl",
    getCwd: () => "/workspace",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {
      // 句柄 dispose = session.close（关 runtime，不杀进程）
    },
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async (type: string) => {
      if (type === "session.findByFile") return { id: "idle-session", cwd: "/workspace" }
      if (type === "session.preview") return { state: null }
      return { entries: [] }
    },
    open: async () => worker,
    prewarm: async () => {
      prewarmed += 1
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  await host.openSession("/workspace", "idle-session.jsonl")

  // 把 lastAccess 改成过去，让 reaper 判定该会话空闲
  const lastAccess = (host as unknown as { lastAccess: Map<string, number> }).lastAccess
  lastAccess.set("idle-session", Date.now() - 10 * 60_000)

  try {
    // reaper 每 30s 跑一次，直接触发内部回收逻辑
    const reap = (host as unknown as { reapIdleRuntimes(): Promise<void> }).reapIdleRuntimes
    await reap.call(host)
  } finally {
    delete process.env.OMPIUI_SESSION_IDLE_TTL_MS
  }

  assert.equal(host.getAttached("idle-session"), undefined)
  // 单共享进程架构：回收后不再补预热（worker 常驻，无需预热进程）
  assert.equal(prewarmed, 0)
  host.dispose()
  delete process.env.OMPIUI_DRIVER
})

test("SessionHost piRegistry falls back to the static snapshot while the worker is booting", async () => {
  let catalogCalled = false
  const supervisor = {
    onEvent: () => () => {},
    peekCatalogHandshake: async () => undefined,
    catalogCommand: async () => {
      catalogCalled = true
      throw new Error("worker must not be queried before it is ready")
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  try {
    const registry = await host.piRegistry()
    assert.equal(catalogCalled, false)
    assert.equal(registry.driver, getDriverMode())
    const names = new Set([
      ...registry.globalCommands.map(command => command.name),
      ...registry.sessionCommands.map(command => command.name),
    ])
    // server 注入的能力 + 静态命令表的核心命令必须都在
    for (const required of ["session.open", "session.attached", "session.listAll", "state.get", "prompt", "abort", "registry.get", "registry.describe"]) {
      assert.ok(names.has(required), `missing capability: ${required}`)
    }
  } finally {
    host.dispose()
  }
})

test("SessionHost piRegistry uses the worker snapshot once the handshake is ready", async () => {
  const supervisor = {
    onEvent: () => () => {},
    peekCatalogHandshake: async () => ({ piSdkVersion: "9.9.9", piSdkVerified: false }),
    catalogCommand: async (type: string) => {
      assert.equal(type, "registry.describe")
      return {
        protocolVersion: 1,
        revision: 7,
        sdkVersion: "9.9.9",
        driver: "pi",
        globalCommands: [{ name: "registry.describe", scope: "global", source: "ompiui-adapter", description: "", paramsSchema: { type: "object" }, queue: "immediate" }],
        sessionCommands: [],
      }
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  try {
    const registry = await host.piRegistry()
    assert.equal(registry.sdkVersion, "9.9.9")
    assert.equal(registry.revision, 7)
    // server 能力仍合并进来
    assert.ok(registry.globalCommands.some(command => command.name === "session.open"))
    assert.ok(registry.sessionCommands.some(command => command.name === "session.close"))
  } finally {
    host.dispose()
  }
})

test("SessionHost mirrors detached subagent registry frames to the server stream", async () => {
  let emitEvent!: (event: { channel: string; event?: unknown }) => void
  const worker = {
    command: async () => ({}),
    getSessionId: () => "session-1",
    getSessionFile: () => undefined,
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: (listener: (event: { channel: string; event?: unknown }) => void) => {
      emitEvent = listener
      return () => {}
    },
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => worker,
  } as unknown as RuntimeSupervisor
  const hub = new EventHub()
  const host = new SessionHost(supervisor, hub)

  const sessionStream: unknown[] = []
  const serverStream: unknown[] = []
  const off = hub.subscribe(event => {
    if (event.channel !== "omp.subagent") return
    if (event.stream.kind === "session") sessionStream.push(event.payload)
    if (event.stream.kind === "server") serverStream.push(event.payload)
  })

  await host.openSession(".", undefined)

  // lifecycle/progress 注册帧 → 会话流 + server 流镜像（带 sessionId）
  const lifecycleEvent = { kind: "lifecycle", payload: { id: "sa-1", detached: true, status: "started", agent: "task", index: 0 } }
  emitEvent({ channel: "omp.subagent", event: lifecycleEvent })
  assert.equal(sessionStream.length, 1)
  assert.equal(serverStream.length, 1)
  assert.deepEqual(serverStream[0], { ...lifecycleEvent, sessionId: "session-1" })

  // 转录帧体量大：只进会话流，不镜像
  emitEvent({ channel: "omp.subagent", event: { kind: "event", payload: { id: "sa-1", event: { type: "message_end" } } } })
  assert.equal(sessionStream.length, 2)
  assert.equal(serverStream.length, 1)

  off()
  await host.dispose()
})

// ============================================
// 空闲回收：判据问不到答案时绝不回收
// ============================================

// 回归：state.get 失败被当作空闲，正在跑长命令的 runtime 直接被 dispose——
// OMP 落盘 session_exit(dispose) 并把在途工具写成 "Command aborted"，用户看到
// 整条回合突然重置且不再继续，而模型从没拿到那次工具结果。
async function reaperFixture() {
  process.env.OMPIUI_DRIVER = "mock"
  let disposed = 0
  // openSession 本身也会走一次 state.get，回收判据的答复在会话打开后再注入
  let stateGet: () => Promise<JsonObject> = async () => ({ sessionId: "reap-session" })
  const worker = {
    command: async (type: string) => type === "state.get" ? stateGet() : {},
    getSessionId: () => "reap-session",
    getSessionFile: () => "reap-session.jsonl",
    getCwd: () => "/workspace",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => { disposed += 1 },
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async (type: string) => {
      if (type === "session.findByFile") return { id: "reap-session", cwd: "/workspace" }
      if (type === "session.preview") return { state: null }
      return { entries: [] }
    },
    open: async () => worker,
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  await host.openSession("/workspace", "reap-session.jsonl")
  // 把 lastAccess 推到 TTL 之外，让 runtime 进入回收候选
  const lastAccess = (host as unknown as { lastAccess: Map<string, number> }).lastAccess
  lastAccess.set("reap-session", Date.now() - 10 * 60_000)
  const reap = async () => {
    await (host as unknown as { reapIdleRuntimes(): Promise<void> }).reapIdleRuntimes.call(host)
  }
  return {
    host,
    reap,
    disposed: () => disposed,
    setCheck: (check: () => Promise<JsonObject>) => { stateGet = check },
  }
}

test("SessionHost keeps a runtime whose idle busy-check cannot be answered", async () => {
  const fixture = await reaperFixture()
  fixture.setCheck(async () => {
    throw Object.assign(new Error("Pi worker command timed out: state.get"), { code: "WORKER_RESULT_UNKNOWN" })
  })

  await fixture.reap()

  assert.notEqual(fixture.host.getAttached("reap-session"), undefined)
  assert.equal(fixture.disposed(), 0)
  await fixture.host.dispose()
  delete process.env.OMPIUI_DRIVER
})

test("SessionHost keeps a runtime with pending async work and still reaps a settled one", async () => {
  // isIdle=true 也不够：后台 bash / async task / eval 的结果还没回灌，会话仍会被叫醒
  const pending = await reaperFixture()
  pending.setCheck(async () => ({ sessionId: "reap-session", isIdle: true, hasPendingAsyncWork: true }))
  await pending.reap()
  assert.notEqual(pending.host.getAttached("reap-session"), undefined)
  assert.equal(pending.disposed(), 0)
  await pending.host.dispose()

  // 对照组：确实收到「无事」的答复时回收行为不变
  const idle = await reaperFixture()
  idle.setCheck(async () => ({ sessionId: "reap-session", isIdle: true }))
  await idle.reap()
  assert.equal(idle.host.getAttached("reap-session"), undefined)
  assert.equal(idle.disposed(), 1)
  await idle.host.dispose()
  delete process.env.OMPIUI_DRIVER
})
