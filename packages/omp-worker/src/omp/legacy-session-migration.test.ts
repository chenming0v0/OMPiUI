import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { OmpCatalog } from "./omp-catalog.js"
import { assertOmpSessionFile, managedSessionDirectory } from "./managed-sessions.js"
import { migrateLegacySessions, planLegacySessionMigration } from "./legacy-session-migration.js"
import { nativeOmpSessionDirectory } from "./omp-directories.js"
import { OMP_SDK_VERSION } from "./constants.js"

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-legacy-migration-"))
  const previous = { ...process.env }
  process.env.OMP_AGENT_DIR = path.join(root, "agent")
  process.env.OMPIUI_DATA_DIR = path.join(root, "webui")
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  t.after(() => {
    process.env = previous
    rmSync(root, { recursive: true, force: true })
  })
  const cwd = path.join(root, "项目 space")
  mkdirSync(cwd)
  const source = managedSessionDirectory(cwd)
  const destination = nativeOmpSessionDirectory(cwd)
  mkdirSync(source, { recursive: true })
  const content = Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: "legacy-id", cwd })}\r\n${JSON.stringify({ type: "message", id: "user", parentId: null, message: { role: "user", content: "legacy history" } })}\r\n`)
  const file = path.join(source, "legacy.jsonl")
  writeFileSync(file, content)
  mkdirSync(path.join(source, "legacy"))
  writeFileSync(path.join(source, "legacy", "child.jsonl"), "child bytes")
  return { root, cwd, source, destination, content, file }
}

test("preview and catalog browsing leave legacy history and paths unchanged", async t => {
  const f = fixture(t)
  const modified = statSync(f.file).mtimeMs
  const plan = planLegacySessionMigration(f.cwd, OMP_SDK_VERSION)
  assert.equal(plan.sessions, 1)
  const catalog = new OmpCatalog()
  assert.equal((await catalog.listSessions(f.cwd) as unknown[]).length, 1)
  await catalog.previewSession(f.cwd, f.file)
  assert.deepEqual(readFileSync(f.file), f.content)
  assert.equal(statSync(f.file).mtimeMs, modified)
  assert.equal(existsSync(f.destination), false)
})

test("migration retains identity, timestamps, children and both writable paths across atomic replacement", async t => {
  const f = fixture(t)
  mkdirSync(f.destination, { recursive: true })
  const native = path.join(f.destination, "native.jsonl")
  writeFileSync(native, JSON.stringify({ type: "session", id: "native-id", cwd: f.cwd }))
  const modified = statSync(f.file).mtimeMs
  const result = migrateLegacySessions(f.cwd, OMP_SDK_VERSION)
  const target = path.join(f.destination, "legacy.jsonl")
  assert.deepEqual(readFileSync(path.join(result.backup!, "legacy.jsonl")), f.content)
  assert.deepEqual(readFileSync(target), f.content)
  assert.equal(statSync(target).mtimeMs, modified)
  assert.equal(realpathSync(f.file), realpathSync(target))
  assertOmpSessionFile(f.file)
  assertOmpSessionFile(target)
  assert.equal(readFileSync(path.join(f.destination, "legacy", "child.jsonl"), "utf8"), "child bytes")
  assert.match(readFileSync(native, "utf8"), /native-id/)
  const catalog = new OmpCatalog()
  const list = await catalog.listSessions(f.cwd) as { id: string }[]
  assert.equal(list.filter(item => item.id === "legacy-id").length, 1)
  appendFileSync(f.file, "from UI\n")
  assert.match(readFileSync(target, "utf8"), /from UI/)
  writeFileSync(`${target}.tmp`, "atomic terminal replacement\n")
  renameSync(`${target}.tmp`, target)
  assert.equal(readFileSync(f.file, "utf8"), "atomic terminal replacement\n")
  writeFileSync(`${f.file}.tmp`, "atomic UI replacement\n")
  renameSync(`${f.file}.tmp`, f.file)
  assert.equal(readFileSync(target, "utf8"), "atomic UI replacement\n")
  assert.equal(migrateLegacySessions(f.cwd, OMP_SDK_VERSION).alreadyMigrated, true)
})

test("conflicting native history is preserved and migration is rejected before moving files", t => {
  const f = fixture(t)
  mkdirSync(f.destination, { recursive: true })
  const conflict = path.join(f.destination, "legacy.jsonl")
  writeFileSync(conflict, "newer native history")
  assert.throws(() => migrateLegacySessions(f.cwd, OMP_SDK_VERSION), /Migration conflict/)
  assert.deepEqual(readFileSync(f.file), f.content)
  assert.equal(readFileSync(conflict, "utf8"), "newer native history")
  assert.equal(existsSync(path.join(f.root, "webui", "session-migration-backups")), false)
})

test("a directory containing another workspace's session cannot be merged", t => {
  const f = fixture(t)
  writeFileSync(path.join(f.source, "other.jsonl"), JSON.stringify({ type: "session", cwd: f.root }))
  assert.throws(() => migrateLegacySessions(f.cwd, OMP_SDK_VERSION), /different workspace/)
  assert.deepEqual(readFileSync(f.file), f.content)
  assert.equal(existsSync(f.destination), false)
})

test("headerless exit remnants are reported and preserved without blocking valid sessions", t => {
  const f = fixture(t)
  const remnant = JSON.stringify({ type: "custom", customType: "session_exit", data: { reason: "sigint" } })
  writeFileSync(path.join(f.source, "exit-only.jsonl"), remnant)
  const result = migrateLegacySessions(f.cwd, OMP_SDK_VERSION)
  assert.equal(result.sessions, 1)
  assert.deepEqual(result.headerlessFiles, ["exit-only.jsonl"])
  assert.equal(readFileSync(path.join(result.backup!, "exit-only.jsonl"), "utf8"), remnant)
  assert.equal(readFileSync(path.join(f.destination, "exit-only.jsonl"), "utf8"), remnant)
})
