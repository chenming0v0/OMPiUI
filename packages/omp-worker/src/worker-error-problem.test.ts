import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { workerProblemFromError } from "./worker-error-problem.js"

const withCode = (message: string, code: unknown): unknown => Object.assign(new Error(message), { code })

describe("workerProblemFromError", () => {
  it("keeps protocol codes untouched", () => {
    assert.deepEqual(workerProblemFromError(withCode("runtime replaced", "RUNTIME_REPLACED")), {
      code: "RUNTIME_REPLACED",
      message: "runtime replaced",
    })
  })

  it("translates omp/worker native codes instead of flattening them to INTERNAL", () => {
    assert.equal(workerProblemFromError(withCode("timed out", "OMP_TIMEOUT")).code, "WORKER_RESULT_UNKNOWN")
    assert.equal(workerProblemFromError(withCode("exited", "OMP_EXITED")).code, "SESSION_RUNTIME_CRASHED")
    assert.equal(workerProblemFromError(withCode("stdin", "OMP_STDIN_ERROR")).code, "SESSION_RUNTIME_CRASHED")
    assert.equal(workerProblemFromError(withCode("replaced", "SESSION_REPLACED")).code, "SESSION_CONFLICT")
    assert.equal(workerProblemFromError(withCode("not admitted", "SUBMISSION_NOT_ADMITTED")).code, "SESSION_BUSY")
    assert.equal(workerProblemFromError(withCode("missing", "OMP_SOURCE_MISSING")).code, "CAPABILITY_DISABLED")
  })

  it("keeps the real message and the original code for unknown native codes", () => {
    const problem = workerProblemFromError(withCode("Session replaced while waiting for native admission", "SESSION_REPLACED"))
    assert.match(problem.message, /Session replaced while waiting for native admission/)
    assert.match(problem.message, /SESSION_REPLACED/)
    assert.deepEqual(problem.details, { nativeCode: "SESSION_REPLACED" })
    const unknown = workerProblemFromError(withCode("boom", "SOMETHING_NEW"))
    assert.equal(unknown.code, "INTERNAL")
    assert.match(unknown.message, /boom \(SOMETHING_NEW\)/)
  })

  it("handles non-error throws", () => {
    assert.deepEqual(workerProblemFromError("plain failure"), { code: "INTERNAL", message: "plain failure" })
  })
})
