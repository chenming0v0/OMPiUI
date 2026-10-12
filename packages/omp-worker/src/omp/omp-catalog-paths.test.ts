import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { OmpCatalog } from "./omp-catalog.js"

function fixture(t: TestContext, cwd: string) {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-catalog-paths-"))
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, OMP_PROFILE: process.env.OMP_PROFILE, PI_PROFILE: process.env.PI_PROFILE }
  process.env.PI_CODING_AGENT_DIR = root
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  const directory = path.join(root, "sessions", "project")
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, "session.jsonl")
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "path-alias", cwd, timestamp: "2026-10-12T00:00:00Z" })}\n`)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, file }
}

test("catalog discovers the same session through a directory alias without writing history", async t => {
  const f = fixture(t, "")
  const cwd = path.join(f.root, "workspace")
  const alias = path.join(f.root, "alias")
  mkdirSync(cwd)
  symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir")
  writeFileSync(f.file, `${JSON.stringify({ type: "session", version: 3, id: "path-alias", cwd, timestamp: "2026-10-12T00:00:00Z" })}\n`)
  const before = readFileSync(f.file)
  const modified = statSync(f.file).mtimeMs
  const listed = await new OmpCatalog().listSessions(alias) as Array<{ id: string }>
  assert.ok(listed.some(item => item.id === "path-alias"))
  assert.deepEqual(readFileSync(f.file), before)
  assert.equal(statSync(f.file).mtimeMs, modified)
})

test("catalog matches a Windows short path to OMP's long-path session header", { skip: process.platform !== "win32" }, async t => {
  const short = `${path.parse(process.env.ProgramFiles || "C:\\Program Files").root}PROGRA~1`
  if (!existsSync(short)) return t.skip("Windows 8.3 aliases are disabled on this volume")
  const long = realpathSync.native(short)
  if (short.toLowerCase() === long.toLowerCase()) return t.skip("No expanded Windows path available")
  fixture(t, long)
  const listed = await new OmpCatalog().listSessions(short) as Array<{ id: string }>
  assert.ok(listed.some(item => item.id === "path-alias"))
})
