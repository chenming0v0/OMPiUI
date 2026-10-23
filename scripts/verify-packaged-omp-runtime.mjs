import { spawn, execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { inspectOmpRuntime } from "./prepare-omp-runtime.mjs"

// Release smoke, not a unit test: relocate the actual runtime, remove global
// npm/Bun/OMP PATH entries and continue one native session in Node and in the
// compiled Bun adapter. The model endpoint stays entirely on loopback.
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== "--runtime") throw new Error("Usage: verify-packaged-omp-runtime.mjs --runtime <prepared-resource-directory>")
const source = resolve(args[1])
const manifest = inspectOmpRuntime(source)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = mkdtempSync(join(tmpdir(), "ompiui isolated release space-"))
const relocated = join(root, "omp-runtime")
const suffix = process.platform === "win32" ? ".exe" : ""
const worker = join(repoRoot, "packages", "omp-worker", "dist", "omp")
function workerImport(file, mode) {
  const url = pathToFileURL(join(worker, file))
  return JSON.stringify(mode === "compile" ? fileURLToPath(url).replaceAll("\\", "/") : url.href)
}
const harness = mode => String.raw`
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OmpRpcSession } from ${workerImport("omp-session.js", mode)};
import { OmpRpcClient, unwrapResponse } from ${workerImport("rpc-client.js", mode)};
import { getOmpSettings, patchOmpSettings } from ${workerImport("omp-settings.js", mode)};
import { OmpPackages } from ${workerImport("omp-packages.js", mode)};
import { resolveOmpCommand } from ${workerImport("omp-command.js", mode)};
import { detectOmpVersion } from ${workerImport("omp-version.js", mode)};
const root = process.env.OMPIUI_SMOKE_ROOT;
const cwd = path.join(root, "work space");
const agent = process.env.PI_CODING_AGENT_DIR;
mkdirSync(cwd, { recursive: true });
mkdirSync(agent, { recursive: true });
const fixture = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frame = delta => ({ id: "isolated-release", object: "chat.completion.chunk", created: 1, model: "offline",
    choices: [{ index: 0, delta, finish_reason: null }] });
  response.write("data: " + JSON.stringify(frame({ role: "assistant", content: "Isolated release continuation reply" })) + "\n\n");
  response.write("data: " + JSON.stringify({ ...frame({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
  response.end("data: [DONE]\n\n");
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
writeFileSync(path.join(agent, "models.yml"), JSON.stringify({ providers: { "release-fixture": {
  baseUrl: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "isolated-offline", api: "openai-completions",
  models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
writeFileSync(path.join(agent, "config.yml"), "modelRoles:\n  default: release-fixture/offline\ntask:\n  maxRecursionDepth: 3\n");
let runtime;
let terminal;
try {
  assert.equal(await detectOmpVersion(), process.env.OMPIUI_SMOKE_VERSION);
  // Real settings/plugin routes exercise the private Bun public API runner.
  assert.equal((await getOmpSettings(cwd)).global.task.maxRecursionDepth, 3);
  await patchOmpSettings(cwd, { task: { maxRecursionDepth: 4 } });
  assert.equal((await getOmpSettings(cwd)).global.task.maxRecursionDepth, 4);
  const invocation = resolveOmpCommand();
  const officialConfig = JSON.parse(execFileSync(invocation.command, [...invocation.args, "config", "get", "task.maxRecursionDepth", "--json"], { cwd, encoding: "utf8", windowsHide: true }));
  assert.equal(officialConfig.value, 4);
  assert.deepEqual(await new OmpPackages().list(cwd), { packages: [], marketplaces: [] });
  runtime = await OmpRpcSession.open(cwd);
  const id = runtime.getSessionId();
  const file = runtime.getSessionFile();
  await runtime.sendUserMessage("Release UI creates an isolated native history");
  await runtime.waitForIdle();
  await runtime.dispose(); runtime = undefined;
  assert.match(readFileSync(file, "utf8"), /Isolated release continuation reply/);
  terminal = new OmpRpcClient({ cwd, args: ["--resume", file] });
  await terminal.waitForReady();
  assert.equal(unwrapResponse(await terminal.request({ type: "get_state" })).sessionId, id);
  unwrapResponse(await terminal.request({ type: "prompt", message: "Official CLI continues release UI history" }));
  const deadline = Date.now() + 30000;
  let settled = false;
  while (Date.now() < deadline) {
    if (unwrapResponse(await terminal.request({ type: "get_state" })).isSettled === true) { settled = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(settled, true, "Official standalone CLI turn must settle");
  await terminal.close(); terminal = undefined;
  runtime = await OmpRpcSession.open(cwd, file);
  assert.equal(runtime.getSessionId(), id);
  await runtime.sendUserMessage("Release UI resumes after the official standalone CLI");
  await runtime.waitForIdle();
  await runtime.dispose(); runtime = undefined;
  const history = readFileSync(file, "utf8");
  assert.match(history, /Release UI creates an isolated native history/);
  assert.match(history, /Official CLI continues release UI history/);
  assert.match(history, /Release UI resumes after the official standalone CLI/);
  let header;
  for (const line of history.split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === "session") { header = record; break; }
  }
  assert.equal(header?.id, id, "Persisted official session header must retain the runtime identity");
  console.info("PASS: " + (process.versions.bun ? "compiled Bun" : "Node") + " isolated public APIs, exact OMP version and bidirectional native session continuation");
} finally {
  await runtime?.dispose();
  await terminal?.close();
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
`

async function run(command, argv, env) {
  await new Promise((yes, no) => {
    const child = spawn(command, argv, { cwd: root, env, stdio: "inherit", shell: false, windowsHide: true })
    const timer = setTimeout(() => { child.kill(); no(new Error("Isolated release runtime smoke timed out")) }, 180_000)
    child.once("error", error => { clearTimeout(timer); no(error) })
    child.once("exit", code => { clearTimeout(timer); code === 0 ? yes() : no(new Error(`Isolated release smoke exited ${code}`)) })
  })
}

try {
  cpSync(source, relocated, { recursive: true })
  inspectOmpRuntime(relocated)
  const entry = join(root, "smoke.mjs")
  const compileEntry = join(root, "smoke-build.mjs")
  const compiled = join(root, `runtime-smoke${suffix}`)
  const bun = join(relocated, "bin", `bun${suffix}`)
  writeFileSync(entry, harness("node"))
  writeFileSync(compileEntry, harness("compile"))
  execFileSync(bun, ["build", compileEntry, "--compile", "--outfile", compiled], { cwd: repoRoot, stdio: "inherit", windowsHide: true })
  // Keep only system executables. Neither the npm global prefix nor Bun's
  // install/global locations are inherited, and all OMP override keys are reset.
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|OMP.*|OMPI.*|PI_.*|NODE_PATH|BUN_INSTALL)$/i.test(key)))
  const environment = mode => {
    const home = join(root, mode)
    mkdirSync(home)
    return { ...base, PATH: process.platform === "win32" ? join(process.env.SystemRoot, "System32") : "/usr/bin:/bin",
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      PI_CODING_AGENT_DIR: join(home, "agent"), OMPIUI_DATA_DIR: join(home, "webui"),
      OMPIUI_SMOKE_ROOT: home, OMPIUI_SMOKE_VERSION: manifest.version }
  }
  await run(process.execPath, [entry], environment("node"))
  await run(compiled, [], environment("compiled"))
  console.info(`PASS: relocated ${manifest.platform}/${manifest.arch} release resource, official OMP ${manifest.version}, private Bun ${manifest.bunVersion}; no global OMP/npm/Bun lookup`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
