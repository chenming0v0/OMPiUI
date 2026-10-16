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

test("oversized UTF-8 lines are discarded until a newline, then parsing resumes", () => {
  const lines: string[] = []
  const errors: string[] = []
  const reader = new RpcLineReader(line => lines.push(line), () => {}, () => {}, 64, message => errors.push(message))
  reader.push("文".repeat(360000))
  reader.push("discarded\nvalid\n")
  assert.deepEqual(lines, ["valid"])
  assert.equal(errors.length, 1)
  reader.close()
})

test("exit drain preserves batching and waits for IPC backpressure to clear", async () => {
  const lines: string[] = []
  const reader = new RpcLineReader(line => lines.push(line), () => {}, () => {}, 2)
  reader.setPaused(true)
  reader.push("first\nsecond\nthird\n")
  let finished = false
  reader.finish(() => { finished = true })
  assert.deepEqual(lines, [])
  assert.equal(finished, false)
  reader.setPaused(false)
  await new Promise<void>(resolve => {
    const poll = () => finished ? resolve() : setImmediate(poll)
    poll()
  })
  assert.deepEqual(lines, ["first", "second", "third"])
  reader.close()
})
