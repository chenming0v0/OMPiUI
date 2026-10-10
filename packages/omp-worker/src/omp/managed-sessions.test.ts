import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { assertOmpSessionFile, backupOmpSession, isOmpSessionFile, managedSessionsRoot, ompSessionsRoot } from "./managed-sessions.js"

test("native and legacy sessions are allowed and takeover backups never change the original bytes", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-shared-sessions-"))
  const previous = { agent: process.env.OMP_AGENT_DIR, data: process.env.OMPIUI_DATA_DIR }
  process.env.OMP_AGENT_DIR = path.join(root, "agent")
  process.env.OMPIUI_DATA_DIR = path.join(root, "webui")
  t.after(() => {
    if (previous.agent === undefined) delete process.env.OMP_AGENT_DIR
    else process.env.OMP_AGENT_DIR = previous.agent
    if (previous.data === undefined) delete process.env.OMPIUI_DATA_DIR
    else process.env.OMPIUI_DATA_DIR = previous.data
    rmSync(root, { recursive: true, force: true })
  })
  const contents = Buffer.from('{"type":"session","id":"shared","cwd":"C:/project"}\r\n{"type":"message","id":"last-tui-reply"}\r\n')
  for (const base of [ompSessionsRoot(), managedSessionsRoot()]) {
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
  assert.equal(readdirSync(backups).length, 2)
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
