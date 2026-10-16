import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import fsPromises from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it, type TestContext } from "node:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import type { FileTextSearchResponse } from "@ompiui/protocol"
import { searchFilesByName, searchWorkspaceText } from "./file-search.ts"
import type { WorkspaceRecord } from "./workspace-store.ts"

describe("searchFilesByName", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-search-"))
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src", "hello.ts"), "export {}\n")
  writeFileSync(path.join(root, "src", "message.ts"), "const first = 'PiUI'\nconst second = 'piui client'\n")
  writeFileSync(path.join(root, "src", "unicode.txt"), "你好 PiUI\n")
  writeFileSync(path.join(root, "src", "casefold.txt"), "İX\n")
  writeFileSync(path.join(root, "src", "binary.dat"), Buffer.from([0, 80, 105, 85, 73]))
  writeFileSync(path.join(root, "README.md"), "# x\n")
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true })
  writeFileSync(path.join(root, "node_modules", "pkg", "hello.ts"), "skip\n")

  const ws: WorkspaceRecord = {
    displayName: "t",
    canonicalRoot: root,
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  }

  after(() => rmSync(root, { recursive: true, force: true }))

  it("finds by name and skips node_modules", async () => {
    const { paths: hits, stats } = await searchFilesByName(ws, "hello")
    assert.ok(hits.some(p => p.includes("src/hello.ts")))
    assert.ok(!hits.some(p => p.includes("node_modules")))
    assert.equal(stats.truncated, false)
  })

  it("normalizes whitespace before admission and never echoes an unbounded raw query", async () => {
    const result = await searchFilesByName(ws, `${" ".repeat(64 * 1024)}hello  `)
    assert.equal(result.query, "hello")
    assert.ok(result.paths.includes("src/hello.ts"))
    await assert.rejects(searchFilesByName(ws, "x".repeat(64 * 1024 + 1)))
  })

  it("finds text with line metadata and skips binary files", async () => {
    const { matches: hits, stats } = await searchWorkspaceText(ws, "piui")

    assert.ok(hits.some(hit => hit.path.text === "src/message.ts" && hit.line_number === 1))
    assert.ok(hits.some(hit => hit.path.text === "src/message.ts" && hit.line_number === 2))
    const unicodeHit = hits.find(hit => hit.path.text === "src/unicode.txt")
    assert.equal(unicodeHit?.submatches[0]?.start, 7)
    assert.equal(unicodeHit?.submatches[0]?.end, 11)
    assert.ok(!hits.some(hit => hit.path.text.includes("binary.dat")))
    assert.ok(!hits.some(hit => hit.path.text.includes("node_modules")))
    assert.ok(stats.scannedFiles >= 1)

    const casefold = await searchWorkspaceText(ws, "x")
    const casefoldHit = casefold.matches.find(hit => hit.path.text === "src/casefold.txt")
    assert.equal(casefoldHit?.submatches[0]?.start, 2)
    assert.equal(casefoldHit?.submatches[0]?.end, 3)
    assert.equal(casefoldHit?.submatches[0]?.match.text, "X")
  })

  it("reports result truncation", async () => {
    const limited = await searchFilesByName(ws, "src", { limit: 1 })
    assert.equal(limited.paths.length, 1)
    assert.equal(limited.stats.truncated, true)
    assert.equal(limited.stats.limitReason, "results")
  })
})

