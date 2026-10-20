import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { OmpControlChannel } from "./omp-catalog.js"
import { OmpProviderAuth } from "./omp-auth.js"

test("model queries recover after config invalidation and control process exit", { timeout: 15_000 }, async t => {
  const previousBin = process.env.OMPI_OMP_BIN
  process.env.OMPI_OMP_BIN = fileURLToPath(new URL("./fixtures/control-rpc.cjs", import.meta.url))
  const control = new OmpControlChannel()
  t.after(async () => {
    await control.close()
    if (previousBin === undefined) delete process.env.OMPI_OMP_BIN
    else process.env.OMPI_OMP_BIN = previousBin
  })
  const auth = new OmpProviderAuth(() => control.acquire())
  const [first, concurrent] = await Promise.all([control.acquire(), control.acquire()])
  assert.equal(first, concurrent, "concurrent queries share one live control process")
  assert.deepEqual(await auth.listModels(), [{ id: "test-model", provider: "test" }])

  await auth.invalidate()
  assert.equal(first.hasExited, true)
  assert.deepEqual(await auth.listModels(), [{ id: "test-model", provider: "test" }])
  const second = await control.acquire()
  assert.notEqual(second, first, "config invalidation must acquire a fresh process")

  second.proc.kill()
  await second.waitForExit(5_000)
  assert.equal(second.hasExited, true)
  assert.deepEqual(await auth.listModels(), [{ id: "test-model", provider: "test" }])
  assert.notEqual(await control.acquire(), second, "unexpected exits must also recover")
})

test("failed startup is not cached and a later query can recover", { timeout: 15_000 }, async t => {
  const previousBin = process.env.OMPI_OMP_BIN
  const previousReject = process.env.OMPIUI_TEST_CONTROL_REJECT
  process.env.OMPI_OMP_BIN = fileURLToPath(new URL("./fixtures/control-rpc.cjs", import.meta.url))
  process.env.OMPIUI_TEST_CONTROL_REJECT = "1"
  const control = new OmpControlChannel()
  t.after(async () => {
    await control.close()
    if (previousBin === undefined) delete process.env.OMPI_OMP_BIN
    else process.env.OMPI_OMP_BIN = previousBin
    if (previousReject === undefined) delete process.env.OMPIUI_TEST_CONTROL_REJECT
    else process.env.OMPIUI_TEST_CONTROL_REJECT = previousReject
  })
  await assert.rejects(control.acquire(), /test negotiation rejected/)
  delete process.env.OMPIUI_TEST_CONTROL_REJECT
  const auth = new OmpProviderAuth(() => control.acquire())
  assert.deepEqual(await auth.listModels(), [{ id: "test-model", provider: "test" }])
})
