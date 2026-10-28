import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { it } from "node:test"
import { validateParams, type JsonObject } from "@ompiui/protocol"
import { COMMAND_HANDLERS, getCommandCapability, type CommandContext } from "../command-table.ts"
import { MockPiSession } from "./mock-session.ts"

it("MockPiSession background jobs listed by asyncJobs.get can be inspected and cancelled by jobId", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-mock-jobs-"))
  const previous = process.env.OMPIUI_MOCK_DIR
  process.env.OMPIUI_MOCK_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.OMPIUI_MOCK_DIR
    else process.env.OMPIUI_MOCK_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  const session = await MockPiSession.open(root)
  t.after(() => session.abort())
  const context = { requireRuntime: () => session } as unknown as CommandContext
  const run = async (name: string, params: JsonObject) => {
    validateParams(getCommandCapability(name)?.paramsSchema, params)
    return await COMMAND_HANDLERS[name]!(context, params)
  }

  const jobs = await run("asyncJobs.get", {}) as { running: Array<{ id: string }> }
  const jobId = jobs.running[0]?.id
  assert.ok(jobId)

  const details = await run("asyncJobs.inspect", { jobId }) as JsonObject
  assert.ok(details)
  assert.equal(typeof details.command, "string")

  assert.deepEqual(await run("asyncJobs.cancel", { jobId }), { cancelled: true })
  const after = await run("asyncJobs.get", {}) as { running: Array<{ id: string }> }
  assert.ok(!after.running.some(job => job.id === jobId))

  assert.throws(() => validateParams(getCommandCapability("asyncJobs.inspect")?.paramsSchema, { id: jobId }))
})
