import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { it } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { MockPiSession } from "./mock-session.ts"

it("MockPiSession goal pause stops the active turn and clears its queue", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-mock-goal-"))
  const previous = process.env.OMPIUI_MOCK_DIR
  process.env.OMPIUI_MOCK_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.OMPIUI_MOCK_DIR
    else process.env.OMPIUI_MOCK_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  const session = await MockPiSession.open(root)
  t.after(() => session.abort())
  await session.prompt("first")
  await session.manageGoal({ op: "set", objective: "Finish the task" })
  await session.sendUserMessage("must not restart")
  const events: JsonObject[] = []
  session.onPiEvent(event => events.push(event))

  await session.manageGoal({ op: "pause" })
  const paused = session.getState()
  assert.equal((paused.goal as JsonObject).status, "paused")
  assert.equal(paused.isStreaming, false)
  assert.deepEqual((paused.queue as JsonObject).followUp, [])
  assert.ok(events.some(event => event.type === "agent_end"))

  await session.manageGoal({ op: "resume" })
  assert.equal((session.getState().goal as JsonObject).status, "active")
  await session.sendUserMessage("new turn")
  assert.equal(session.getState().isStreaming, true)
})
