import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { authTokenPath, ompiuiDataDir, resolveAuthToken } from "./auth-token.ts"

describe("local auth token", () => {
  const dirs: string[] = []
  const previousDataDir = process.env.OMPIUI_DATA_DIR
  const previousToken = process.env.OMPIUI_AUTH_TOKEN
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.OMPIUI_DATA_DIR
    else process.env.OMPIUI_DATA_DIR = previousDataDir
    if (previousToken === undefined) delete process.env.OMPIUI_AUTH_TOKEN
    else process.env.OMPIUI_AUTH_TOKEN = previousToken
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
  })

  function useTempDataDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ompiui-auth-"))
    dirs.push(dir)
    process.env.OMPIUI_DATA_DIR = path.join(dir, "state")
    delete process.env.OMPIUI_AUTH_TOKEN
    return dir
  }

  /** 伪造用户主目录：os.homedir() 在 Windows 读 USERPROFILE，POSIX 读 HOME */
  function useTempHome(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ompiui-home-"))
    dirs.push(dir)
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    delete process.env.OMPIUI_DATA_DIR
    delete process.env.OMPIUI_AUTH_TOKEN
    return dir
  }

  it("generates a token once and reuses it across restarts", () => {
    useTempDataDir()
    const first = resolveAuthToken()
    assert.ok(first.length >= 32, "token must have enough entropy to resist guessing")

    // A restart must not invalidate clients that already read the token.
    assert.equal(resolveAuthToken(), first)
    assert.equal(readFileSync(authTokenPath(), "utf8").trim(), first)
  })

  it("keeps the token file unreadable to other users", () => {
    useTempDataDir()
    resolveAuthToken()
    if (process.platform === "win32") return // POSIX modes are not enforced here
    assert.equal(statSync(authTokenPath()).mode & 0o777, 0o600)
    assert.equal(statSync(ompiuiDataDir()).mode & 0o777, 0o700)
  })

  it("prefers an explicitly configured token", () => {
    useTempDataDir()
    process.env.OMPIUI_AUTH_TOKEN = "  configured-token  "
    assert.equal(resolveAuthToken(), "configured-token")
  })

  it("adopts a token written by another server that started first", () => {
    const dir = useTempDataDir()
    const file = path.join(dir, "state", "auth-token")
    resolveAuthToken() // creates the directory
    writeFileSync(file, "peer-token\n", "utf8")
    assert.equal(resolveAuthToken(), "peer-token")
  })

  it("regenerates when the stored token is empty", () => {
    useTempDataDir()
    const first = resolveAuthToken()
    writeFileSync(authTokenPath(), "   \n", "utf8")
    const second = resolveAuthToken()
    assert.notEqual(second, "")
    assert.notEqual(second, first)
  })

  it("migrates a PiUI-era token from ~/.piui once and leaves the legacy file alone", () => {
    const home = useTempHome()
    mkdirSync(path.join(home, ".piui"), { recursive: true })
    writeFileSync(path.join(home, ".piui", "auth-token"), "legacy-token\n", "utf8")

    // Old clients keep working: the migrated token value is stable.
    assert.equal(resolveAuthToken(), "legacy-token")
    // Copied into the new location so later reads skip the legacy lookup.
    assert.equal(readFileSync(path.join(home, ".ompiui", "auth-token"), "utf8").trim(), "legacy-token")
    assert.equal(resolveAuthToken(), "legacy-token")
    // Read-only migration: the legacy directory is never rewritten.
    assert.equal(readFileSync(path.join(home, ".piui", "auth-token"), "utf8"), "legacy-token\n")
  })

  it("does not inherit ~/.piui when OMPIUI_DATA_DIR is set explicitly", () => {
    const home = useTempHome()
    mkdirSync(path.join(home, ".piui"), { recursive: true })
    writeFileSync(path.join(home, ".piui", "auth-token"), "decoy-token\n", "utf8")
    // 显式覆盖目录没有可继承的旧状态：同名旧文件存在也不采纳。
    process.env.OMPIUI_DATA_DIR = path.join(home, "state")
    const token = resolveAuthToken()
    assert.notEqual(token, "decoy-token")
    assert.equal(readFileSync(path.join(home, "state", "auth-token"), "utf8").trim(), token)
  })
})
