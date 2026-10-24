import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

// Main runs AFTER the shared build: node scripts/verify-native-terminal.mjs
// Or bun scripts/verify-native-terminal.mjs to exercise the Bun PTY backend.
// Actual official OMP + actual PTY; only provider HTTP is an offline fixture.
const root = mkdtempSync(path.join(tmpdir(), "ompiui-native-pty-"))
const cwd = path.join(root, "work space 中文 & literal")
const agent = path.join(root, "agent")
const temporary = path.join(root, "host temp")
const home = path.join(root, "home")
for (const directory of [cwd, agent, temporary, home]) mkdirSync(directory)
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: agent, OMPIUI_DATA_DIR: path.join(root, "webui"),
  TMPDIR: temporary, TMP: temporary, TEMP: temporary,
  HOME: home, USERPROFILE: home, PI_CONFIG_DIR: ".omp",
  XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
  OMP_PROFILE: "", PI_PROFILE: "", PI_CODING_AGENT_SESSION_DIR: "", OMP_AGENT_DIR: "",
})
const { TerminalManager } = await import("../packages/server/dist/host/terminal-manager.js")
const { OmpRpcClient, unwrapResponse } = await import("../packages/omp-worker/dist/omp/rpc-client.js")
const { detectOmpVersion } = await import("../packages/omp-worker/dist/omp/omp-version.js")
let replies = 0
const fixture = createServer((request, response) => {
  request.resume()
  response.writeHead(200, { "content-type": "text/event-stream" })
  const reply = `Offline native fixture reply ${++replies}`
  const chunk = delta => ({ id: `offline-${replies}`, object: "chat.completion.chunk", created: 1,
    model: "offline", choices: [{ index: 0, delta, finish_reason: null }] })
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: reply }))}\n\n`)
  response.write(`data: ${JSON.stringify({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 } })}\n\n`)
  response.end("data: [DONE]\n\n")
})
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve))
writeFileSync(path.join(agent, "models.yml"), `providers:
  native-fixture:
    baseUrl: http://127.0.0.1:${fixture.address().port}/v1
    apiKey: sk-offline-fixture
    api: openai-completions
    models:
      - id: offline
        name: Offline
        reasoning: false
        input: [text]
        contextWindow: 128000
        maxTokens: 4096
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
`)
mkdirSync(path.join(agent, "extensions"))
const customResult = path.join(root, "custom-result.json")
writeFileSync(path.join(agent, "extensions", "native-fixture.ts"), `import { writeFileSync } from "node:fs";
export default function(api) {
  api.on("session_start", (_event, ctx) => ctx.ui.notify("Native fixture ready", "info"));
  api.registerCommand("native-custom", {
    description: "Isolated real custom UI choice",
    async handler(_args, ctx) {
      const result = await ctx.ui.custom((_tui, _theme, _keys, done) => ({
        render() { return ["Native custom choice: press x to select workspace-safe"]; },
        invalidate() {},
        handleInput(data) { if (data === "x") done("workspace-safe"); },
      }));
      writeFileSync(${JSON.stringify(customResult)}, JSON.stringify({ result }));
      ctx.ui.notify("Native custom selected " + result, "info");
    },
  });
}
`)
writeFileSync(path.join(agent, "config.yml"), "modelRoles:\n  default: native-fixture/offline\n  plan: native-fixture/offline\nplan:\n  enabled: true\ngoal:\n  enabled: true\nautoResume: false\nadvisor:\n  enabled: false\n")

let rpc
let manager
let unrelated
let sessionId
const file = path.join(cwd, "shared session 中文 & literal.jsonl")
let releaseCount = 0
let activeLease = false
let native
const transcripts = new Map()
function text(value) {
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]/g, "")
}
function attach(owner, info) {
  const stream = { raw: "", query: "" }
  transcripts.set(info.id, stream)
  const attachment = owner.attach(cwd, info.id, undefined, data => {
    stream.raw += data
    stream.query += data
    const queries = [
      [/\x1b\[6n/g, "\x1b[1;1R"], [/\x1b\[c/g, "\x1b[?1;2c"],
      [/\x1b\[\?u/g, "\x1b[?0u"], [/\x1b\[>q/g, "\x1bP>|xterm\x1b\\"],
    ]
    for (const [pattern, reply] of queries) {
      stream.query = stream.query.replace(pattern, () => {
        owner.write(cwd, info.id, reply)
        return ""
      })
    }
    stream.query = stream.query.slice(-256)
  }, () => {})
  stream.raw += attachment.replay
  attachment.activate()
  return stream
}
async function waitFor(predicate, label, stream, ms = 30_000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label}\n${text(stream?.raw ?? "").slice(-6000)}`)
    await delay(40)
  }
}
async function command(owner, info, input, expected) {
  const stream = transcripts.get(info.id)
  const offset = stream.raw.length
  owner.write(cwd, info.id, input)
  await delay(80)
  owner.write(cwd, info.id, "\r")
  if (expected) await waitFor(() => expected.test(text(stream.raw.slice(offset))), `No TUI result for ${input}`, stream)
  return stream
}
async function rpcTurn(input) {
  unwrapResponse(await rpc.request({ type: "prompt", message: input }))
  await waitFor(() => readFileSync(file, "utf8").includes(input), "RPC user turn not persisted")
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (unwrapResponse(await rpc.request({ type: "get_state" })).isSettled === true) return
    await delay(100)
  }
  throw new Error("Offline RPC turn did not settle")
}
function ownedManager() {
  return new TerminalManager({
    prepareNativeSession: async (_workspace, requestedId) => {
      assert.equal(requestedId, sessionId)
      assert.equal(activeLease, false)
      activeLease = true
      return { sessionFile: file, cwd, release() { activeLease = false; releaseCount++ } }
    },
  })
}

