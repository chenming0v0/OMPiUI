import assert from "node:assert/strict"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { test } from "node:test"
import { runInNewContext, Script } from "node:vm"
import { isToolInteractionDescriptor } from "../../../protocol/src/tool-interaction.js"
import { nativeToolInteractionImports, nativeToolInteractionSource } from "./native-tool-interaction.js"

type Value = Record<string, any>

function fixture() {
  let now = 1000
  let sessionId = "session-a"
  let source = "builtin"
  let listenCount = 0
  let accept!: (connection: Value) => void
  let currentTool: Value
  const events = new Map<string, (...args: any[]) => any>()
  const updates: Value[] = []
  const writes: string[] = []
  const resizes: number[][] = []
  const runs: Value[] = []
  const registrations: Value[] = []
  const signals: AbortSignal[] = []
  const builtin = { name: "bash", label: "Bash", description: "Native bash", parameters: { schema: true }, approval: () => "exec", concurrency: () => "exclusive", execute: () => { throw new Error("Must delegate through public invokeTool") } }
  currentTool = builtin
  const settings = { getShellConfig: () => ({ shell: "/bin/sh", env: { KEEP: "yes", CI: "1", OMPIUI_TOOL_INTERACTION_TOKEN: "inherited-secret" } }) }
  const manager = { getCwd: () => "/fixture", getSessionId: () => sessionId, getSessionFile: () => "/fixture/session.jsonl", allocateArtifactPath: async () => ({ id: "5", path: "/fixture/5.bash.log" }), saveArtifact: async () => "6" }
  const session = { cwd: "/fixture", settings, sessionManager: manager, getToolByName: () => currentTool, getEnabledToolNames: () => ["bash", "read"] }
  let blocked = false, denied = false, cwdValid = true
  let writeThrows = false
  const setting = (value: any) => ({ get: () => value })
  class Sink {
    text = ""
    options: Value
    constructor(options: Value) { this.options = options }
    push(text: string) { this.text += text }
    preview() { return this.text }
    async dump() { return { output: this.text, totalBytes: Buffer.byteLength(this.text), outputBytes: Buffer.byteLength(this.text), totalLines: 1, outputLines: 1, truncated: false } }
    async dispose() {}
  }
  class Pty {
    start(options: Value, onChunk: (error: Error | null, text: string) => void, onStart: (error: Error | null, pid: number) => void) {
      let resolve!: (result: Value) => void
      const promise = new Promise<Value>(done => { resolve = done })
      const run = { options, onChunk, finish: resolve, aborts: 0 }
      runs.push(run)
      signals.push(options.signal)
      options.signal.addEventListener("abort", () => { run.aborts++ })
      onStart(null, 123)
      return promise
    }
    write(data: string) { if (writeThrows) throw new Error("Native write failed"); writes.push(data) }
    resize(cols: number, rows: number) { resizes.push([cols, rows]) }
  }
  const pi = {
    pi: { OutputSink: Sink, enforceInlineByteCap: async (text: string) => text },
    on: (name: string, callback: (...args: any[]) => any) => events.set(name, callback),
    getAllTools: () => [{ name: "bash", sourceInfo: { source } }],
    registerTool: (definition: Value) => { registrations.push(definition); currentTool = definition; source = "extension" },
  }
  const env = { OMPIUI_TOOL_INTERACTION_ENDPOINT: "/fixture/private.sock", OMPIUI_TOOL_INTERACTION_TOKEN: "fixture-token", OMPIUI_TOOL_INTERACTION_RUNTIME_ID: "runtime-fixture" }
  const bunEnv = { ...env }
  const context = {
    Buffer, AbortController, console, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    Date: class extends Date { static now() { return now } },
    process: { env }, Bun: { env: bunEnv }, pi, ownSession: () => session,
    ntiUUID: randomUUID, ntiCreateHash: createHash, ntiTimingSafeEqual: timingSafeEqual,
    ntiIsAbsolute: (value: string) => value.startsWith("/"), ntiPtySession: Pty,
    ntiIpcServer: { listen: async (_endpoint: string, options: Value, callback: typeof accept) => { assert.equal(options.maxFrameBytes, 65536); accept = callback; listenCount++; return { unref() {}, async close() {} } } },
    ntiOutputSink: Sink,
    ntiApplyToolProxy: (tool: Value, wrapper: Value) => { for (const key of Reflect.ownKeys(tool)) if (!(key in wrapper)) Object.defineProperty(wrapper, key, { enumerable: true, configurable: true, get: () => typeof tool[key as string] === "function" ? tool[key as string].bind(tool) : tool[key as string] }) },
    ntiStat: async () => ({ isDirectory: () => cwdValid }),
    ntiDirenv: setting("auto"), ntiDirenvTimeout: setting(5000), ntiInterceptorEnabled: setting(true), ntiInterceptorPatterns: setting([]),
    ntiCheckInterception: () => ({ block: blocked, message: "Blocked by interceptor" }),
    ntiLeadingCd: (command: string) => command.startsWith("cd nested && ") ? { path: "nested", rest: command.slice(13) } : undefined,
    ntiResolveCwd: (cwd: string, base: string) => cwd.startsWith("/") ? cwd : base + "/" + cwd,
    ntiWorktreeClone: setting(false), ntiRewriteWorktree: (command: string) => command, ntiCliEntry: () => "omp",
    ntiInvalidateGithubCache: () => {}, ntiUrlRouter: { instance: () => ({ canHandle: (cwd: string) => cwd.includes("://") }) },
    ntiMaxTimeout: setting(30), ntiClampTimeout: (_tool: string, requested: number, max: number) => Math.max(1, Math.min(requested, max)), ntiTimeouts: { bash: { min: 1, max: 3600 } },
    ntiDirenvPreflight: async (command: string, _cwd: string, options: Value) => ({ command, env: { ...options.callerEnv, OMPIUI_TOOL_INTERACTION_TOKEN: "direnv-secret" } }),
    ntiHeadBytes: () => 100, ntiArtifactBytes: () => 10000, ntiMaxColumns: () => 200, ntiInlineBudget: () => 50000, ntiSpillThreshold: () => 48000,
    ntiEnforceInlineCap: async (text: string) => text,
    ntiGraphicsDecoder: class { push(text: string) { return text } finish() { return "" } async images() { return [] } },
    ntiToolResult: (details: Value) => {
      const result: Value = { details }
      const builder = { content(content: Value[]) { result.content = content; return builder }, truncationFromSummary() { return builder }, error() { result.isError = true; return builder }, done() { return result } }
      return builder
    },
    ntiToolAbortError: class extends Error {},
  }
  const helpers = runInNewContext(`(function() { ${nativeToolInteractionSource}\nreturn { state: ntiState, append: ntiAppend, describe: ntiDescribe, operation: ntiOperation, cleanup: ntiCleanup, utf8: ntiUtf8Prefix }; })()`, context)
  const ctx = { sessionManager: manager, invokeTool: async (_params: Value) => ({ delegated: true }) }
  const connect = (options: { backpressure?: boolean } = {}) => {
    let line!: (text: string) => void, close!: () => void, resolveDrain!: () => void
    const responses: Value[] = []
    let destroyed = false, ended = false
    const connection = {
      closed: false, unref() {},
      start(onLine: typeof line, onClose: typeof close) { line = onLine; close = onClose },
      send(text: string) { responses.push(JSON.parse(text)); return !options.backpressure },
      drained: () => new Promise<void>(done => { resolveDrain = done }),
      destroy() { this.closed = true; destroyed = true; close?.() },
      end() { ended = true; this.closed = true; close?.() },
    }
    accept(connection)
    return { responses, send: (request: Value) => line(JSON.stringify(request)), drain: () => resolveDrain?.(), disconnect: () => connection.destroy(), get destroyed() { return destroyed }, get ended() { return ended } }
  }
  const start = async (params: Value = {}, signal?: AbortSignal) => {
    const promise = registrations.at(-1)!.execute("tool-call", { command: "read answer", pty: true, timeout: 0, ...params }, signal, (update: Value) => updates.push(update), ctx)
    await new Promise(resolve => setImmediate(resolve))
    const record = [...helpers.state.records.values()].at(-1)
    return { promise, record, run: runs.at(-1)! }
  }
  return {
    helpers, env, bunEnv, events, ctx, session, builtin, registrations, updates, runs, writes, resizes, signals, connect, start,
    boot: () => events.get("session_start")!({}, ctx),
    close: () => events.get("session_shutdown")!(),
    identity: (record: Value) => ({ runtimeId: record.runtimeId, sessionId: record.sessionId, toolCallId: record.toolCallId, executionId: record.executionId }),
    setTime: (value: number) => { now = value },
    setSession: (value: string) => { sessionId = value },
    setOtherTool: () => { currentTool = { name: "bash", execute() {} }; source = "extension" },
    setBlocked: () => { blocked = true }, setDenied: () => { denied = true; builtin.approval = () => denied ? { policy: "deny" } as any : "exec" }, setInvalidCwd: () => { cwdValid = false }, setWriteThrows: () => { writeThrows = true },
    get listenCount() { return listenCount },
  }
}

