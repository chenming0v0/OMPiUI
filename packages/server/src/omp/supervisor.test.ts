import assert from "node:assert/strict"
import test from "node:test"
import { RuntimeSupervisor } from "./supervisor.ts"
import type { SessionLease } from "./session-lease.ts"
import { SessionHost } from "./session-host.ts"
import { EventHub } from "../event-hub.ts"

test("RuntimeSupervisor retains the lease until a cancelled background open is cleaned up", async () => {
  let leases = 0
  const supervisor = new RuntimeSupervisor({
    workerEntry: new URL("./worker-client-fixture.mjs", import.meta.url),
    worker: { env: { OMPIUI_FIXTURE_MODE: "slow-open" }, execArgv: ["--import", "tsx"] },
    leases: {
      acquire: async () => {
        leases += 1
        return {
          refresh: async () => {}, release: () => { leases -= 1 },
        } as unknown as SessionLease
      },
      dispose: () => {},
    },
  })
  try {
    await supervisor.getCatalogHandshake()
    const controller = new AbortController()
    const opening = supervisor.open(".", "cancelled.jsonl", controller.signal)
    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort()
    assert.equal(leases, 1)
    await assert.rejects(opening, { code: "REQUEST_ABORTED" })
    assert.equal(leases, 0)
    assert.deepEqual(await supervisor.catalogCommand("fixture.sessions"), { active: 0 })
  } finally {
    await supervisor.dispose()
  }
})

test("OMP child crash travels over IPC and recovers the same session without affecting another runtime", async () => {
  process.env.OMPIUI_DRIVER = "mock"
  let leases = 0
  const supervisor = new RuntimeSupervisor({
    workerEntry: new URL("./worker-client-fixture.mjs", import.meta.url),
    worker: { execArgv: ["--import", "tsx"] },
    leases: {
      acquire: async () => {
        leases += 1
        let released = false
        return {
          refresh: async () => {},
          release: () => { if (!released) { released = true; leases -= 1 } },
        } as unknown as SessionLease
      },
      dispose: () => {},
    },
  })
  const hub = new EventHub()
  const host = new SessionHost(supervisor, hub)
  const recovered = new Promise<void>(resolve => {
    hub.subscribe(event => {
      if (event.channel === "sessions.updated" && (event.payload as { recovered?: boolean }).recovered) resolve()
    })
  })
  try {
    const first = await host.openSession(".", "crashed.jsonl")
    const other = await host.openSession(".", "other.jsonl")
    const id = String(first.sessionId)
    await host.requireAttached(id).worker.command("fixture.crash")
    await Promise.race([
      recovered,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("runtime did not recover")), 5000)
        timer.unref()
      }),
    ])
    assert.equal(host.requireAttached(id).sessionId, id)
    assert.deepEqual(await supervisor.catalogCommand("fixture.sessions"), { active: 2 })
    assert.equal(leases, 2)
    assert.deepEqual(await host.requireAttached(String(other.sessionId)).worker.command("state.get"), { fixture: "ok" })
  } finally {
    host.dispose()
    await supervisor.dispose()
    delete process.env.OMPIUI_DRIVER
  }
  assert.equal(leases, 0)
})
