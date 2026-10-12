import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { nativeOmpSessionDirectory } from "./omp-directories.js"

function fixture(t: TestContext, tempInsideHome = false) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "ompiui-directory-contract-")))
  const home = path.join(root, "home")
  const temp = tempInsideHome ? path.join(home, "AppData", "Local", "Temp") : path.join(root, "temp")
  const agent = path.join(root, "agent")
  mkdirSync(home)
  mkdirSync(temp, { recursive: true })
  const previous = { agent: process.env.OMP_AGENT_DIR, profile: process.env.OMP_PROFILE, piProfile: process.env.PI_PROFILE }
  process.env.OMP_AGENT_DIR = agent
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  t.mock.method(os, "homedir", () => home)
  t.mock.method(os, "tmpdir", () => temp)
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    for (const [key, value] of Object.entries({ OMP_AGENT_DIR: previous.agent, OMP_PROFILE: previous.profile, PI_PROFILE: previous.piProfile })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, home, temp, agent, sessions: path.join(agent, "sessions") }
}

test("home-relative session directories preserve spaces and Chinese names", t => {
  const f = fixture(t)
  const cwd = path.join(f.home, "项目 space", "repo")
  mkdirSync(cwd, { recursive: true })
  assert.equal(nativeOmpSessionDirectory(cwd), path.join(f.sessions, "-项目 space-repo"))
  assert.equal(nativeOmpSessionDirectory(f.home), path.join(f.sessions, "-"))
  assert.equal(existsSync(f.agent), false)
})

test("temporary workspaces outside home use the tmp prefix", t => {
  const f = fixture(t)
  const cwd = path.join(f.temp, "项目 space", "repo")
  mkdirSync(cwd, { recursive: true })
  assert.equal(nativeOmpSessionDirectory(cwd), path.join(f.sessions, "-tmp-项目 space-repo"))
  assert.equal(nativeOmpSessionDirectory(f.temp), path.join(f.sessions, "-tmp"))
})

test("OMP through 18.4.12 matches home before a nested system temporary directory", t => {
  const f = fixture(t, true)
  for (const version of ["18.3.1", "18.4.12"]) {
    assert.equal(nativeOmpSessionDirectory(path.join(f.temp, "project"), version), path.join(f.sessions, "-AppData-Local-Temp-project"))
  }
})

test("OMP from 18.5.0 matches a nested system temporary directory before home", t => {
  const f = fixture(t, true)
  for (const version of ["18.5.0", "18.8.9"]) {
    assert.equal(nativeOmpSessionDirectory(path.join(f.temp, "project"), version), path.join(f.sessions, "-tmp-project"))
    assert.equal(nativeOmpSessionDirectory(f.temp, version), path.join(f.sessions, "-tmp"))
    assert.equal(nativeOmpSessionDirectory(path.join(f.home, "repo"), version), path.join(f.sessions, "-repo"))
  }
})

test("workspaces outside home and temp use absolute path encoding", t => {
  const f = fixture(t)
  const cwd = path.join(f.root, "external", "项目 space")
  mkdirSync(cwd, { recursive: true })
  // 根目录前缀随操作系统变化；工作区片段和两端标记使用独立的预期值。
  const rootParts = realpathSync(f.root).split(path.sep).filter(Boolean).map(part => part.replace(":", "-"))
  const expected = `--${rootParts.join("-")}-external-项目 space--`
  assert.equal(nativeOmpSessionDirectory(cwd), path.join(f.sessions, expected))
  assert.equal(nativeOmpSessionDirectory(path.join(cwd, "missing")), path.join(f.sessions, expected.slice(0, -2) + "-missing--"))
})

test("a sibling whose name starts with home is not classified as home-relative", t => {
  const f = fixture(t)
  const cwd = path.join(f.root, "home-other", "repo")
  mkdirSync(cwd, { recursive: true })
  const result = path.basename(nativeOmpSessionDirectory(cwd))
  assert.ok(result.startsWith("--"))
  assert.ok(result.endsWith("-home-other-repo--"))
})

test("directory aliases are classified by their real target", t => {
  const f = fixture(t)
  const cwd = path.join(f.home, "项目 space")
  mkdirSync(cwd)
  const alias = path.join(f.temp, "alias")
  symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir")
  assert.equal(nativeOmpSessionDirectory(alias), path.join(f.sessions, "-项目 space"))
  assert.equal(nativeOmpSessionDirectory(alias), nativeOmpSessionDirectory(cwd))
})

test("Windows short cwd expansion follows the OMP version without changing temporary root spelling", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t)
  const short = `${path.parse(process.env.ProgramFiles || "C:\\Program Files").root}PROGRA~1`
  if (!existsSync(short)) return t.skip("Windows 8.3 aliases are disabled on this volume")
  const long = realpathSync.native(short)
  if (short.toLowerCase() === long.toLowerCase()) return t.skip("No expanded Windows path available")
  t.mock.method(os, "homedir", () => long)
  t.mock.method(os, "tmpdir", () => short)
  syncBuiltinESMExports()
  assert.equal(nativeOmpSessionDirectory(short, "18.3.5"), path.join(f.sessions, "-tmp"))
  for (const version of ["18.4.0", "18.10.0"]) {
    assert.equal(nativeOmpSessionDirectory(short, version), path.join(f.sessions, "-"))
  }
})
