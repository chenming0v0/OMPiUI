import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import type { ImageInput, JsonObject } from "@ompiui/protocol"
import { MockPiSession } from "./mock-session.ts"

const previous = process.env.OMPIUI_MOCK_DIR
const roots: string[] = []
afterEach(() => {
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
    assert.deepEqual(events.at(-1), { type: "queue_update", steering: [], followUp: [], steeringEntries: [], followUpEntries: [] })
    await session.abort()
  })
})

type QueueEntry = { text: string; images?: ImageInput[] }
type QueueSnapshot = {
  steering: string[]
  followUp: string[]
  steeringEntries: QueueEntry[]
  followUpEntries: QueueEntry[]
}
const image = (data: string): ImageInput => ({ type: "image", data, mimeType: "image/png" })
const emptyQueue: QueueSnapshot = { steering: [], followUp: [], steeringEntries: [], followUpEntries: [] }

describe("MockPiSession image-bearing queue", () => {
  it("retains duplicate and image-only entries through mode changes, snapshots, clear and replay", async t => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-mock-images-"))
    roots.push(root)
    process.env.OMPIUI_MOCK_DIR = root
    const session = await MockPiSession.open(root)
    t.after(() => session.abort())
    const events: JsonObject[] = []
    session.onPiEvent(event => { if (event.type === "queue_update") events.push(event) })
    await session.prompt("first")
    const inputs = [image("AAEC+/==")]
    await session.sendUserMessage("duplicate", inputs, "steer")
    inputs[0]!.data = "caller mutation"
    inputs.push(image("extra"))
    const firstEvent = events[0] as QueueSnapshot
    firstEvent.steeringEntries[0]!.images![0]!.mimeType = "event mutation"
    firstEvent.steering.push("event-only")
    await session.prompt("duplicate", [image("AgM=")], { streamingBehavior: "steer" })
    await session.sendUserMessage("", [image("BAU=")], "steer")
    await session.sendUserMessage("duplicate", [image("Bgc=")])
    await session.followUp("duplicate")
    await session.prompt("", [image("CAk=")], { streamingBehavior: "followUp" })
    const expected: QueueSnapshot = {
      steering: ["duplicate", "duplicate", ""], followUp: ["duplicate", "duplicate", ""],
      steeringEntries: [
        { text: "duplicate", images: [image("AAEC+/==")] },
        { text: "duplicate", images: [image("AgM=")] },
        { text: "", images: [image("BAU=")] },
      ],
      followUpEntries: [
        { text: "duplicate", images: [image("Bgc=")] },
        { text: "duplicate" },
        { text: "", images: [image("CAk=")] },
      ],
    }
    assert.deepEqual(events.at(-1), { type: "queue_update", ...expected })
    await session.setSteeringMode("one-at-a-time")
    await session.setFollowUpMode("all")
    const snapshot = session.getState().queue as QueueSnapshot
    assert.deepEqual(snapshot, { ...expected, steeringMode: "one-at-a-time", followUpMode: "all" })
    snapshot.steeringEntries[0]!.images![0]!.data = "snapshot mutation"
    snapshot.followUpEntries.splice(0)
    snapshot.followUp.splice(0)
    const cleared = await session.clearQueue() as QueueSnapshot
    assert.deepEqual(cleared, expected)
    assert.deepEqual(events.at(-1), { type: "queue_update", ...emptyQueue })
    assert.deepEqual(session.getState().queue, { ...emptyQueue, steeringMode: "one-at-a-time", followUpMode: "all" })
    await session.sendUserMessage(cleared.steeringEntries[1]!.text, cleared.steeringEntries[1]!.images, "followUp")
    cleared.steeringEntries[1]!.images![0]!.data = "clear-result mutation"
    assert.deepEqual(await session.clearQueue(), {
      ...emptyQueue, followUp: ["duplicate"], followUpEntries: [{ text: "duplicate", images: [image("AgM=")] }],
    })
  })

  it("persists image-only queued turns and publishes each drained queue with remaining attachments", async t => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-mock-drain-images-"))
    roots.push(root)
    process.env.OMPIUI_MOCK_DIR = root
    const session = await MockPiSession.open(root)
    t.after(() => session.abort())
    const events: JsonObject[] = []
    session.onPiEvent(event => { if (event.type === "queue_update") events.push(event) })
    await session.sendUserMessage("first", [image("AAEC+/==")])
    await session.sendUserMessage("", [image("AgM=")], "steer")
    await session.sendUserMessage("", [image("BAU=")], "steer")
    await session.sendUserMessage("", [image("Bgc=")], "followUp")
    events.length = 0
    await session.waitForIdle()
    const entries = session.getEntriesPage(undefined, 100, 1024 * 1024).items
    const users = entries.map(entry => entry.message as JsonObject).filter(message => message?.role === "user")
    assert.deepEqual(users.map(message => message.content), [
      [{ type: "text", text: "first" }, image("AAEC+/==")],
      [{ type: "text", text: "" }, image("AgM=")],
      [{ type: "text", text: "" }, image("BAU=")],
      [{ type: "text", text: "" }, image("Bgc=")],
    ])
    assert.deepEqual(events, [
      { type: "queue_update", steering: [""], followUp: [""], steeringEntries: [{ text: "", images: [image("BAU=")] }], followUpEntries: [{ text: "", images: [image("Bgc=")] }] },
      { type: "queue_update", ...emptyQueue, followUp: [""], followUpEntries: [{ text: "", images: [image("Bgc=")] }] },
      { type: "queue_update", ...emptyQueue },
    ])
  })
})
