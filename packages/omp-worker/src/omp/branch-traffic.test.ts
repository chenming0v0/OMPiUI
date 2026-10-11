import assert from "node:assert/strict"
import { it } from "node:test"
import { validateParams, type EntriesPage, type JsonObject } from "@ompiui/protocol"
import { OmpRpcSession } from "./omp-session.js"
import { entriesPageFromEntries } from "../runtime/pagination.js"
import { COMMAND_HANDLERS, getCommandCapability, type CommandContext } from "../command-table.js"

it("measures repeated tool-output refreshes through the real OMP adapter without rewriting history", async () => {
  const session = Reflect.construct(OmpRpcSession, []) as OmpRpcSession
  const internal = session as unknown as { client: unknown; sessionId: string; syncEntriesNow(): Promise<void> }
  const entries: JsonObject[] = []
  const requests: JsonObject[] = []
  const context = { requireRuntime: () => session } as CommandContext
  internal.sessionId = "traffic-fixture"
  internal.client = {
    async request(command: JsonObject) {
      requests.push(command)
      assert.equal(command.type, "get_entries")
      const since = command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0
      return { type: "response", success: true, command: "get_entries", data: {
        entries: structuredClone(entries.slice(since)), leafId: entries.at(-1)?.id ?? null,
      } }
    },
  }
  const append = () => {
    const id = `entry-${entries.length}`
    entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-10-11T00:00:00Z",
      message: { role: "toolResult", toolCallId: `call-${id}`, toolName: "read", content: [{ type: "text", text: "输出".repeat(680) }] } })
  }
  for (let i = 0; i < 60; i++) append()
  let baselineBytes = 0
  let incrementalBytes = 0
  let syncCursor: string | undefined
  let knownIds: unknown[] = []
  const requestSizes: number[] = []
  for (let refresh = 0; refresh < 35; refresh++) {
    if (refresh > 0 && refresh % 2 === 1) append()
    await internal.syncEntriesNow()
    const head = session.getHead()
    const baseline = entriesPageFromEntries(head, entries, { limit: 100, maxBytes: 2 * 1024 * 1024 }, entry => entry)
    const sync = syncCursor ? { syncCursor, beforeId: "entry-0" } : undefined
    const params = { limit: 100, maxBytes: 2 * 1024 * 1024, ...sync }
    validateParams(getCommandCapability("branch.get")?.paramsSchema, params)
    const page = await COMMAND_HANDLERS["branch.get"]!(context, params) as EntriesPage
    const requestBytes = Buffer.byteLength(JSON.stringify(params))
    const responseBytes = Buffer.byteLength(JSON.stringify(page))
    baselineBytes += Buffer.byteLength(JSON.stringify(baseline)) + Buffer.byteLength(JSON.stringify({ limit: 100, maxBytes: 2 * 1024 * 1024 }))
    incrementalBytes += responseBytes + requestBytes
    requestSizes.push(responseBytes)
    knownIds = page.deltaFrom ? [...knownIds, ...page.items.map(entry => entry.id)] : page.items.map(entry => entry.id)
    assert.deepEqual(knownIds, entries.map(entry => entry.id))
    syncCursor = page.syncCursor
  }
  assert.ok(requests.slice(1).every(request => typeof request.since === "string"))
  assert.ok(incrementalBytes < baselineBytes * 0.1)
  assert.ok(requestSizes[2]! < 1024)
  console.log(JSON.stringify({ scenario: "60 initial tool outputs, 17 appends, 35 refreshes", baselineBytes, incrementalBytes,
    reductionPercent: Number((100 * (1 - incrementalBytes / baselineBytes)).toFixed(2)), finalEntries: knownIds.length }))
})
