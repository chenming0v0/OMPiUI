import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { MIN_OMP_VERSION, compareOmpVersions, isOmpVersionSupported, parseOmpVersion } from "./omp-version.js"

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
})