test("generated source is valid JavaScript and uses only public imports", () => {
  new Script(`function extension(pi) { function ownSession() {} ${nativeToolInteractionSource} }`)
  assert.ok(nativeToolInteractionImports.includes('from "@oh-my-pi/pi-natives"'))
  assert.ok(nativeToolInteractionSource.includes('OutputSink: ntiOutputSink'))
  assert.doesNotMatch(nativeToolInteractionImports + nativeToolInteractionSource, /ui\.custom|PI_NO_PTY|InteractiveMode|runInteractiveBashPty|process\.kill|Bun\.spawn/)
  assert.ok(nativeToolInteractionSource.includes('details: { toolInteraction: ntiDescribe(record) }'))
})

test("late bootstrap preserves lazy native metadata, credentials and delegated results", async t => {
  const f = fixture(); t.after(() => f.close())
  assert.equal(f.registrations.length, 0)
  assert.deepEqual(f.env, {}); assert.deepEqual(f.bunEnv, {})
  await f.boot()
  const definition = f.registrations[0]
  assert.equal(definition.parameters, f.builtin.parameters)
  assert.equal(typeof Object.getOwnPropertyDescriptor(definition, "parameters")?.get, "function")
  assert.equal(definition.approval({}), "exec")
  let passed: unknown
  const result = { content: [], details: { original: true } }
  for (const params of [{ pty: false }, { pty: true, async: true }, { pty: true, name: "" }, { pty: true, name: "service" }]) {
    const value = await definition.execute("call", params, undefined, undefined, { ...f.ctx, invokeTool: async (args: unknown) => { passed = args; return result } })
    assert.equal(value, result); assert.equal(passed, params)
  }
  assert.equal(f.runs.length, 0)
  await f.boot()
  assert.equal(f.registrations.length, 1); assert.equal(f.listenCount, 1)
  f.setOtherTool(); await f.boot()
  assert.equal(f.registrations.length, 1); assert.equal(f.helpers.state.available, false)
})

