import assert from "node:assert/strict"
import test from "node:test"
import { RpcLineReader } from "./rpc-line-reader.js"

test("RPC flood yields between ordered batches and keeps split JSONL lines intact", async () => {
  const lines: string[] = []
  let pauses = 0
  let resumes = 0
  const reader = new RpcLineReader(line => lines.push(line), () => pauses++, () => resumes++, 2)
  reader.push("first\nsecond\nthird\nfou")
  assert.deepEqual(lines, ["first", "second"])
  assert.equal(pauses, 1)
  reader.push("rth\nfifth\n")
  await new Promise<void>(resolve => reader.finish(resolve))
  assert.deepEqual(lines, ["first", "second", "third", "fourth", "fifth"])
  assert.ok(resumes > 0)
  reader.close()
})

test("IPC backpressure suspends parsing and resumes without losing results", async () => {
  const lines: string[] = []
  const reader = new RpcLineReader(line => {
    lines.push(line)
    if (line === "pause") reader.setPaused(true)
  }, () => {}, () => {})
  reader.push("pause\nfinal result\n")
  assert.deepEqual(lines, ["pause"])
  reader.setPaused(false)
  await new Promise<void>(resolve => reader.finish(resolve))
  assert.deepEqual(lines, ["pause", "final result"])
  reader.close()
})
