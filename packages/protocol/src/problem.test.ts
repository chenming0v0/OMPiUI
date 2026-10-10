import assert from "node:assert/strict"
import test from "node:test"
import { isErrorCode, problemFromError } from "./problem.ts"

test("pairing failures retain their protocol error codes", () => {
  for (const code of ["PAIR_INVALID", "PAIR_USED", "PAIR_RATE_LIMITED"]) {
    assert.equal(isErrorCode(code), true)
    assert.equal(problemFromError(Object.assign(new Error("pairing failed"), { code })).code, code)
  }
})
