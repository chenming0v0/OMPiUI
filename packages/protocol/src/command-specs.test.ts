import assert from "node:assert/strict"
import { test } from "node:test"
import { HOST_COMMAND_SPECS, PI_COMMAND_SPECS, validateParams } from "./index.ts"
import type { JsonObject } from "./json.ts"

function assertSchemaSane(name: string, schema: JsonObject | undefined): void {
  if (!schema) return
  if (schema.type !== "object") return
  const properties = schema.properties as Record<string, unknown> | undefined
  const required = (schema.required as string[] | undefined) ?? []
  if (required.length > 0) {
    assert.ok(properties, `${name}: required fields need a properties map`)
    for (const field of required) {
      assert.ok(field in (properties ?? {}), `${name}: required field "${field}" missing from properties`)
    }
  }
}

test("command spec names are unique", () => {
  const pi = PI_COMMAND_SPECS.map(spec => spec.name)
  assert.equal(new Set(pi).size, pi.length, "duplicate Pi command spec names")
  const host = HOST_COMMAND_SPECS.map(spec => spec.name)
  assert.equal(new Set(host).size, host.length, "duplicate host command spec names")
})

test("command spec schemas are internally consistent", () => {
  for (const spec of [...PI_COMMAND_SPECS, ...HOST_COMMAND_SPECS]) {
    assertSchemaSane(spec.name, spec.paramsSchema)
  }
})

test("serialized pi commands are not marked idempotent", () => {
  for (const spec of [...PI_COMMAND_SPECS, ...HOST_COMMAND_SPECS]) {
    if (spec.queue === "serialized") {
      assert.ok(!spec.idempotent, `${spec.name}: serialized commands must not be idempotent`)
    }
  }
})

test("goal schema accepts a positive integer tokenBudget (#396)", () => {
  const spec = PI_COMMAND_SPECS.find(item => item.name === "goal") as { paramsSchema: JsonObject } | undefined
  assert.ok(spec)
  validateParams(spec.paramsSchema, { op: "create", objective: "ship", tokenBudget: 1 })
  validateParams(spec.paramsSchema, { op: "create", objective: "ship", tokenBudget: 200000 })
  validateParams(spec.paramsSchema, { op: "create", objective: "ship" })
  validateParams(spec.paramsSchema, { op: "budget", clearBudget: true })
  for (const op of ["get", "replace", "complete", "pause", "resume", "drop"]) validateParams(spec.paramsSchema, { op })
  for (const tokenBudget of [0, -1, 1.5, "100"]) {
    assert.throws(
      () => validateParams(spec.paramsSchema, { op: "create", objective: "ship", tokenBudget }),
      { code: "INVALID_REQUEST" },
      `tokenBudget=${String(tokenBudget)} must be rejected`,
    )
  }
  assert.throws(
    () => validateParams(spec.paramsSchema, { op: "create", objective: "ship", images: [{ type: "image", mimeType: "image/png", data: "AA==" }] }),
    { code: "INVALID_REQUEST" },
  )
})
