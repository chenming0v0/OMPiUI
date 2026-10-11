import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runtimePolicyArgs } from "./runtime-policy.js"

test("the protected runtime permits one delegation level without lowering concurrency", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-runtime-policy-"))
  const previous = process.env.OMPIUI_DATA_DIR
  process.env.OMPIUI_DATA_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.OMPIUI_DATA_DIR
    else process.env.OMPIUI_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  const args = runtimePolicyArgs()
  assert.equal(args[0], "--config")
  assert.equal(args[1], path.join(root, "runtime-config", "runtime-policy.yml"))
  const contents = readFileSync(args[1]!, "utf8")
  assert.equal(contents, "autoResume: false\ntask:\n  maxRecursionDepth: 1\n")
  assert.equal(contents.includes("maxConcurrency"), false)
  writeFileSync(args[1]!, "task:\n  maxRecursionDepth: -1\n")
  assert.deepEqual(runtimePolicyArgs(), args)
  assert.equal(readFileSync(args[1]!, "utf8"), contents)
})