test("hello authenticates once, unauthorized connections close and list is session scoped", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const unauthorized = f.connect()
  unauthorized.send({ id: "bad", operation: "list", sessionId: "session-a" })
  await Promise.resolve()
  assert.equal(unauthorized.responses[0].error.code, "AUTH_REQUIRED"); assert.equal(unauthorized.ended, true)
  const wrongVersion = f.connect()
  wrongVersion.send({ id: "v", operation: "hello", token: "fixture-token", protocolVersion: 2 })
  assert.equal(wrongVersion.responses[0].error.code, "PROTOCOL_VERSION")
  const client = f.connect()
  client.send({ id: "hello", operation: "hello", token: "fixture-token", protocolVersion: 1 })
  assert.equal(client.responses[0].data.runtimeId, "runtime-fixture")
  assert.equal(client.responses[0].data.available, true)
  client.send({ id: "list", operation: "list", sessionId: "other-session" })
  assert.equal(client.responses[1].error.code, "SESSION_MISMATCH")
  client.send({ id: "token", operation: "list", token: "must-not-repeat", sessionId: "session-a" })
  assert.equal(client.responses[2].error.code, "INVALID_REQUEST")
})

test("the unique PTY publishes descriptors, blanks inherited secrets, and detaches without killing", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const { promise, record, run } = await f.start({ command: "cd nested && read answer" })
  assert.ok(run)
  assert.equal(f.runs.length, 1)
  assert.equal(run.options.command, "read answer"); assert.equal(run.options.cwd, "/fixture/nested")
  assert.equal(run.options.env.PI_SESSION_ID, "session-a")
  for (const key of ["OMPIUI_TOOL_INTERACTION_ENDPOINT", "OMPIUI_TOOL_INTERACTION_TOKEN", "OMPIUI_TOOL_INTERACTION_RUNTIME_ID"]) assert.equal(run.options.env[key], "")
  assert.equal(run.options.env.CI, undefined); assert.equal(run.options.env.KEEP, "yes")
  assert.equal(isToolInteractionDescriptor(f.updates[0].details.toolInteraction), true)
  assert.equal(f.updates.at(-1)!.details.toolInteraction.pid, 123)
  const client = f.connect(); client.disconnect()
  assert.equal(run.aborts, 0)
  run.onChunk(null, "answer\r\n")
  run.finish({ exitCode: 0, cancelled: false, timedOut: false })
  const result = await promise
  assert.equal(result.content[0].text, "answer\n")
  assert.equal(result.details.timeoutDisabled, true); assert.equal(result.details.requestedTimeoutSeconds, undefined)
  assert.equal(result.details.toolInteraction.status, "exited")
  assert.equal(record.pty, null)
})

