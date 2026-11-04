import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { inspectOmpRuntimes } from "@ompiui/omp-worker"
import { createAppServer, type AppServer } from "./http.ts"
import { RuntimeSupervisor } from "./omp/supervisor.ts"

/** Drive the real HTTP request handler without listening or starting a service. */
async function request(app: AppServer, url: string, token?: string, method = "GET") {
  const req = new IncomingMessage(new Socket())
  req.url = url
  req.method = method
  req.headers.host = "127.0.0.1"
  if (token) req.headers.authorization = `Bearer ${token}`
  const res = new ServerResponse(req)
  const chunks: Buffer[] = []
  const done = new Promise<{ status: number; body: any }>(resolve => {
    res.write = ((chunk: string | Buffer) => { chunks.push(Buffer.from(chunk)); return true }) as typeof res.write
    res.end = ((chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.from(chunk))
      res.emit("finish")
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
      return res
    }) as typeof res.end
  })
  app.server.emit("request", req, res)
  return done
}

test("runtime GET uses the backend environment and authentication; worker hello alone is not OMP availability", async t => {
  const previous = { ...process.env }
  process.env.OMPI_OMP_BIN = "omp"
  delete process.env.OMPI_OMP_RUNTIME_DIR
  process.env.PATH = ""
  t.after(() => { process.env = previous })
  const supervisor = new RuntimeSupervisor()
  let ready = false
  t.mock.method(supervisor, "peekCatalogHandshake", async () => ready ? { ompVersion: null } : undefined)
  const spawn = t.mock.method(supervisor, "getCatalogHandshake", () => { throw new Error("read must not spawn a worker") })
  const app = createAppServer({ authToken: "runtime-token", supervisor })
  t.after(() => app.dispose())
  assert.equal((await request(app, "/api/v1/host/omp-runtime")).status, 401)
  assert.equal((await request(app, "/api/v1/host/omp-runtime", "runtime-token", "POST")).status, 405)
  const expected = await inspectOmpRuntimes({ ...process.env })
  const inspection = await request(app, "/api/v1/host/omp-runtime", "runtime-token")
  assert.equal(inspection.status, 200)
  assert.deepEqual(inspection.body, expected)
  assert.equal(inspection.body.selected, null)
  assert.match(inspection.body.error!, /Cannot locate/)
  for (ready of [false, true]) {
    const health = await request(app, "/api/v1/host/health", "runtime-token")
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)
    assert.equal(health.body.workerReady, ready)
    assert.equal(health.body.ompVersion, null)
  }
  assert.equal(spawn.mock.callCount(), 0)
  assert.equal(app.server.listening, false)
})

test("inspect-runtime prints only JSON and exits successfully without a runtime or server/Agent imports", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-inspection-entry-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const entryDir = path.join(root, "packages", "server", "src")
  const workerDir = path.join(root, "packages", "omp-worker", "dist", "omp")
  mkdirSync(entryDir, { recursive: true })
  mkdirSync(workerDir, { recursive: true })
  const here = path.dirname(fileURLToPath(import.meta.url))
  const entry = path.join(entryDir, "bundle-entry.mjs")
  writeFileSync(entry, readFileSync(path.join(here, "bundle-entry.ts"), "utf8"))
  // Only pure parser/version modules are present. Any server/Agent import must fail.
  for (const name of ["omp-runtime-inspection", "omp-command", "omp-runtime", "omp-version"]) {
    copyFileSync(path.join(here, "../../omp-worker/dist/omp", `${name}.js`), path.join(workerDir, `${name}.js`))
  }
  const loader = path.join(root, "guard.mjs")
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    if (/start\\.(ts|js)$|worker.*entry|workspace-watch|omp-session|rpc-client/.test(specifier)) throw new Error('Agent/server import forbidden: ' + specifier);
    return next(specifier, context);
  }`)
  const result = execFileSync(process.execPath, ["--loader", pathToFileURL(loader).href, entry, "inspect-runtime"], {
    cwd: root, env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "1", PATH: "", OMPI_OMP_BIN: undefined, OMPI_OMP_RUNTIME_DIR: undefined },
    encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  })
  const inspection = JSON.parse(result)
  assert.equal(result, `${JSON.stringify(inspection)}\n`)
  assert.equal(inspection.selected, null)
  assert.deepEqual(inspection.candidates, [])
  assert.equal(inspection.bundled, false)
  assert.match(inspection.error, /Cannot locate/)
  assert.equal(inspection.configuredBin, null)
  assert.equal(inspection.configuredRuntimeDir, null)
})
