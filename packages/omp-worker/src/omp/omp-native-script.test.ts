import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { resolveOmpPackageRoot } from "./omp-native-script.js"

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "ompiui-native-root-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, "selected package")
  mkdirSync(path.join(root, "src", "config"), { recursive: true })
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.3.1" }))
  writeFileSync(path.join(root, "src", "config", "settings.ts"), "export {}\n")
  const cli = path.join(root, "cli.mjs")
  writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("omp 18.3.1 (fixture)")\n')
  return { directory, root, cli }
}

test("native source resolver follows selected CLI instead of ambient installations", t => {
  const f = fixture(t)
  const env = { ...process.env, OMPI_OMP_RUNTIME_DIR: undefined, OMPI_OMP_PACKAGE_ROOT: undefined }
  assert.equal(resolveOmpPackageRoot(f.cli, env), realpathSync(f.root))
  const unknown = path.join(f.directory, "unknown.mjs")
  writeFileSync(unknown, '#!/usr/bin/env node\nconsole.log("omp 18.3.1 (fixture)")\n')
  assert.throws(() => resolveOmpPackageRoot(unknown, env), /Cannot locate official OMP 18\.3\.1/)
})

test("explicit package root uses supplied environment and rejects incompatible directories", t => {
  const f = fixture(t)
  const env = { ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root }
  assert.equal(resolveOmpPackageRoot(f.cli, env), realpathSync(f.root))
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "unrelated-package", version: "18.3.1" }))
  assert.throws(() => resolveOmpPackageRoot(f.cli, env), /Cannot locate official OMP/)
})

test("a standalone CLI cannot use different-version public sources", t => {
  const f = fixture(t)
  const env = { ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root }
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.8.0" }))
  assert.throws(() => resolveOmpPackageRoot(f.cli, env), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error)
    assert.equal(error.code, "OMP_SOURCE_VERSION_MISMATCH")
    assert.match(error.message, /selected CLI is 18\.3\.1/)
    return true
  })
})

test("an explicit source root does not bypass selected CLI version verification", t => {
  const f = fixture(t)
  assert.throws(() => resolveOmpPackageRoot(path.join(f.directory, "missing.exe"), {
    ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root,
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "OMP_VERSION_UNVERIFIED")
})
