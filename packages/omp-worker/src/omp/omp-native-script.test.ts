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
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }))
  writeFileSync(path.join(root, "src", "config", "settings.ts"), "export {}\n")
  return { directory, root }
}

test("native source resolver follows selected CLI instead of ambient installations", t => {
  const f = fixture(t)
  const cli = path.join(f.root, "selected.exe")
  writeFileSync(cli, "not executed by source resolution")
  assert.equal(resolveOmpPackageRoot(cli, { ...process.env, OMPI_OMP_PACKAGE_ROOT: undefined }), realpathSync(f.root))
  const unknown = path.join(f.directory, "unknown.exe")
  writeFileSync(unknown, "not executed by source resolution")
  assert.throws(() => resolveOmpPackageRoot(unknown, { ...process.env, OMPI_OMP_PACKAGE_ROOT: undefined }), /Cannot locate official OMP/)
})

test("explicit package root uses supplied environment and rejects incompatible directories", t => {
  const f = fixture(t)
  assert.equal(resolveOmpPackageRoot("unavailable-command", { OMPI_OMP_PACKAGE_ROOT: f.root }), realpathSync(f.root))
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "unrelated-package" }))
  assert.throws(() => resolveOmpPackageRoot(undefined, { OMPI_OMP_PACKAGE_ROOT: f.root }), /Cannot locate official OMP/)
})
