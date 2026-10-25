import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROTOCOL_VERSION, type JsonObject } from "@ompiui/protocol"
import { EventHub } from "../event-hub.ts"
import { getDriverMode } from "@ompiui/omp-worker"
import type { WorkerSession } from "./worker-client.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import { SessionHost } from "./session-host.ts"

test("attached previews forward sync cursors and reject excessive page limits before querying", async t => {
  const previous = process.env.OMPIUI_DRIVER
  process.env.OMPIUI_DRIVER = "mock"
  const commands: Array<{ type: string; params?: JsonObject }> = []
  const worker = {
    command: async (type: string, params?: JsonObject) => { commands.push({ type, params }); return {} },
    getSessionId: () => "preview-test",
    getSessionFile: () => undefined,
    getCwd: () => ".",
    onEvent: () => () => {}, onCrash: () => () => {}, onClose: () => () => {}, dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = { onEvent: () => () => {}, open: async () => worker } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  t.after(() => {
    host.dispose()
    if (previous === undefined) delete process.env.OMPIUI_DRIVER
    else process.env.OMPIUI_DRIVER = previous
  })
  await host.openSession(".")
  commands.length = 0
  await host.executeGlobalCommand("session.preview", { sessionId: "preview-test", syncCursor: "baseline", beforeId: "entry", limit: 100 })
  assert.deepEqual(commands.find(command => command.type === "branch.get")?.params,
    { limit: 100, syncCursor: "baseline", beforeId: "entry" })
  const count = commands.length
  await assert.rejects(host.executeGlobalCommand("session.preview", { sessionId: "preview-test", limit: 201 }), { code: "INVALID_REQUEST" })
  assert.equal(commands.length, count)
})

test("viewing an OMP terminal history and syncing a draft never opens a writer", async t => {
  const file = join(tmpdir(), `ompiui-preview-${randomUUID()}.jsonl`)
  const bytes = '{"type":"session","id":"terminal-session"}\n{"type":"message","id":"latest-tui-answer"}\n'
  writeFileSync(file, bytes)
  const previous = process.env.OMPIUI_DRIVER
  process.env.OMPIUI_DRIVER = "omp"
  let opens = 0
  const supervisor = {
    onEvent: () => () => {},
    open: async () => { opens++; throw new Error("Browsing must not start a writer") },
    catalogCommand: async (type: string) => {
      if (type === "session.findByFile") return { id: "terminal-session", cwd: ".", sessionFile: file }
      if (type === "session.read") return { diskPreview: true, readOnly: false }
      throw new Error(`Unexpected catalog command ${type}`)
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  t.after(() => {
    host.dispose()
    if (previous === undefined) delete process.env.OMPIUI_DRIVER
    else process.env.OMPIUI_DRIVER = previous
    rmSync(file, { force: true })
  })
  assert.equal((await host.openSession(".", file)).sessionId, "terminal-session")
  await host.sessionQuery("terminal-session", "state.get")
  await host.sessionQuery("terminal-session", "branch.get")
  await host.sessionQuery("terminal-session", "entries.get")
  await host.sessionQuery("terminal-session", "tree.get")
  await host.sessionQuery("terminal-session", "attachment.get", { entryId: "image", blockIndex: 0 })
  await host.sessionQuery("terminal-session", "subagent.messages", { sessionFile: file })
  await host.sessionQuery("terminal-session", "subagent.messages", {
    sessionFile: file, fromByte: 0, sync: { version: 1, knownBlocks: [] },
  })
  await host.sessionQuery("terminal-session", "setExtensionEditorState", { text: "draft" })
  assert.equal(opens, 0)
  assert.equal(readFileSync(file, "utf8"), bytes)
  writeFileSync(file, `${bytes}{"type":"message","id":"another-tui-answer"}\n`)
  await host.openSession(".", file)
  assert.match(readFileSync(file, "utf8"), /another-tui-answer/)
  assert.equal(opens, 0)
})

test("an explicit message attaches a previewed OMP session using its latest history", async t => {
  const file = join(tmpdir(), `ompiui-send-${randomUUID()}.jsonl`)
  const bytes = '{"type":"session","id":"terminal-session"}\n'
  writeFileSync(file, bytes)
  const previous = process.env.OMPIUI_DRIVER
  process.env.OMPIUI_DRIVER = "omp"
  const commands: string[] = []
  let openedBytes: string | undefined
  let opens = 0
  const worker = {
    command: async (type: string) => { commands.push(type); return {} },
    getSessionId: () => "terminal-session",
    getSessionFile: () => file,
    getCwd: () => ".",
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async (_cwd: string, sessionFile: string) => {
      assert.equal(sessionFile, file)
      opens++
      openedBytes = readFileSync(file, "utf8")
      return worker
    },
    catalogCommand: async (type: string, params?: JsonObject) => {
      if (type === "session.findByFile") return { id: "terminal-session", cwd: ".", sessionFile: file }
      if (type === "session.read") {
        assert.equal(params?.query, "state.get")
        return { diskPreview: true, readOnly: false }
      }
      if (type === "session.listAll") return [{ id: "terminal-session", cwd: ".", path: file }]
      throw new Error(`Unexpected catalog command ${type}`)
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  t.after(() => {
    host.dispose()
    if (previous === undefined) delete process.env.OMPIUI_DRIVER
    else process.env.OMPIUI_DRIVER = previous
    rmSync(file, { force: true })
  })
  await host.openSession(".", file)
  await host.sessionQuery("terminal-session", "setExtensionEditorState", { text: "draft" })
  assert.equal(opens, 0)
  // 模拟浏览期间官方终端新增记录，主动发送时必须读取最新版原文件。
  const latest = `${bytes}{"type":"message","id":"latest-tui-answer"}\n`
  writeFileSync(file, latest)
  await host.sessionQuery("terminal-session", "sendUserMessage", { text: "continue" })
  assert.equal(opens, 1)
  assert.equal(openedBytes, latest)
  assert.deepEqual(commands, ["state.get", "sendUserMessage"])
})

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
          sdkVersion: "18.9.1",
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
          sdkVersion: "18.9.1",
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
    peekCatalogHandshake: async () => ({ ompVersion: "18.9.1" }),
    catalogCommand: async (type: string) => {
      assert.equal(type, "registry.describe")
      return {
        protocolVersion: PROTOCOL_VERSION,
        revision: 7,
        sdkVersion: "18.9.1",
        driver: "omp",
        globalCommands: [{ name: "registry.describe", scope: "global", source: "ompiui-adapter", description: "", paramsSchema: { type: "object" }, queue: "immediate" }],
        sessionCommands: [],
      }
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  try {
    const registry = await host.piRegistry()
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
  pending.setCheck(async () => ({ sessionId: "reap-session", isIdle: true, isSettled: false, hasPendingAsyncWork: true }))
  await pending.reap()
  assert.notEqual(pending.host.getAttached("reap-session"), undefined)
  assert.equal(pending.disposed(), 0)
  await pending.host.dispose()

  // 对照组：确实收到「无事」的答复时回收行为不变
  const idle = await reaperFixture()
  idle.setCheck(async () => ({ sessionId: "reap-session", isIdle: true, isSettled: true }))
  await idle.reap()
  assert.equal(idle.host.getAttached("reap-session"), undefined)
  assert.equal(idle.disposed(), 1)
  await idle.host.dispose()
  delete process.env.OMPIUI_DRIVER
})

test('SessionHost keeps an unknown settle state and a runtime touched during the idle readback', async () => {
  const unknown = await reaperFixture()
  unknown.setCheck(async () => ({ sessionId: 'reap-session', isIdle: true }))
  await unknown.reap()
  assert.equal(unknown.disposed(), 0)
  await unknown.host.dispose()

  const touched = await reaperFixture()
  touched.setCheck(async () => {
    // Force the access update inside the awaited idle query.
    const internal = touched.host as unknown as { lastAccess: Map<string, number> }
    internal.lastAccess.set('reap-session', Date.now())
    return { sessionId: 'reap-session', isIdle: true, isSettled: true }
  })
  await touched.reap()
  assert.notEqual(touched.host.getAttached('reap-session'), undefined)
  assert.equal(touched.disposed(), 0)
  await touched.host.dispose()
  delete process.env.OMPIUI_DRIVER
})
