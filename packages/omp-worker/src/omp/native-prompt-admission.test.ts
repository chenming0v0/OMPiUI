import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, describe, it } from "node:test"
import { NATIVE_PROMPT_ADMISSION_SOURCE } from "./native-prompt-admission.js"

// The admission logic runs inside the official OMP process; load the generated
// source in a throwaway module with the two host symbols it expects.
const directory = mkdtempSync(path.join(tmpdir(), "ompiui-admission-"))
after(() => rmSync(directory, { recursive: true, force: true }))

const moduleUrl = (() => {
  const file = path.join(directory, "admission.mjs")
  writeFileSync(file, `import { AsyncLocalStorage } from "node:async_hooks";
const isUserQueuedMessage = message => !!message && message.role === "user";
function resumeStoppedSession() {}
async function configureQueueBatching() {}
${NATIVE_PROMPT_ADMISSION_SOURCE}
export { submitUserMessage };
`)
  return pathToFileURL(file).href
})()

type Submit = (session: unknown, args: Record<string, unknown>) => Promise<unknown>

async function loadSubmit(): Promise<Submit> {
  const module = await import(moduleUrl) as { submitUserMessage: Submit }
  return module.submitUserMessage
}

function fakeSession(prompt: () => Promise<boolean | undefined>) {
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  return {
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/sessions/session-1.jsonl" },
    agent: {
      peekSteeringQueue: () => [],
      peekFollowUpQueue: () => [],
      state: { messages: [] as unknown[] },
      subscribe(listener: (event: Record<string, unknown>) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    prompt,
  }
}

describe("native prompt admission", () => {
  it("releases the submission lock when the native prompt never settles", async () => {
    const submit = await loadSubmit()
    const previous = process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS
    process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS = "60"
    try {
      const stalled = fakeSession(() => new Promise<boolean>(() => {}))
      await assert.rejects(
        submit(stalled, { text: "hello", deliverAs: "followUp" }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, "SUBMISSION_NOT_ADMITTED")
          assert.match(error.message, /admission timed out/)
          return true
        },
      )
      // The same session must be usable again: the leaked flight would make this
      // second submission wait forever (the 30s worker timeout users see).
      const recovered = fakeSession(async () => false)
      assert.deepEqual(await submit(recovered, { text: "again", deliverAs: "followUp" }), { accepted: true })
    } finally {
      if (previous === undefined) delete process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS
      else process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS = previous
    }
  })

  it("does not time out a prompt that is admitted normally", async () => {
    const submit = await loadSubmit()
    const previous = process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS
    process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS = "5_000"
    try {
      assert.deepEqual(
        await submit(fakeSession(async () => false), { text: "hi", deliverAs: "followUp" }),
        { accepted: true },
      )
    } finally {
      if (previous === undefined) delete process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS
      else process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS = previous
    }
  })
})
