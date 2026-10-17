import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it, type TestContext } from "node:test"
import { MIN_OMP_VERSION, compareOmpVersions, detectOmpVersion, detectOmpVersionSync, isOmpVersionSupported, parseOmpVersion } from "./omp-version.js"

/** 标准 npm shim 位于带空格的目录（CI 的 `omp npm config`），入口必须按 argv 直接拉起。 */
function versionShim(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui version space-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const binDir = path.join(root, "npm config")
  mkdirSync(binDir, { recursive: true })
  const cli = path.join(root, "pkg", "dist", "cli.js")
  mkdirSync(path.dirname(cli), { recursive: true })
  writeFileSync(cli, 'if (process.argv.includes("--version")) {\n  console.log("omp 18.8.0 (fixture)")\n  process.exit(0)\n}\nprocess.exit(2)\n')
  copyFileSync(process.execPath, path.join(binDir, "node.exe"))
  const shim = path.join(binDir, "omp.cmd")
  writeFileSync(shim, ['@ECHO off', '"%dp0%\\node.exe" "%dp0%\\..\\pkg\\dist\\cli.js" %*'].join("\r\n"))
  return shim
}

describe("omp-version", () => {
  it("parses semver out of --version output", () => {
    assert.equal(parseOmpVersion("18.4.4"), "18.4.4")
    assert.equal(parseOmpVersion("omp 18.4.4 (commit abc1234)"), "18.4.4")
    assert.equal(parseOmpVersion("v18.2.11-beta.1\nbuilt with bun"), "18.2.11-beta.1")
    assert.equal(parseOmpVersion("no version here"), null)
    assert.equal(parseOmpVersion(""), null)
  })

  it("compares versions numerically, ignoring prerelease suffixes", () => {
    assert.equal(compareOmpVersions("18.0.6", "18.2.11") < 0, true)
    assert.equal(compareOmpVersions("18.2.10", "18.2.11") < 0, true)
    assert.equal(compareOmpVersions("18.2.11", "18.2.11"), 0)
    assert.equal(compareOmpVersions("18.4.4", "18.2.11") > 0, true)
    assert.equal(compareOmpVersions("19.0.0", "18.99.99") > 0, true)
    assert.equal(compareOmpVersions("18.2.11-beta.1", "18.2.11"), 0)
  })

  it("enforces the documented minimum version", () => {
    assert.equal(MIN_OMP_VERSION, "18.2.11")
    assert.equal(isOmpVersionSupported("18.0.6"), false)
    assert.equal(isOmpVersionSupported("18.2.10"), false)
    assert.equal(isOmpVersionSupported("18.2.11"), true)
    assert.equal(isOmpVersionSupported("18.4.4"), true)
  })

  it("probes an npm shim under a directory with spaces", {
    skip: process.platform !== "win32",
    timeout: 30_000,
  }, async t => {
    // 两个 shim 分开：探测结果按 bin 缓存，同一个路径只能验证一条探测路径。
    const syncShim = versionShim(t)
    const asyncShim = versionShim(t)
    assert.equal(detectOmpVersionSync(syncShim), "18.8.0")
    assert.equal(await detectOmpVersion(asyncShim), "18.8.0")
  })
})
