import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import { PassThrough } from "node:stream"
import test from "node:test"
import { readBody, statusForError } from "./http.ts"

const MiB = 1024 * 1024

function upload(declared?: number) {
  const stream = new PassThrough()
  const req = Object.assign(stream, {
    headers: declared === undefined ? {} : { "content-length": String(declared) },
  }) as unknown as IncomingMessage
  return { stream, req }
}

async function expectFullInputCapacity() {
  const controller = new AbortController()
  const { stream, req } = upload(64 * MiB)
  const result = readBody(req, controller.signal, 64 * MiB)
  controller.abort()
  try {
    await assert.rejects(result, { code: "REQUEST_ABORTED" })
  } finally {
    stream.destroy()
  }
  const next = upload(2)
  const body = readBody(next.req)
  next.stream.end("{}")
  assert.deepEqual(await body, {})
}

test("HTTP input reservations are refunded on every read and parse terminal path", async t => {
  for (const mode of ["valid", "invalid-json", "non-object", "stream-error", "client-abort", "signal-abort", "chunked-limit"] as const) {
    await t.test(mode, async () => {
      const controller = new AbortController()
      const { stream, req } = upload(mode === "chunked-limit" ? undefined : 24 * MiB)
      const result = readBody(req, controller.signal, mode === "chunked-limit" ? 4 : 24 * MiB)
      try {
        switch (mode) {
          case "valid":
            stream.end('{"ok":true}')
            assert.deepEqual(await result, { ok: true })
            break
          case "invalid-json":
          case "non-object":
            stream.end(mode === "invalid-json" ? "{" : "[]")
            await assert.rejects(result, { code: "INVALID_REQUEST" })
            break
          case "stream-error":
            stream.destroy(Object.assign(new Error("read failed"), { code: "EIO" }))
            await assert.rejects(result, { code: "EIO" })
            break
          case "client-abort":
            req.emit("aborted")
            await assert.rejects(result, { code: "REQUEST_ABORTED" })
            break
          case "signal-abort":
            controller.abort()
            await assert.rejects(result, { code: "REQUEST_ABORTED" })
            break
          case "chunked-limit":
            stream.write("{}")
            stream.write("   ")
            await assert.rejects(result, { code: "FILE_TOO_LARGE", bodyTooLarge: true })
            break
        }
      } finally {
        stream.destroy()
      }
      await expectFullInputCapacity()
    })
  }
})

test("HTTP capacity refusal refunds partial chunked reservations without refunding other uploads", async () => {
  const holder = upload(64 * MiB - 2)
  const controller = new AbortController()
  const held = readBody(holder.req, controller.signal, 64 * MiB)
  const chunked = upload()
  const result = readBody(chunked.req)
  try {
    chunked.stream.write("{")
    chunked.stream.write("  ")
    await assert.rejects(result, { code: "RATE_LIMITED", bodyTooLarge: true })

    const rejected = upload(3)
    await assert.rejects(readBody(rejected.req), { code: "RATE_LIMITED" })
    rejected.stream.destroy()

    const fitting = upload(2)
    const recovered = readBody(fitting.req)
    fitting.stream.end("{}")
    assert.deepEqual(await recovered, {})
  } finally {
    chunked.stream.destroy()
    controller.abort()
    await assert.rejects(held, { code: "REQUEST_ABORTED" })
    holder.stream.destroy()
  }
  await expectFullInputCapacity()
  assert.equal(statusForError({ code: "RATE_LIMITED" }), 503)
})

test("a per-request body limit keeps precedence over aggregate HTTP capacity", async () => {
  const holder = upload(64 * MiB - 1)
  const controller = new AbortController()
  const held = readBody(holder.req, controller.signal, 64 * MiB)
  const chunked = upload()
  const result = readBody(chunked.req, undefined, 2)
  try {
    chunked.stream.write("{")
    chunked.stream.write("  ")
    await assert.rejects(result, { code: "FILE_TOO_LARGE", bodyTooLarge: true })
    const declared = upload(3)
    await assert.rejects(readBody(declared.req, undefined, 2), { code: "FILE_TOO_LARGE" })
    declared.stream.destroy()
  } finally {
    chunked.stream.destroy()
    controller.abort()
    await assert.rejects(held, { code: "REQUEST_ABORTED" })
    holder.stream.destroy()
  }
  await expectFullInputCapacity()
  assert.equal(statusForError({ code: "FILE_TOO_LARGE" }), 413)
})
