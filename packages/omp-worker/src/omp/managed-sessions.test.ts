import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { assertOmpSessionFile, backupOmpSession, isOmpSessionFile, managedSessionsRoot, ompSessionsRoot } from "./managed-sessions.js"

test("native and legacy sessions are allowed and takeover backups never change the original bytes", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-shared-sessions-"))
  const keys = ["PI_CODING_AGENT_DIR", "OMP_AGENT_DIR", "OMPIUI_DATA_DIR", "PI_CODING_AGENT_SESSION_DIR", "OMP_PROFILE", "PI_PROFILE"]
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent")
  const historicalRoot = path.join(root, "historical-agent", "sessions")
  process.env.OMP_AGENT_DIR = path.dirname(historicalRoot)
  process.env.OMPIUI_DATA_DIR = path.join(root, "webui")
  delete process.env.PI_CODING_AGENT_SESSION_DIR
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    rmSync(root, { recursive: true, force: true })
  })
  const contents = Buffer.from('{"type":"session","id":"shared","cwd":"C:/project"}\r\n{"type":"message","id":"last-tui-reply"}\r\n')
  const nativeRoot = ompSessionsRoot()
  delete process.env.PI_CODING_AGENT_DIR
  assert.notEqual(ompSessionsRoot(), historicalRoot)
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent")
  for (const base of [nativeRoot, managedSessionsRoot(), historicalRoot]) {
    const directory = path.join(base, "project")
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, "session.jsonl")
    writeFileSync(file, contents)
    assert.equal(isOmpSessionFile(file), true)
    assertOmpSessionFile(file)
    backupOmpSession(file)
    backupOmpSession(file)
    assert.deepEqual(readFileSync(file), contents)
  }
  const backups = path.join(root, "webui", "session-backups")
  assert.equal(readdirSync(backups).length, 3)
  for (const directory of readdirSync(backups)) {
    const files = readdirSync(path.join(backups, directory))
    assert.equal(files.length, 1)
    assert.deepEqual(readFileSync(path.join(backups, directory, files[0]!)), contents)
  }
  const outside = path.join(root, "outside")
  mkdirSync(outside)
  writeFileSync(path.join(outside, "session.jsonl"), contents)
  const link = path.join(ompSessionsRoot(), "escape")
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
  assert.throws(() => assertOmpSessionFile(path.join(link, "session.jsonl")), { code: "PATH_OUTSIDE_WORKSPACE" })
})
