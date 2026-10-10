import assert from "node:assert/strict"
import test from "node:test"
import { EventHub } from "../event-hub.ts"
import { SessionHost } from "./session-host.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import type { WorkerSession } from "./worker-client.ts"

process.env.OMPIUI_DRIVER = "mock"

function fixture() {
  let crash!: (error: Error) => void
  let opens = 0
  let failRecovery = false
  let cleanup: Promise<void> = Promise.resolve()
  const worker = () => ({
    command: async () => ({}),
    getSessionId: () => "recover-session",
    getSessionFile: () => "recover-session.jsonl",
    getCwd: () => ".",
    onEvent: () => () => {},
    onCrash: (listener: (error: Error) => void) => { crash = listener; return () => {} },
    onClose: () => () => {},
    dispose: async () => { await cleanup },
  }) as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => {
      opens += 1
      if (opens === 2 && failRecovery) throw new Error("recovery failed")
      return worker()
    },
  } as unknown as RuntimeSupervisor
  const hub = new EventHub()
  const host = new SessionHost(supervisor, hub)
  return {
    host, hub, get opens() { return opens },
    crash: () => crash(new Error("OMP child exited")),
    setFailure: () => { failRecovery = true },
    setCleanup: (promise: Promise<void>) => { cleanup = promise },
  }
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve))
}

test("SessionHost automatically reattaches a crashed runtime after releasing its old lease", async () => {
  const f = fixture()
  const events: unknown[] = []
  const off = f.hub.subscribe(event => { if (event.channel === "sessions.updated") events.push(event.payload) })
  try {
    await f.host.openSession(".")
    let release!: () => void
    f.setCleanup(new Promise<void>(resolve => { release = resolve }))
    f.crash()
    await settle()
    assert.equal(f.opens, 1)
    assert.equal(f.host.getAttached("recover-session"), undefined)
    release()
    await settle()
    assert.equal(f.opens, 2)
    assert.ok(f.host.getAttached("recover-session"))
    assert.ok(events.some(event => (event as { recovered?: boolean }).recovered))
  } finally {
    off()
    f.host.dispose()
  }
})

test("SessionHost leaves a failed recovery retryable", async () => {
  const f = fixture()
  try {
    await f.host.openSession(".")
    f.setFailure()
    f.crash()
    await settle()
    assert.equal(f.host.getAttached("recover-session"), undefined)
    await f.host.openSession(".")
    assert.equal(f.opens, 3)
    assert.ok(f.host.getAttached("recover-session"))
  } finally {
    f.host.dispose()
  }
})

test("SessionHost does not recreate a crashed runtime after shutdown", async () => {
  const f = fixture()
  try {
    await f.host.openSession(".")
    f.host.dispose()
    f.crash()
    await settle()
    assert.equal(f.opens, 1)
  } finally {
    f.host.dispose()
  }
})
