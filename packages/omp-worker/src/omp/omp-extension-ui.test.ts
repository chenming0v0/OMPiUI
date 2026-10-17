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
      { kind: "widget", key: "plan-todos", lines: ["Read the code"], placement: "aboveEditor" },
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
      { kind: "widget", key: "progress", lines: ["Working"], placement: "aboveEditor" },
      { kind: "widget", key: "progress", lines: [], placement: "aboveEditor" },
      { kind: "widget", key: "progress" },
    ])
  })

  it("updates and clears a named status using the official status fields", () => {
    const ui = bridge()
    ui.handleOmpRequest({ method: "setStatus", id: "request-1", statusKey: "plan-mode", statusText: "Planning" })
    ui.handleOmpRequest({ method: "setStatus", id: "request-2", statusKey: "plan-mode", statusText: "Executing" })
    ui.handleOmpRequest({ method: "setStatus", id: "request-3", statusKey: "plan-mode" })
    assert.deepEqual(ui.getStateMirror(), [
      { kind: "status", key: "plan-mode", text: "Planning" },
      { kind: "status", key: "plan-mode", text: "Executing" },
      { kind: "status", key: "plan-mode", text: undefined },
    ])
  })
})
