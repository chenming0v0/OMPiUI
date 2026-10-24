import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { OmpExtensionUiBridge } from "./omp-extension-ui.js"

function bridge() {
  const ui = new OmpExtensionUiBridge()
  ui.bind("session-1", () => {})
  return ui
}

describe("OMP extension UI wire contract", () => {
  it("keeps a widget's identity across request IDs and preserves its content and placement", () => {
    const ui = bridge()
    ui.handleOmpRequest({
      type: "extension_ui_request", method: "setWidget", id: "request-1",
      widgetKey: "plan-todos", widgetLines: ["Read the code"],
    })
    ui.handleOmpRequest({
      type: "extension_ui_request", method: "setWidget", id: "request-2",
      widgetKey: "plan-todos", widgetLines: ["\u001b[32mRead the code: done\u001b[0m", "Explain the issue"],
      widgetPlacement: "belowEditor",
    })
    assert.deepEqual(ui.getStateMirror(), [
      { kind: "widget", key: "plan-todos", lines: ["\u001b[32mRead the code: done\u001b[0m", "Explain the issue"], placement: "belowEditor" },
    ])
  })

  it("distinguishes removing a widget from replacing it with empty content", () => {
    const ui = bridge()
    ui.handleOmpRequest({ method: "setWidget", id: "create", widgetKey: "progress", widgetLines: ["Working"] })
    ui.handleOmpRequest({ method: "setWidget", id: "clear", widgetKey: "progress", widgetLines: [] })
    // JSON serialization omits widgetLines when ctx.ui.setWidget(key, undefined) removes it.
    ui.handleOmpRequest({ method: "setWidget", id: "remove", widgetKey: "progress" })
    assert.deepEqual(ui.getStateMirror(), [
      { kind: "widget", key: "progress" },
    ])
  })

  it("updates and clears a named status using the official status fields", () => {
    const ui = bridge()
    ui.handleOmpRequest({ method: "setStatus", id: "request-1", statusKey: "plan-mode", statusText: "Planning" })
    ui.handleOmpRequest({ method: "setStatus", id: "request-2", statusKey: "plan-mode", statusText: "Executing" })
    ui.handleOmpRequest({ method: "setStatus", id: "request-3", statusKey: "plan-mode" })
    assert.deepEqual(ui.getStateMirror(), [
      { kind: "status", key: "plan-mode", text: undefined },
    ])
  })

  it("cancels only targetId and ignores late answers without replying to the native abort", () => {
    const ui = new OmpExtensionUiBridge()
    const responses: unknown[] = []
    const settled: string[] = []
    ui.bind("session-1", response => responses.push(response))
    ui.onEvent(event => { if (event.type === "settled") settled.push(event.requestId) })
    ui.handleOmpRequest({ method: "input", id: "target", title: "First" })
    ui.handleOmpRequest({ method: "input", id: "cancel-frame", title: "Second" })
    ui.handleOmpRequest({ method: "cancel", id: "cancel-frame", targetId: "target" })
    assert.deepEqual(ui.listPending().map(request => request.requestId), ["cancel-frame"])
    assert.deepEqual(settled, ["target"])
    assert.equal(ui.respond("target", { value: "too late" }), false)
    assert.deepEqual(responses, [])
    assert.equal(ui.respond("cancel-frame", { value: "" }), true)
    assert.deepEqual(responses, [{ type: "extension_ui_response", id: "cancel-frame", value: "" }])
  })

  it("ignores repeated opens and unknown or repeated cancellation without leaking the original timer", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const ui = new OmpExtensionUiBridge()
    const responses: unknown[] = []
    const settlements: unknown[] = []
    ui.bind("session", response => responses.push(response))
    ui.onEvent(event => { if (event.type === "settled") settlements.push(event) })
    ui.handleOmpRequest({ method: "input", id: "A", title: "Original", timeout: 10 })
    ui.handleOmpRequest({ method: "input", id: "A", title: "Duplicate", timeout: 1 })
    ui.handleOmpRequest({ method: "input", id: "B", title: "Unrelated" })
    t.mock.timers.tick(2)
    assert.deepEqual(ui.listPending().map(request => request.title), ["Original", "Unrelated"])
    ui.handleOmpRequest({ method: "cancel", id: "B", targetId: "unknown" })
    ui.handleOmpRequest({ method: "cancel", id: "B", targetId: "A" })
    ui.handleOmpRequest({ method: "cancel", id: "B", targetId: "A" })
    ui.handleOmpRequest({ method: "input", id: "A", title: "Late replay", timeout: 1 })
    t.mock.timers.tick(20)
    assert.deepEqual(ui.listPending().map(request => request.requestId), ["B"])
    assert.deepEqual(settlements, [{ type: "settled", requestId: "A", sessionId: "session", reason: "aborted" }])
    assert.equal(ui.respond("A", { value: "late" }), false)
    assert.equal(ui.respond("B", { value: "kept" }), true)
    assert.equal(ui.respond("B", { value: "duplicate" }), false)
    assert.deepEqual(responses, [{ type: "extension_ui_response", id: "B", value: "kept" }])
  })

  it("settles an old session before rebinding and permits its native IDs in the new session", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const ui = new OmpExtensionUiBridge()
    const oldResponses: unknown[] = []
    const newResponses: unknown[] = []
    const settlements: unknown[] = []
    ui.bind("old", response => oldResponses.push(response))
    ui.onEvent(event => { if (event.type === "settled") settlements.push(event) })
    ui.handleOmpRequest({ method: "input", id: "dialog", title: "Old", timeout: 1 })
    ui.bind("new", response => newResponses.push(response))
    ui.handleOmpRequest({ method: "input", id: "dialog", title: "New" })
    t.mock.timers.tick(2)
    assert.deepEqual(oldResponses, [])
    assert.deepEqual(newResponses, [])
    assert.deepEqual(settlements, [{ type: "settled", requestId: "dialog", sessionId: "old", reason: "session_replaced" }])
    assert.equal(ui.listPending()[0]?.sessionId, "new")
    ui.respond("dialog", { value: "new answer" })
    assert.deepEqual(newResponses, [{ type: "extension_ui_response", id: "dialog", value: "new answer" }])
  })

  for (const kind of ["select", "confirm", "input", "editor"] as const) {
    it(`preserves ${kind} submission, cancellation and timeout outcomes`, t => {
      t.mock.timers.enable({ apis: ["setTimeout"] })
      const ui = new OmpExtensionUiBridge()
      const responses: unknown[] = []
      const reasons: string[] = []
      ui.bind("session", response => responses.push(response))
      ui.onEvent(event => { if (event.type === "settled") reasons.push(event.reason) })
      ui.handleOmpRequest({ method: kind, id: "submit", title: "Submit", options: ["choice"] })
      ui.respond("submit", kind === "confirm" ? { confirmed: true } : { value: "choice" })
      ui.handleOmpRequest({ method: kind, id: "cancel", title: "Cancel" })
      ui.respond("cancel", { cancelled: true })
      ui.handleOmpRequest({ method: kind, id: "timeout", title: "Timeout", timeout: 2 })
      t.mock.timers.tick(3)
      assert.deepEqual(ui.listPending(), [])
      assert.deepEqual(reasons, ["submitted", "user_cancelled", "timeout"])
      assert.deepEqual(responses, [
        { type: "extension_ui_response", id: "submit", ...(kind === "confirm" ? { confirmed: true } : { value: "choice" }) },
        { type: "extension_ui_response", id: "cancel", cancelled: true },
        { type: "extension_ui_response", id: "timeout", cancelled: true, timedOut: true },
      ])
    })
  }

  it("preserves positional option descriptions and empty editor submission as a value", () => {
    const ui = new OmpExtensionUiBridge()
    const responses: unknown[] = []
    ui.bind("session-1", response => responses.push(response))
    ui.handleOmpRequest({ method: "select", id: "choice", title: "Storage", options: ["SQLite", "Postgres"], optionDetails: [{}, { description: "Server storage" }] })
    const choice = ui.listPending()[0]!
    assert.equal(choice.kind, "select")
    if (choice.kind === "select") assert.deepEqual(choice.optionDetails, [{}, { description: "Server storage" }])
    ui.handleOmpRequest({ method: "editor", id: "draft", title: "Draft", prefill: "", promptStyle: true })
    const draft = ui.listPending()[1]!
    assert.equal(draft.kind, "editor")
    if (draft.kind === "editor") {
      assert.equal(draft.prefill, "")
      assert.equal(draft.promptStyle, true)
    }
    ui.respond("draft", { value: "" })
    assert.deepEqual(responses, [{ type: "extension_ui_response", id: "draft", value: "" }])
    ui.cancelAll("runtime_disposed")
  })

  it("expires a zero-timeout native request instead of leaving an immortal dialog", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const ui = new OmpExtensionUiBridge()
    const responses: unknown[] = []
    ui.bind("session-1", response => responses.push(response))
    ui.handleOmpRequest({ method: "input", id: "expired", title: "Question", placeholder: "", timeout: 0 })
    const request = ui.listPending()[0]!
    assert.ok(request.expiresAt)
    if (request.kind === "input") assert.equal(request.placeholder, "")
    t.mock.timers.tick(1)
    assert.deepEqual(ui.listPending(), [])
    assert.deepEqual(responses, [{ type: "extension_ui_response", id: "expired", cancelled: true, timedOut: true }])
  })
})
