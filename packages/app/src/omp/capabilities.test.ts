import { beforeEach, describe, expect, it } from "vitest"
import { getPiCapabilities } from "./capabilities"
import { piNativeStatusForTest } from "./nativeStatus"

describe("OMP capability registry", () => {
  beforeEach(() => piNativeStatusForTest(undefined))

  it("derives capabilities from registry commands natively", () => {
    piNativeStatusForTest({
      sessionCommands: [
        { name: "fork", scope: "session", source: "omp-rpc" },
        { name: "setSessionName", scope: "session", source: "omp-rpc" },
      ],
      globalCommands: [{ name: "session.delete", scope: "global", source: "omp-rpc" }],
    })

    const caps = getPiCapabilities()
    expect(caps.fork).toBe(true)
    expect(caps.sessionRename).toBe(true)
    expect(caps.sessionDelete).toBe(true)
    expect(caps.sessionTree).toBe(false)
    expect(caps.pty).toBe(false)
  })

  it("derives host capabilities (pty/file/git) from their backing commands", () => {
    piNativeStatusForTest({
      sessionCommands: [],
      globalCommands: [
        { name: "terminals.create", scope: "global", source: "ompiui-adapter" },
        { name: "files.write", scope: "global", source: "ompiui-adapter" },
        { name: "git.diff", scope: "global", source: "ompiui-adapter" },
      ],
    })

    const caps = getPiCapabilities()
    expect(caps.pty).toBe(true)
    expect(caps.fileWrite).toBe(true)
    expect(caps.gitDiff).toBe(true)
    // 没有 backing 命令的能力保持关闭
    expect(caps.share).toBe(false)
    expect(caps.mcp).toBe(false)
  })

  it("advertises cold configuration and initialization only when supported", () => {
    piNativeStatusForTest({ sessionCommands: [], globalCommands: [] })
    expect(getPiCapabilities().sessionControlsRead).toBe(false)
    expect(getPiCapabilities().sessionInitialize).toBe(false)

    piNativeStatusForTest({
      sessionCommands: [
        { name: "controls.get", scope: "session", source: "ompiui-adapter" },
        { name: "session.initialize", scope: "session", source: "ompiui-adapter" },
      ],
      globalCommands: [],
    })
    expect(getPiCapabilities().sessionControlsRead).toBe(true)
    expect(getPiCapabilities().sessionInitialize).toBe(true)
  })

  it("is unavailable without a registry", () => {
    expect(getPiCapabilities().fork).toBe(false)
    expect(getPiCapabilities().sessionDelete).toBe(false)
  })
})
