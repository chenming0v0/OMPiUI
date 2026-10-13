import assert from "node:assert/strict"
import test from "node:test"
import { redactDiagnosticText, splitFaultReport, uploadFaultReport, type FaultUploadProgress } from "./fault-report.js"

test("redaction removes credentials, JWTs, private URLs and user names", () => {
  const text = redactDiagnosticText([
    'Bearer abc-secret Basic base64-secret sk-secretKey', 'api_key=super-secret',
    '{"token":"json-secret", "password": "password-secret"}',
    'https://user:pass@private.example/path?token=encoded%20secret',
    'C:\\Users\\SensitiveUser\\logs', '/home/sensitive/logs',
    'eyJhbGciOiJIUzI1NiJ9.payload.signature',
  ].join("\n"))
  for (const secret of ["abc-secret", "base64-secret", "sk-secretKey", "super-secret", "json-secret", "password-secret", "private.example", "SensitiveUser", "/home/sensitive", "payload.signature"]) {
    assert.ok(!text.includes(secret), `must redact ${secret}`)
  }
})

test("report splitting respects UTF-8 bytes and line limits without losing content", () => {
  for (const content of ["中文🙂".repeat(20), "a\nb\nc\nd\n", "x".repeat(80) + "\n" + "z\n".repeat(20)]) {
    const parts = splitFaultReport(content, 16, 3)
    assert.equal(parts.join(""), content)
    for (const part of parts) {
      assert.ok(Buffer.byteLength(part) <= 16)
      assert.ok((part.match(/\n/g)?.length ?? 0) <= 3)
      assert.ok(!part.includes("\uFFFD"))
    }
  }
})

test("upload is credential-free, validates the returned link and resumes after a partial failure", async () => {
  const content = "short line\n".repeat(24_001)
  const requests: RequestInit[] = []
  let attempt = 0
  let progress: FaultUploadProgress = { links: [], total: 0 }
  const failing = (async (_url, init) => {
    requests.push(init!)
    attempt++
    return new Response(JSON.stringify(attempt === 1 ? { success: true, id: "part1", url: "https://mclo.gs/part1" } : {}), { status: attempt === 1 ? 200 : 503 })
  }) as typeof fetch
  await assert.rejects(uploadFaultReport(content, failing, progress, state => { progress = state }), /HTTP_503/)
  assert.deepEqual(progress.links, ["https://mclo.gs/part1"])
  assert.equal(progress.total, 2)
  const posted: string[] = []
  const succeeding = (async (_url, init) => {
    const body = new URLSearchParams(String(init!.body)).get("content")!
    posted.push(body)
    const id = posted.length === 1 ? "part2" : "index"
    return new Response(JSON.stringify({ success: true, id, url: `https://mclo.gs/${id}` }))
  }) as typeof fetch
  const done = await uploadFaultReport(content, succeeding, progress)
  assert.equal(done.indexUrl, "https://mclo.gs/index")
  assert.equal(posted.length, 2, "successful part must not be uploaded again")
  assert.ok(posted[1]?.includes("https://mclo.gs/part1"))
  assert.ok(posted[1]?.includes("https://mclo.gs/part2"))
  for (const init of requests) {
    assert.equal(init.credentials, "omit")
    assert.equal(new Headers(init.headers).get("authorization"), null)
    assert.equal(new Headers(init.headers).get("cookie"), null)
  }
  await assert.rejects(uploadFaultReport("x", (async () =>
    new Response(JSON.stringify({ success: true, id: "safe", url: "https://attacker.example/safe" }))) as typeof fetch), /INVALID_RESPONSE/)
})

test("form-encoded parts respect the actual request body budget", () => {
  const content = '{"text":"中文🙂 +%&"}\n'.repeat(30)
  const parts = splitFaultReport(content, 128, 24_000, true)
  assert.equal(parts.join(""), content)
  assert.ok(parts.length > 1)
  for (const part of parts) {
    assert.ok(Buffer.byteLength(new URLSearchParams({ content: part }).toString()) <= 128)
  }
})
