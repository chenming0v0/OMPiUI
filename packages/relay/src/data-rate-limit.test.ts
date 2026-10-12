import assert from "node:assert/strict"
import test from "node:test"
import { DataRateLimit } from "./data-rate-limit.ts"

test("relay data quota counts both bytes and zero-byte control frames, and refills", () => {
  let now = 0
  const rate = new DataRateLimit(100, 200, 2, 4, () => now)
  assert.equal(rate.allow(150), true)
  assert.equal(rate.allow(51), false)
  assert.equal(rate.allow(50), true)
  assert.equal(rate.allow(0), true)
  assert.equal(rate.allow(0), true)
  assert.equal(rate.allow(0), false)
  now = 1000
  assert.equal(rate.allow(100), true)
  assert.equal(rate.allow(1), false)
})
