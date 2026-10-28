import assert from "node:assert/strict"
import { it } from "node:test"
import { validateParams, type JsonObject } from "@ompiui/protocol"
import { getCommandCapability } from "@ompiui/omp-worker"
import { createAppServer } from "./http.ts"
import type { SessionHost } from "./omp/session-host.ts"
import type { RuntimeSupervisor } from "./omp/supervisor.ts"

it("background job commands keep jobId through the HTTP body unwrapping", async t => {
  const received: Array<{ name: string; params: JsonObject | undefined; requestId: string | undefined }> = []
  const sessionHost = {
    executeSessionCommand: async (_sessionId: string, name: string, params: JsonObject | undefined, requestId?: string) => {
      validateParams(getCommandCapability(name)?.paramsSchema, params ?? {})
      received.push({ name, params, requestId })
      return { ok: true }
    },
    dispose: () => {},
  } as unknown as SessionHost
  const supervisor = { onEvent: () => () => {}, shutdown: async () => {}, dispose: async () => {} } as unknown as RuntimeSupervisor
  const app = createAppServer({ authToken: "test-token", sessionHost, supervisor })
  await new Promise<void>((resolve, reject) => {
    app.server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()))
  })
  t.after(() => app.dispose())
  const addr = app.server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")

  for (const name of ["asyncJobs.inspect", "asyncJobs.cancel"]) {
    const response: Response = await fetch(`http://127.0.0.1:${addr.port}/api/v1/pi/sessions/s1/commands/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ jobId: "x" }),
    })
    assert.equal(response.status, 200, name)
  }
  assert.deepEqual(received.map(entry => [entry.name, entry.params?.jobId, entry.requestId]), [
    ["asyncJobs.inspect", "x", undefined],
    ["asyncJobs.cancel", "x", undefined],
  ])
})
