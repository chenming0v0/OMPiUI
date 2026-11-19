import assert from "node:assert/strict"
import crypto, { createHash } from "node:crypto"
import fs, { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { assertOmpSessionFile, backupOmpSession, isOmpSessionFile, managedSessionsRoot, ompSessionsRoot } from "./managed-sessions.js"

function fixture(t: TestContext) {
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
  return { root, historicalRoot, backups: path.join(root, "webui", "session-backups") }
}

function snapshotName(content: Buffer): string {
  return `${createHash("sha256").update(content).digest("hex")}.jsonl`
}

function makeSessionFile(base: string, name = "session.jsonl"): string {
  const directory = path.join(base, "project")
  mkdirSync(directory, { recursive: true })
  return path.join(directory, name)
}

function snapshotDirectory(backups: string, file: string): string {
  return path.join(backups, createHash("sha256").update(realpathSync(file)).digest("hex").slice(0, 24))
}

test("native and legacy sessions are allowed and takeover backups never change the original bytes", t => {
  const { root, historicalRoot, backups } = fixture(t)
  const contents = Buffer.from('{"type":"session","id":"shared","cwd":"C:/project"}\r\n{"type":"message","id":"last-tui-reply"}\r\n')
  const nativeRoot = ompSessionsRoot()
  delete process.env.PI_CODING_AGENT_DIR
  assert.notEqual(ompSessionsRoot(), historicalRoot)
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent")
  for (const base of [nativeRoot, managedSessionsRoot(), historicalRoot]) {
    const file = makeSessionFile(base)
    writeFileSync(file, contents)
    assert.equal(isOmpSessionFile(file), true)
    assertOmpSessionFile(file)
    backupOmpSession(file)
    backupOmpSession(file)
    assert.deepEqual(readFileSync(file), contents)
  }
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

function seedOlderSnapshots(directory: string): string[] {
  mkdirSync(directory, { recursive: true })
  return [1, 2, 3, 4].map(version => {
    const content = Buffer.from(`{"type":"session","id":"shared","version":${version}}\r\n`)
    const name = snapshotName(content)
    const file = path.join(directory, name)
    writeFileSync(file, content)
    utimesSync(file, version * 100, version * 100)
    return name
  })
}

test("retention is per session and prunes only complete matching snapshots", t => {
  const { backups } = fixture(t)
  const file = makeSessionFile(ompSessionsRoot())
  const previous = Buffer.from('{"type":"session","id":"shared","version":4}\r\n')
  const latest = Buffer.from('{"type":"session","id":"shared","version":5}\r\n')
  const sameTimestamp = 1000
  writeFileSync(file, previous)
  utimesSync(file, sameTimestamp, sameTimestamp)
  const directory = snapshotDirectory(backups, file)
  const older = seedOlderSnapshots(directory)
  backupOmpSession(file)
  assert.deepEqual(readdirSync(directory).sort(), older.slice(-3).sort())

  const other = makeSessionFile(ompSessionsRoot(), "other.jsonl")
  writeFileSync(other, previous)
  const otherDirectory = snapshotDirectory(backups, other)
  const otherNames = seedOlderSnapshots(otherDirectory)
  const corrupt = `${"a".repeat(64)}.jsonl`
  const nested = `${"b".repeat(64)}.jsonl`
  const userNames = ["notes.jsonl", corrupt, ".backup-user.tmp"]
  for (const name of userNames) writeFileSync(path.join(directory, name), "user data")
  // 让哈希不匹配的文件落入删除候选，确认清理仍不会触碰它。
  utimesSync(path.join(directory, corrupt), 0, 0)
  mkdirSync(path.join(directory, nested))
  writeFileSync(path.join(directory, nested, "keep"), "nested data")

  writeFileSync(file, latest)
  utimesSync(file, sameTimestamp, sameTimestamp)
  backupOmpSession(file)
  assert.deepEqual(readdirSync(directory).sort(), [...older.slice(-2), snapshotName(latest), nested, ...userNames].sort())
  for (const name of userNames) assert.equal(readFileSync(path.join(directory, name), "utf8"), "user data")
  assert.equal(readFileSync(path.join(directory, nested, "keep"), "utf8"), "nested data")
  assert.deepEqual(readdirSync(otherDirectory).sort(), otherNames.sort())
  assert.deepEqual(readFileSync(path.join(directory, snapshotName(latest))), latest)
  assert.deepEqual(readFileSync(file), latest)
  assert.deepEqual(readFileSync(other), previous)
})

test("an incomplete legacy snapshot is preserved and never satisfies deduplication", t => {
  const { backups } = fixture(t)
  const file = makeSessionFile(ompSessionsRoot())
  const content = Buffer.from('{"type":"session","id":"shared"}\r\n')
  writeFileSync(file, content)
  const directory = snapshotDirectory(backups, file)
  mkdirSync(directory, { recursive: true })
  const name = snapshotName(content)
  const partial = content.subarray(0, 12)
  writeFileSync(path.join(directory, name), partial)

  backupOmpSession(file)
  backupOmpSession(file)
  assert.deepEqual(readdirSync(directory).sort(), [name, `snapshot-${name}`].sort())
  assert.deepEqual(readFileSync(path.join(directory, name)), partial)
  assert.deepEqual(readFileSync(path.join(directory, `snapshot-${name}`)), content)
  assert.deepEqual(readFileSync(file), content)
})

test("failed atomic publication leaves previous snapshots intact and the next attempt can recover", t => {
  const { backups } = fixture(t)
  const file = makeSessionFile(ompSessionsRoot())
  const content = Buffer.from('{"type":"session","id":"shared","version":5}\r\n')
  writeFileSync(file, content)
  const directory = snapshotDirectory(backups, file)
  const older = seedOlderSnapshots(directory)
  t.mock.method(fs, "linkSync", (temporary: string, destination: string) => {
    assert.equal(path.dirname(temporary), directory)
    assert.equal(destination, path.join(directory, snapshotName(content)))
    assert.deepEqual(readFileSync(temporary), content)
    assert.deepEqual(readdirSync(directory).sort(), [...older, path.basename(temporary)].sort())
    throw Object.assign(new Error("publication failed"), { code: "EIO" })
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => backupOmpSession(file), { code: "EIO" })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual(readdirSync(directory).sort(), [...older].sort())
  assert.deepEqual(readFileSync(file), content)

  backupOmpSession(file)
  assert.deepEqual(readdirSync(directory).sort(), [...older.slice(-2), snapshotName(content)].sort())
  assert.deepEqual(readFileSync(path.join(directory, snapshotName(content))), content)
})

test("retained snapshots are not read and only deletion candidates are hashed", t => {
  const { backups } = fixture(t)
  const file = makeSessionFile(ompSessionsRoot())
  const content = Buffer.from('{"type":"session","id":"shared","version":5}\r\n')
  writeFileSync(file, content)
  const directory = snapshotDirectory(backups, file)
  const older = seedOlderSnapshots(directory)
  const reads: string[] = []
  const originalReadFile = fs.readFileSync
  t.mock.method(fs, "readFileSync", (target: fs.PathOrFileDescriptor) => {
    reads.push(String(target))
    return originalReadFile(target)
  })
  syncBuiltinESMExports()
  try {
    backupOmpSession(file)
    assert.deepEqual(reads.sort(), [realpathSync(file), ...older.slice(0, 2).map(name => path.join(directory, name))].sort())

    reads.length = 0
    backupOmpSession(file)
    assert.deepEqual(reads.sort(), [realpathSync(file), path.join(directory, snapshotName(content))].sort())

    reads.length = 0
    writeFileSync(file, Buffer.from('{"type":"session","id":"shared","version":6}\r\n'))
    backupOmpSession(file)
    assert.deepEqual(reads.sort(), [realpathSync(file), path.join(directory, older[2]!)].sort())
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(readdirSync(directory).length, 3)
})

for (const code of ["EPERM", "EOPNOTSUPP"]) {
  test(`hard-link ${code} falls back to a unique atomic rename without overwriting user files`, t => {
    const { backups } = fixture(t)
    const file = makeSessionFile(ompSessionsRoot())
    const content = Buffer.from('{"type":"session","id":"shared","version":5}\r\n')
    writeFileSync(file, content)
    const directory = snapshotDirectory(backups, file)
    const older = seedOlderSnapshots(directory)
    const digest = snapshotName(content).slice(0, -6)
    const uuids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]
    const published = `snapshot-${digest}-${uuids[2]}.jsonl`
    const occupied = [snapshotName(content), `snapshot-${snapshotName(content)}`, `snapshot-${digest}-${uuids[1]}.jsonl`]
    const userContent = Buffer.alloc(content.length, "x")
    for (const name of occupied) {
      writeFileSync(path.join(directory, name), userContent)
      utimesSync(path.join(directory, name), 0, 0)
    }
    let links = 0
    let renames = 0
    const originalRename = fs.renameSync
    t.mock.method(crypto, "randomUUID", () => {
      const uuid = uuids.shift()
      assert.ok(uuid)
      return uuid
    })
    t.mock.method(fs, "linkSync", () => {
      links += 1
      throw Object.assign(new Error("hard links unsupported"), { code })
    })
    t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
      assert.equal(path.dirname(String(source)), directory)
      assert.equal(String(destination), path.join(directory, published))
      assert.equal(fs.existsSync(destination), false)
      assert.deepEqual(readFileSync(source), content)
      renames += 1
      originalRename(source, destination)
    })
    syncBuiltinESMExports()
    try {
      backupOmpSession(file)
      backupOmpSession(file)
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
    assert.equal(links, 1)
    assert.equal(renames, 1)
    assert.equal(uuids.length, 0)
    assert.deepEqual(readdirSync(directory).sort(), [...older.slice(-2), ...occupied, published].sort())
    for (const name of occupied) assert.deepEqual(readFileSync(path.join(directory, name)), userContent)
    assert.deepEqual(readFileSync(path.join(directory, published)), content)
    assert.deepEqual(readFileSync(file), content)
  })
}

test("unique renamed snapshots are included in per-session retention", t => {
  const { backups } = fixture(t)
  const file = makeSessionFile(ompSessionsRoot())
  const names: string[] = []
  let directory = ""
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" })
  })
  syncBuiltinESMExports()
  try {
    for (const version of [1, 2, 3, 4, 5]) {
      const content = Buffer.from(`{"type":"session","id":"shared","version":${version}}\r\n`)
      writeFileSync(file, content)
      directory = snapshotDirectory(backups, file)
      backupOmpSession(file)
      const prefix = `snapshot-${snapshotName(content).slice(0, -6)}-`
      const name = readdirSync(directory).find(entry => entry.startsWith(prefix))
      assert.ok(name)
      names.push(name)
      assert.deepEqual(readFileSync(path.join(directory, name)), content)
      utimesSync(path.join(directory, name), version * 100, version * 100)
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual(readdirSync(directory).sort(), names.slice(-3).sort())
})

test("failed fallback rename preserves earlier snapshots and removes only its own temporary file", t => {
  const { backups } = fixture(t)
  const file = makeSessionFile(ompSessionsRoot())
  const content = Buffer.from('{"type":"session","id":"shared","version":5}\r\n')
  writeFileSync(file, content)
  const directory = snapshotDirectory(backups, file)
  const older = seedOlderSnapshots(directory)
  const unrelated = ".backup-user.tmp"
  writeFileSync(path.join(directory, unrelated), "user data")
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" })
  })
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    assert.equal(path.dirname(String(source)), directory)
    assert.equal(path.dirname(String(destination)), directory)
    assert.equal(fs.existsSync(destination), false)
    assert.deepEqual(readFileSync(source), content)
    throw Object.assign(new Error("rename failed"), { code: "EIO" })
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => backupOmpSession(file), { code: "EIO" })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual(readdirSync(directory).sort(), [...older, unrelated].sort())
  assert.equal(readFileSync(path.join(directory, unrelated), "utf8"), "user data")
  assert.deepEqual(readFileSync(file), content)
})