try {
  console.info(`Official OMP under test: ${await detectOmpVersion()}; PTY runtime: ${globalThis.Bun ? "Bun" : "Node"}`)
  // A custom absolute file exercises spaces, Unicode and cmd metacharacters as argv.
  rpc = new OmpRpcClient({ cwd, args: ["--session", file] })
  await rpc.waitForReady()
  await rpcTurn("UI-side original persisted history")
  sessionId = unwrapResponse(await rpc.request({ type: "get_state" })).sessionId
  await rpc.close()
  rpc = undefined
  manager = ownedManager()
  assert.deepEqual(manager.list(cwd), [])
  assert.equal(activeLease, false)
  native = await manager.create(cwd, { nativeSessionId: sessionId, rows: 40, cols: 150 })
  assert.equal(native.sessionFile, file)
  const output = attach(manager, native)
  await waitFor(() => text(output.raw).includes("Native fixture ready"), "Official TUI never became ready", output)
  assert.equal(activeLease, true)
  assert.throws(() => manager.remove(cwd, native.id), error => error.code === "NATIVE_TERMINAL_ACTIVE")
  assert.throws(() => manager.closeWorkspace(cwd), error => error.code === "NATIVE_TERMINAL_ACTIVE")
  await command(manager, native, "/collab status", /Not in a collab session/)
  await command(manager, native, "/plan", /Plan mode enabled/)
  await command(manager, native, "/plan-review", /No plan to review yet/)
  await command(manager, native, "/plan", /Plan mode paused/)
  await command(manager, native, "/plan", /Plan mode disabled/)
  await command(manager, native, "/loop 1", /Loop mode enabled/)
  await command(manager, native, "/loop", /Loop mode disabled/)
  const beforeGoal = replies
  await command(manager, native, "/guided-goal isolate native handoff smoke", /Offline native fixture reply/)
  assert.ok(replies > beforeGoal, "Guided Goal did not reach the actual provider path")
  await command(manager, native, "/record", /Recording to/)
  await command(manager, native, "/native-custom", /Native custom choice/)
  manager.write(cwd, native.id, "x")
  await waitFor(() => { try { return JSON.parse(readFileSync(customResult, "utf8")).result === "workspace-safe" } catch { return false } }, "Native custom keyboard choice not delivered", output)
  await waitFor(() => text(output.raw).includes("Native custom selected workspace-safe"), "Custom selection not rendered", output)
  await command(manager, native, "/record", /Saved .*recording to/)
  const recordings = path.join(temporary, "omp-recordings")
  const recordedFile = readdirSync(recordings).find(name => name.endsWith(".ompcast"))
  assert.ok(recordedFile, "Actual /record did not produce a host recording")
  assert.match(readFileSync(path.join(recordings, recordedFile), "utf8"), /Native custom/)
  await command(manager, native, "Native TUI continues same exact file", /Offline native fixture reply/)
  await command(manager, native, "/quit")
  await waitFor(() => manager.get(cwd, native.id).status === "exited", "Native /quit did not exit", output)
  assert.equal(releaseCount, 1)
  assert.equal(activeLease, false)
  assert.match(readFileSync(file, "utf8"), /UI-side original persisted history/)
  assert.match(readFileSync(file, "utf8"), /Native TUI continues same exact file/)

  const playback = await manager.create(cwd, { ompCommand: "play", rows: 40, cols: 150 })
  assert.equal(playback.ompCommand, "play")
  const playbackOutput = attach(manager, playback)
  await waitFor(() => manager.get(cwd, playback.id).status === "exited", "omp play did not finish", playbackOutput)
  assert.equal(manager.get(cwd, playback.id).exitCode, 0)
  assert.match(text(playbackOutput.raw), /Native custom/)

  rpc = new OmpRpcClient({ cwd, args: ["--session", file] })
  await rpc.waitForReady()
  assert.equal(unwrapResponse(await rpc.request({ type: "get_state" })).sessionId, sessionId)
  await rpcTurn("UI-side continues after real TUI exit")
  await rpc.close()
  rpc = undefined
  assert.match(readFileSync(file, "utf8"), /UI-side continues after real TUI exit/)

  // An independently owned PTY remains alive while manager shuts down its own TUI.
  unrelated = new TerminalManager()
  const external = await unrelated.create(cwd, { title: "Other owner" })
  attach(unrelated, external)
  native = await manager.create(cwd, { nativeSessionId: sessionId, rows: 40, cols: 150 })
  const shutdownOutput = attach(manager, native)
  await waitFor(() => text(shutdownOutput.raw).includes("Native fixture ready"), "Second TUI did not become ready", shutdownOutput)
  assert.equal(activeLease, true)
  assert.equal(releaseCount, 1)
  await manager.shutdown()
  assert.equal(activeLease, false)
  assert.equal(releaseCount, 2)
  assert.equal(unrelated.get(cwd, external.id).status, "running")
  await assert.rejects(manager.create(cwd), error => error.code === "TERMINAL_CLOSED")
  console.info("PASS: actual official TUI, shared absolute --session file, bidirectional persisted continuation, no browse writer, active-native close refusal, real exit leases, owned-only shutdown")
  console.info("PASS: real TUI Plan toggles, Plan Review no-plan diagnostic, Loop toggles, Guided Goal interview kickoff, keyboard custom UI, /record host capture and omp play rendering")
  console.info("LIMIT: no completed Plan approval/refinement, repeating Loop work, autonomous Goal completion, Vibe worker runs, Git staging/commit/worktree relocation, remote Collab participants, public stream credentials/publication, microphone/STT/TTS/live audio or browser visual proof. No equivalent web buttons or fabricated success asserted.")
} finally {
  await rpc?.close()
  await manager?.shutdown()
  await unrelated?.shutdown()
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
  // Remove only this fixture's temp tree after real owned-process exit.
  rmSync(root, { recursive: true, force: true })
}
