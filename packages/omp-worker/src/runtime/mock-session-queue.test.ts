import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { MockPiSession } from "./mock-session.ts"

const roots: string[] = []
afterEach(() => {
  const previous = process.env.OMPIUI_MOCK_DIR
  if (previous === undefined) delete process.env.OMPIUI_MOCK_DIR
  else process.env.OMPIUI_MOCK_DIR = previous
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("MockPiSession sendUserMessage queue", () => {
  it("queues a follow-up when the session is already streaming", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-mock-queue-"))
    roots.push(root)
    process.env.OMPIUI_MOCK_DIR = root
    const session = await MockPiSession.open(root)
    const events: string[] = []
    session.onPiEvent(event => {
      if (typeof event.type === "string") events.push(event.type)
    })

    await session.prompt("first")
    await session.sendUserMessage("queued while busy")

    const state = session.getState()
    const queue = state.queue as { followUp?: string[] }
    assert.deepEqual(queue.followUp, ["queued while busy"])
    assert.ok(events.includes("queue_update"))
    await session.abort()
  })

  it("starts an idle message even when the caller selected follow-up delivery", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-mock-idle-"))
    roots.push(root)
    process.env.OMPIUI_MOCK_DIR = root
    const session = await MockPiSession.open(root)

    await session.sendUserMessage("idle follow-up", undefined, "followUp")
    await session.waitForIdle()

    const state = session.getState()
    const queue = state.queue as { followUp?: string[] }
    assert.deepEqual(queue.followUp, [])
    assert.ok(Number(state.messageCount) >= 2)
  })

  it("clears queued messages and publishes an empty queue snapshot", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-mock-clear-"))
    roots.push(root)
    process.env.OMPIUI_MOCK_DIR = root
    const session = await MockPiSession.open(root)
    const events: Array<{ type?: string; followUp?: string[] }> = []
    session.onPiEvent(event => events.push(event as { type?: string; followUp?: string[] }))

    await session.prompt("first")
    await session.sendUserMessage("one")
    await session.sendUserMessage("two")
    const cleared = await session.clearQueue() as { followUp?: string[] }

    assert.deepEqual(cleared.followUp, ["one", "two"])
    assert.deepEqual((session.getState().queue as { followUp?: string[] }).followUp, [])
    assert.deepEqual(events.at(-1), { type: "queue_update", steering: [], followUp: [] })
    await session.abort()
  })
})