test("leases never steal, input ACKs are idempotent and resize/cancel use the owner", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const { promise, record, run } = await f.start()
  const id = f.identity(record), op = f.helpers.operation
  const lease = op({ ...id, operation: "claim", writerId: "writer" })
  assert.throws(() => op({ ...id, operation: "claim", writerId: "other" }), /Another writer|Invalid writerEpoch/)
  assert.throws(() => op({ ...id, operation: "claim", writerId: "writer" }), /Invalid writerEpoch/)
  const owner = { ...id, writerId: lease.writerId, writerEpoch: lease.writerEpoch }
  const ack = op({ ...owner, operation: "input", sequence: 1, data: "answer\n" })
  assert.equal(ack.lastAcceptedSequence, 1)
  assert.equal(op({ ...owner, operation: "input", sequence: 1, data: "answer\n" }).lastAcceptedSequence, 1)
  assert.deepEqual(f.writes, ["answer\n"])
  assert.throws(() => op({ ...owner, operation: "input", sequence: 1, data: "changed" }), /different data/)
  assert.throws(() => op({ ...owner, operation: "input", sequence: 3, data: "gap" }), /consecutive/)
  assert.throws(() => op({ ...owner, operation: "resize", cols: 501, rows: 20 }), /Invalid cols/)
  op({ ...owner, operation: "resize", cols: 120, rows: 40 })
  assert.deepEqual(f.resizes, [[120, 40]])
  f.setTime(5000)
  const resumed = op({ ...owner, operation: "claim" })
  assert.equal(resumed.writerEpoch, lease.writerEpoch); assert.equal(resumed.lastAcceptedSequence, 1); assert.equal(resumed.expiresAt, 65000)
  op({ ...owner, operation: "cancel" }); op({ ...owner, operation: "cancel" })
  assert.equal(run.aborts, 1)
  run.finish({ exitCode: undefined, cancelled: true, timedOut: false })
  await assert.rejects(promise, /Command aborted/)
})

