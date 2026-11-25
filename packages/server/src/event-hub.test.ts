import assert from "node:assert/strict"
import test from "node:test"
import { EventHub, eventWireFrame } from "./event-hub.ts"
import { terminalOwnerFromSecret } from "./host/terminal-auth.ts"

test("EventHub replays retained events and requires resync for stale cursors", () => {
  const hub = new EventHub(2)
  const stream = { kind: "session" as const, id: "one" }
  const initial = hub.getCursor(stream)
  hub.publish(stream, "pi.event", { seq: 1 })
  const afterOne = hub.getCursor(stream)
  hub.publish(stream, "pi.event", { seq: 2 })
  hub.publish(stream, "pi.event", { seq: 3 })

  const replay = hub.replaySince(stream, afterOne)
  assert.equal(replay.resyncRequired, false)
  assert.deepEqual(replay.events.map(event => (event.payload as { seq: number }).seq), [2, 3])
  assert.equal(hub.replaySince(stream, initial).reason, "history_expired")
  assert.equal(hub.replaySince(stream, { epoch: "old-server", sequence: 0 }).reason, "epoch_mismatch")
  assert.equal(hub.replaySince(stream).reason, "missing_cursor")
})

test("EventHub keeps sequence and history independent per stream", () => {
  const hub = new EventHub(2)
  const one = { kind: "session" as const, id: "one" }
  const two = { kind: "session" as const, id: "two" }
  const oneStart = hub.getCursor(one)
  const twoStart = hub.getCursor(two)

  hub.publish(one, "command.updated", { commandId: "one-1" })
  hub.publish(two, "command.updated", { commandId: "two-1" })
  hub.publish(one, "command.updated", { commandId: "one-2" })

  assert.equal(hub.getCursor(one).sequence, 2)
  assert.equal(hub.getCursor(two).sequence, 1)
  assert.deepEqual(
    hub.replaySince(two, twoStart).events.map(event => (event.payload as { commandId?: string }).commandId),
    ["two-1"],
  )

  hub.publish(one, "command.updated", { commandId: "one-3" })
  assert.equal(hub.replaySince(one, oneStart).reason, "history_expired")
  assert.equal(hub.replaySince(two, twoStart).resyncRequired, false)
})

test("EventHub resets only the selected stream", () => {
  const hub = new EventHub()
  const server = { kind: "server" as const, id: "server" }
  const session = { kind: "session" as const, id: "session-1" }

  hub.publish(server, "sessions.updated", { seq: 1 })
  hub.publish(session, "pi.event", { seq: 1 })
  const serverCursor = hub.getCursor(server)

  hub.resetEpoch(session)
  assert.equal(hub.getCursor(session).sequence, 0)
  assert.equal(hub.replaySince(session).reason, "missing_cursor")

  hub.publish(server, "sessions.updated", { seq: 2 })
  const replay = hub.replaySince(server, serverCursor)
  assert.equal(replay.resyncRequired, false)
  assert.deepEqual(replay.events.map(event => (event.payload as { seq: number }).seq), [2])
})

test("EventHub notifies subscribers", () => {
  const hub = new EventHub()
  const stream = { kind: "session" as const, id: "one" }
  const seen: string[] = []
  const off = hub.subscribe(event => {
    if (event.channel === "pi.event") seen.push(String((event.payload as { seq: number }).seq))
  })
  hub.publish(stream, "pi.event", { seq: 1 })
  hub.publish(stream, "session.head", { seq: 2 })
  off()
  hub.publish(stream, "pi.event", { seq: 3 })
  assert.deepEqual(seen, ["1"])
})

test("private terminal live events and retained replay never expose foreign or legacy ownerless entries", () => {
  const hub = new EventHub()
  const stream = { kind: "workspace" as const, id: "shared-workspace" }
  const ownerA = terminalOwnerFromSecret("aa".repeat(32))!
  const ownerB = terminalOwnerFromSecret("bb".repeat(32))!
  const initial = hub.getCursor(stream)
  const liveA: string[] = []
  const liveB: string[] = []
  const publicOnly: string[] = []
  hub.subscribe(event => liveA.push(String((event.payload as { id: string }).id)), ownerA)
  hub.subscribe(event => liveB.push(String((event.payload as { id: string }).id)), () => ownerB)
  hub.subscribe(event => publicOnly.push(String((event.payload as { id: string }).id)))
  for (const channel of ["terminal.created", "terminal.updated", "terminal.exited", "terminal.deleted"] as const) {
    const event = hub.publish(stream, channel, { id: "A", title: "A private title" }, ownerA)
    hub.publish(stream, channel, { id: "B", title: "B private title" }, ownerB)
    hub.publish(stream, channel, { id: "legacy", title: "ownerless" })
    assert.ok(!eventWireFrame(event).data.includes(ownerA))
  }
  hub.publish(stream, "workspace.files", { id: "public" })
  assert.deepEqual(liveA, ["A", "A", "A", "A", "public"])
  assert.deepEqual(liveB, ["B", "B", "B", "B", "public"])
  assert.deepEqual(publicOnly, ["public"])
  const replayA = hub.replaySince(stream, initial, ownerA)
  const replayB = hub.replaySince(stream, initial, ownerB)
  assert.equal(replayA.resyncRequired, false)
  assert.deepEqual(replayA.events.map(event => (event.payload as { id: string }).id), liveA)
  assert.deepEqual(replayB.events.map(event => (event.payload as { id: string }).id), liveB)
  assert.deepEqual(hub.replaySince(stream, initial).events.map(event => (event.payload as { id: string }).id), ["public"])
})