it("search cancellation preserves shared consumers and releases abandoned IO and queue slots", { timeout: 10_000 }, async t => {
  await withSearchFixture({
    "0.txt": "needle replacement\n",
    "1.txt": "needle replacement\n",
    "2.txt": "needle replacement\n",
    "3.txt": "needle replacement\n",
  }, async ws => {
    const io = observeSearchIO(t, ws.canonicalRoot)
    const searches: Promise<FileTextSearchResponse>[] = []
    const start = (pattern: string, controller?: AbortController) => {
      const pending = searchWorkspaceText(ws, pattern, { signal: controller?.signal })
      pending.catch(() => {})
      searches.push(pending)
      return pending
    }
    try {
      const preCancelled = new AbortController()
      preCancelled.abort()
      await assert.rejects(searchFilesByName(ws, "needle", { signal: preCancelled.signal }), { code: "REQUEST_ABORTED" })
      await assert.rejects(start("needle", preCancelled), { code: "REQUEST_ABORTED" })
      await io.idle()
      assert.equal(io.records.length, 0)

      const onlyGate = io.holdRead()
      const onlyController = new AbortController()
      const only = start("missing", onlyController)
      await onlyGate.ready
      onlyController.abort()
      await assert.rejects(only, { code: "REQUEST_ABORTED" })
      onlyGate.release()
      await io.idle()
      const records = io.records as Array<{ method: string; file: string }>
      assert.deepEqual(records.filter(record => record.method === "readFile").map(record => record.file), [path.join(ws.canonicalRoot, "0.txt")])

      const sharedGate = io.holdRead()
      const sharedController = new AbortController()
      const cancelled = start("needle", sharedController)
      const survivor = start("needle")
      await sharedGate.ready
      sharedController.abort()
      await assert.rejects(cancelled, { code: "REQUEST_ABORTED" })
      sharedGate.release()
      assert.deepEqual((await survivor).matches.map(match => match.path.text), ["0.txt", "1.txt", "2.txt", "3.txt"])
      assert.equal((io.records as Array<{ method: string }>).filter(record => record.method === "readFile").length, 5)

      const oldGate = io.holdRead()
      const replacementGate = io.holdRead()
      const oldController = new AbortController()
      const old = start("needle", oldController)
      await oldGate.ready
      oldController.abort()
      await assert.rejects(old, { code: "REQUEST_ABORTED" })
      const replacement = start("needle")
      await replacementGate.ready
      oldGate.release()
      await nextTurn()
      await nextTurn()
      const follower = start("needle")
      replacementGate.release()
      const [freshResult, joinedResult] = await Promise.all([replacement, follower])
      assert.deepEqual(joinedResult.matches, freshResult.matches)
      assert.deepEqual(freshResult.matches.map(match => match.path.text), ["0.txt", "1.txt", "2.txt", "3.txt"])
      assert.equal((io.records as Array<{ method: string }>).filter(record => record.method === "readFile").length, 10)

      const activeGates = Array.from({ length: 4 }, () => io.holdRead())
      const active = Array.from({ length: 4 }, (_, index) => {
        const controller = new AbortController()
        return { controller, pending: start(`active-${index}`, controller) }
      })
      await Promise.all(activeGates.map(gate => gate.ready))
      const waiting = Array.from({ length: 128 }, (_, index) => {
        const controller = new AbortController()
        return { controller, pending: start(`waiting-${index}`, controller) }
      })
      await assert.rejects(start("overflow"), { code: "RATE_LIMITED" })
      waiting[0]!.controller.abort()
      await assert.rejects(waiting[0]!.pending, { code: "REQUEST_ABORTED" })
      const latest = start("replacement")
      await nextTurn()
      for (const request of [...waiting.slice(1), ...active]) request.controller.abort()
      for (const gate of activeGates) gate.release()
      await Promise.all([...waiting.slice(1), ...active].map(request => assert.rejects(request.pending, { code: "REQUEST_ABORTED" })))
      assert.deepEqual((await latest).matches.map(match => match.path.text), ["0.txt", "1.txt", "2.txt", "3.txt"])
      await io.idle()
      assert.equal((io.records as Array<{ method: string }>).filter(record => record.method === "readFile").length, 18)
    } finally {
      await io.close()
      await Promise.allSettled(searches)
    }
  })
})

it("text search caps the complete JSON envelope before adding dense or escaped matches", async () => {
  const ascii = "x".repeat(40)
  const escaped = '"\\雪\u{1f600}\tX'
  for (const fixture of [
    { pattern: ascii, line: ascii.repeat(199), count: 100 },
    { pattern: escaped, line: `π ${escaped.repeat(199)}\\end`, count: 200 },
  ]) {
    await withSearchFixture({ "引用.txt": `${fixture.line}\r\n`.repeat(fixture.count) }, async ws => {
      const result = await searchWorkspaceText(ws, fixture.pattern, { limit: fixture.count })
      assert.ok(Buffer.byteLength(JSON.stringify({ data: result })) <= 2 * 1024 * 1024)
      assert.equal(result.stats.truncated, true)
      assert.equal(result.stats.limitReason, "bytes")
      assert.ok(result.matches.length < fixture.count)
      assert.equal(result.matches[0]?.lines.text, fixture.line)
      assert.equal(result.matches[0]?.submatches.length, 199)
      assert.equal(result.matches[1]?.absolute_offset, Buffer.byteLength(`${fixture.line}\r\n`))
      const prefixBytes = Buffer.byteLength(fixture.line.slice(0, fixture.line.indexOf(fixture.pattern)))
      assert.equal(result.matches[0]?.submatches[0]?.start, prefixBytes)
      assert.equal(result.matches[0]?.submatches[0]?.end, prefixBytes + Buffer.byteLength(fixture.pattern))
    })
  }

  const query = "\v".repeat(65536 - ascii.length) + ascii
  await withSearchFixture({ "dense.txt": `${ascii.repeat(199)}\n`.repeat(100) }, async ws => {
    const result = await searchWorkspaceText(ws, query, { limit: 100 })
    assert.equal(result.query, query)
    assert.equal(result.stats.limitReason, "bytes")
    assert.equal(result.matches[0]?.lines.text, ascii.repeat(199))
    assert.ok(Buffer.byteLength(JSON.stringify({ data: result })) <= 2 * 1024 * 1024)
    await assert.rejects(searchWorkspaceText(ws, ` ${query}`), { code: "INVALID_REQUEST" })
  })
})