test("expired or released epochs require an explicit new claim and unknown writes cannot be replayed", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const { promise, record, run } = await f.start()
  const id = f.identity(record), op = f.helpers.operation
  const lease = op({ ...id, operation: "claim", writerId: "writer" })
  const owner = { ...id, writerId: lease.writerId, writerEpoch: lease.writerEpoch }
  f.setTime(62000)
  assert.throws(() => op({ ...owner, operation: "input", sequence: 1, data: "x" }), /expired/)
  assert.throws(() => op({ ...owner, operation: "claim" }), /no longer exists/)
  const fresh = op({ ...id, operation: "claim", writerId: "writer" })
  assert.notEqual(fresh.writerEpoch, lease.writerEpoch)
  const nextOwner = { ...id, writerId: fresh.writerId, writerEpoch: fresh.writerEpoch }
  f.setWriteThrows()
  assert.throws(() => op({ ...nextOwner, operation: "input", sequence: 1, data: "x" }), (error: any) => error.code === "INPUT_ACK_UNKNOWN")
  assert.equal(fresh.lastAcceptedSequence, 0)
  op({ ...nextOwner, operation: "release" })
  const again = op({ ...id, operation: "claim", writerId: "writer" })
  assert.throws(() => op({ ...id, ...again, operation: "input", sequence: 1, data: "x" }), (error: any) => error.code === "INPUT_ACK_UNKNOWN")
  run.finish({ exitCode: 0, cancelled: false, timedOut: false }); await promise
})

test("input limits enforce UTF-8 size, frame rate and refill without duplicate writes", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const { promise, record, run } = await f.start()
  const id = f.identity(record), op = f.helpers.operation
  const lease = op({ ...id, operation: "claim", writerId: "writer" })
  const owner = { ...id, ...lease }
  assert.throws(() => op({ ...owner, operation: "input", sequence: 1, data: "界".repeat(11000) }), /32 KiB/)
  assert.throws(() => op({ ...owner, operation: "input", sequence: 1, data: "\ud800" }), /valid Unicode/)
  for (let sequence = 1; sequence <= 60; sequence++) op({ ...owner, operation: "input", sequence, data: "x" })
  assert.throws(() => op({ ...owner, operation: "input", sequence: 61, data: "x" }), /rate limit/)
  assert.equal(f.writes.length, 60)
  assert.equal(op({ ...owner, operation: "input", sequence: 60, data: "x" }).lastAcceptedSequence, 60)
  f.setTime(2000)
  assert.equal(op({ ...owner, operation: "input", sequence: 61, data: "x" }).lastAcceptedSequence, 61)
  run.finish({ exitCode: 0, cancelled: false, timedOut: false }); await promise
})

test("UTF-8 replay is bounded, cursor reset is explicit and reads respect JSON frame capacity", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const { promise, record, run } = await f.start()
  f.helpers.append(record, "\ud83d"); f.helpers.append(record, "\ude00")
  assert.equal(record.cursor, 2)
  assert.throws(() => f.helpers.operation({ ...f.identity(record), operation: "read", cursor: 1 }), /splits a Unicode/)
  f.helpers.append(record, "界😀".repeat(400000))
  assert.ok(record.outputBytes <= 2 * 1024 * 1024)
  assert.equal(record.chunks.join("").isWellFormed(), true)
  const read = f.helpers.operation({ ...f.identity(record), operation: "read", cursor: 0, maxBytes: 32768 })
  assert.equal(read.reset, true); assert.equal(read.fromCursor, record.oldestCursor)
  assert.ok(Buffer.byteLength(read.data) <= 32768); assert.equal(read.data.isWellFormed(), true)
  f.helpers.append(record, " ".repeat(32768))
  const escaped = f.helpers.operation({ ...f.identity(record), id: "read", operation: "read", cursor: record.cursor - 32768, maxBytes: 32768 })
  assert.ok(Buffer.byteLength(JSON.stringify({ id: "read", ok: true, data: escaped }) + "\n") <= 65536)
  assert.ok(escaped.data.length > 0)
  assert.equal("chunks" in f.helpers.operation({ ...f.identity(record), operation: "describe" }), false)
  assert.throws(() => f.helpers.operation({ ...f.identity(record), runtimeId: "other", operation: "read" }), /identity is not current/)
  run.finish({ exitCode: 0, cancelled: false, timedOut: false }); await promise
})

