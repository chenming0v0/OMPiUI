import assert from "node:assert/strict"
import test from "node:test"
import { WorkspaceWatchControl } from "./workspace-watch-control.ts"

test("watch changes coalesce behind one IPC callback and converge without retaining display metadata", () => {
  const messages: Array<{ type: string; roots?: string[] }> = []
  const callbacks: Array<(error?: Error) => void> = []
  const control = new WorkspaceWatchControl((message, done) => {
    messages.push(message)
    callbacks.push(done)
  }, { maxWatchDirectories: 4000, startupDelayMs: 0 }, error => { throw error })
  let roots: string[] = []
  for (let i = 0; i < 96; i++) {
    roots = Array.from({ length: 32 }, (_, j) => `/audit/${i + j}`)
    control.sync(roots)
  }
  assert.deepEqual(messages, [{ type: "configure", maxWatchDirectories: 4000, startupDelayMs: 0 }])
  callbacks.shift()!()
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[1], { type: "sync", roots })
  control.sync([])
  control.sync(["/final"])
  assert.equal(messages.length, 2)
  callbacks.shift()!()
  assert.deepEqual(messages[2], { type: "sync", roots: ["/final"] })
  callbacks.shift()!()
  assert.equal(messages.length, 3)
  assert.ok(JSON.stringify(messages).length < 4096)
  control.dispose()
  callbacks.forEach(done => done())
})