it("text search retains complete small matches and UTF-8 offsets across CRLF", async () => {
  const pattern = '"\\雪\u{1f600}\tX'
  const line = `前\u{1f600}\t${pattern.repeat(3)}尾`
  await withSearchFixture({ "unicode.txt": `prefix\n${line}\r\nagain ${pattern}\n` }, async ws => {
    const result = await searchWorkspaceText(ws, pattern)
    assert.equal(result.stats.truncated, false)
    assert.equal(result.matches.length, 2)
    assert.equal(result.matches[0]?.lines.text, line)
    assert.equal(result.matches[0]?.line_number, 2)
    assert.equal(result.matches[0]?.absolute_offset, Buffer.byteLength("prefix\n"))
    assert.equal(result.matches[0]?.submatches.length, 3)
    assert.equal(result.matches[0]?.submatches[0]?.start, Buffer.byteLength("前\u{1f600}\t"))
    assert.equal(result.matches[0]?.submatches[0]?.end, Buffer.byteLength(`前\u{1f600}\t${pattern}`))
    assert.equal(result.matches[1]?.lines.text, `again ${pattern}`)
    assert.equal(result.matches[1]?.absolute_offset, Buffer.byteLength(`prefix\n${line}\r\n`))
  })
})

async function withSearchFixture(files: Record<string, string>, run: (ws: WorkspaceRecord) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-search-regression-"))
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content)
    await run({ displayName: "fixture", canonicalRoot: root, createdAt: "", lastOpenedAt: "" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

type SearchReadGate = {
  ready: Promise<void>
  blocked: Promise<void>
  enter: () => void
  release: () => void
}

function observeSearchIO(t: TestContext, root: string) {
  const records: Array<{ method: "readFile" | "readdir" | "stat"; file: string }> = []
  const gates: SearchReadGate[] = []
  const allGates: SearchReadGate[] = []
  let pending = 0
  const track = async <T>(method: "readFile" | "readdir" | "stat", target: unknown, operation: () => Promise<T>): Promise<T> => {
    const file = String(target)
    if (file !== root && !file.startsWith(root + path.sep)) return operation()
    records.push({ method, file })
    const gate = method === "readFile" ? gates.shift() : undefined
    pending++
    try {
      const value = await operation()
      if (gate) {
        gate.enter()
        await gate.blocked
      }
      return value
    } finally {
      pending--
    }
  }
  const originalReadFile = fsPromises.readFile
  const originalReaddir = fsPromises.readdir
  const originalStat = fsPromises.stat
  const spies = [
    t.mock.method(fsPromises, "readFile", ((...args: Parameters<typeof originalReadFile>) =>
      track("readFile", args[0], () => originalReadFile(...args))) as typeof originalReadFile),
    t.mock.method(fsPromises, "readdir", ((...args: Parameters<typeof originalReaddir>) =>
      track("readdir", args[0], () => originalReaddir(...args))) as typeof originalReaddir),
    t.mock.method(fsPromises, "stat", ((...args: Parameters<typeof originalStat>) =>
      track("stat", args[0], () => originalStat(...args))) as typeof originalStat),
  ]
  syncBuiltinESMExports()
  const idle = async () => {
    const deadline = Date.now() + 5000
    do {
      await nextTurn()
      if (Date.now() > deadline) throw new Error("fixture search IO did not settle")
    } while (pending > 0)
    await nextTurn()
  }
  return {
    records,
    idle,
    holdRead() {
      let enter!: () => void
      let release!: () => void
      const ready = new Promise<void>((resolve, reject) => {
        const abort = () => reject(t.signal.reason)
        enter = () => {
          t.signal.removeEventListener("abort", abort)
          resolve()
        }
        t.signal.addEventListener("abort", abort, { once: true })
        if (t.signal.aborted) abort()
      })
      ready.catch(() => {})
      const blocked = new Promise<void>(resolve => { release = resolve })
      const gate = { ready, blocked, enter, release }
      gates.push(gate)
      allGates.push(gate)
      return { ready, release }
    },
    async close() {
      for (const gate of allGates) {
        gate.enter()
        gate.release()
      }
      try {
        await idle()
      } finally {
        for (const spy of spies) spy.mock.restore()
        syncBuiltinESMExports()
      }
    },
  }
}