test("preflight rejects permission, invalid cwd and URL cwd before creating a process", async t => {
  for (const mode of ["block", "deny", "cwd", "url", "aborted"]) {
    const f = fixture(); await f.boot()
    if (mode === "block") f.setBlocked()
    if (mode === "deny") f.setDenied()
    if (mode === "cwd") f.setInvalidCwd()
    const signal = new AbortController(); if (mode === "aborted") signal.abort()
    await assert.rejects(f.registrations[0].execute("call", { command: "read answer", pty: true, cwd: mode === "url" ? "skill://path" : undefined }, signal.signal, undefined, f.ctx))
    assert.equal(f.runs.length, 0)
    await f.close()
  }
  t.assert.ok(true)
})

test("timeout and nonzero completion keep official error result metadata", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const timeout = await f.start({ timeout: 100 })
  assert.equal(timeout.run.options.timeoutMs, 30000)
  timeout.run.onChunk(null, "waiting")
  timeout.run.finish({ exitCode: undefined, cancelled: true, timedOut: true })
  const result = await timeout.promise
  assert.equal(result.isError, true); assert.equal(result.details.timedOut, true)
  assert.equal(result.details.timeoutSeconds, 30); assert.equal(result.details.requestedTimeoutSeconds, 100)
  assert.match(result.content[0].text, /Timeout clamped to 30s/)
  assert.match(result.content[0].text, /Command timed out after 30 seconds/)
  const failed = await f.start()
  failed.run.finish({ exitCode: 7, cancelled: false, timedOut: false })
  const failure = await failed.promise
  assert.equal(failure.isError, true); assert.equal(failure.details.exitCode, 7)
  assert.match(failure.content[0].text, /Command exited with code 7/)
})

test("session switches isolate executions, retention is bounded, shutdown aborts each process once", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const active = await f.start()
  f.setSession("session-b"); await f.events.get("session_switch")!({}, f.ctx)
  const list = f.helpers.operation({ operation: "list", sessionId: "session-b" })
  assert.equal(list.executions.length, 0)
  assert.throws(() => f.helpers.operation({ ...f.identity(active.record), operation: "describe" }), /identity is not current/)
  f.setSession("session-a"); await f.events.get("session_switch")!({}, f.ctx)
  for (let i = 0; i < 40; i++) f.helpers.state.records.set("exit-" + i, { ...active.record, executionId: "exit-" + i, status: "exited", exitedAt: 1000 + i, chunks: [] })
  f.helpers.cleanup()
  assert.equal([...f.helpers.state.records.values()].filter((record: Value) => record.status === "exited").length, 32)
  f.setTime(700000); f.helpers.cleanup()
  assert.equal(f.helpers.state.records.size, 1)
  await f.close(); await f.close()
  assert.equal(active.run.aborts, 1)
  active.run.finish({ exitCode: undefined, cancelled: true, timedOut: false })
  await assert.rejects(active.promise, /Command aborted/)
})

test("per-connection backpressure queues are bounded and detach never cancels execution", async t => {
  const f = fixture(); t.after(() => f.close()); await f.boot()
  const client = f.connect({ backpressure: true })
  client.send({ id: "hello", operation: "hello", token: "fixture-token", protocolVersion: 1 })
  for (let i = 0; i < 100; i++) client.send({ id: String(i), operation: "list", sessionId: "session-a" })
  assert.equal(client.destroyed, true)
  assert.ok(client.responses.length < 100)
  client.drain(); await Promise.resolve()
  assert.equal(f.helpers.state.connections.size, 0)
})
