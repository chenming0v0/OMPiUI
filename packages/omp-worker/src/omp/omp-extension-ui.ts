import type { JsonObject } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"
import type { ExtensionUiDialogRequest, ExtensionUiDialogResponse, ExtensionUiSettlementReason, ExtensionUiStatePatch } from "@ompiui/protocol"

/**
 * OMP 扩展 UI 桥：把 `omp --mode rpc` 的 extension_ui_request 帧映射成
 * OMPiUI 的 extension.ui 协议事件（requested/settled/state/notify/editor），
 * 应答帧按 OMP 约定写回 stdin。
 *
 * OMP 帧方法（docs/rpc.md）：select / confirm / input / editor / cancel /
 * notify / setStatus / setWidget / setTitle / set_editor_text / open_url。
 */
export type OmpExtensionUiEvent =
  | { type: "requested"; request: ExtensionUiDialogRequest }
  | { type: "settled"; requestId: string; sessionId: string; reason: ExtensionUiSettlementReason }
  | { type: "state"; sessionId: string; patch: ExtensionUiStatePatch }
  | { type: "notify"; sessionId: string; message: string; notifyType?: string }
  | { type: "editor"; sessionId: string; command: { kind: "set" | "paste"; text: string } }

const MAX_WIDGET_LINES = 512
const MAX_WIDGET_BYTES = 64 * 1024

interface PendingDialog {
  request: ExtensionUiDialogRequest
  ompId: string
  timer?: NodeJS.Timeout
}

export class OmpExtensionUiBridge {
  private readonly pending = new Map<string, PendingDialog>()
  private readonly pendingByOmpId = new Map<string, string>()
  private readonly settledOmpIds = new Set<string>()
  private readonly stateMirror: ExtensionUiStatePatch[] = []
  private readonly listeners = new Set<(event: OmpExtensionUiEvent) => void>()
  private sessionId = ""
  private write: ((response: JsonObject) => void) | undefined

  bind(sessionId: string, write: (response: JsonObject) => void): void {
    if (this.sessionId !== sessionId) {
      this.cancelAll("session_replaced", false)
      this.settledOmpIds.clear()
    }
    this.sessionId = sessionId
    this.write = write
  }

  onEvent(listener: (event: OmpExtensionUiEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  handleOmpRequest(frame: JsonObject): void {
    const method = typeof frame.method === "string" ? frame.method : ""
    const ompId = typeof frame.id === "string" ? frame.id : ""
    switch (method) {
      case "select":
      case "confirm":
      case "input":
      case "editor": {
        this.openDialog(method, ompId, frame)
        return
      }
      case "cancel": {
        const targetId = typeof frame.targetId === "string" ? frame.targetId : ""
        const requestId = this.pendingByOmpId.get(targetId)
        if (requestId) this.cancel(requestId, "aborted", false)
        return
      }
      case "notify": {
        const message = typeof frame.message === "string" ? frame.message : ""
        this.emit({ type: "notify", sessionId: this.sessionId, message, notifyType: typeof frame.notifyType === "string" ? frame.notifyType : undefined })
        return
      }
      case "setStatus": {
        if (typeof frame.statusKey !== "string") return
        this.pushState({ kind: "status", key: frame.statusKey, text: typeof frame.statusText === "string" ? frame.statusText : undefined })
        return
      }
      case "setWidget": {
        if (typeof frame.widgetKey !== "string") return
        if (frame.widgetLines === undefined) {
          this.pushState({ kind: "widget", key: frame.widgetKey })
          return
        }
        if (!Array.isArray(frame.widgetLines)) return
        const lines: string[] = []
        let bytes = 0
        for (const rawLine of frame.widgetLines) {
          if (lines.length >= MAX_WIDGET_LINES) break
          const line = String(rawLine)
          const lineBytes = Buffer.byteLength(line, "utf8")
          if (bytes + lineBytes > MAX_WIDGET_BYTES) break
          lines.push(line)
          bytes += lineBytes
        }
        this.pushState({
          kind: "widget",
          key: frame.widgetKey,
          lines,
          placement: frame.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
        })
        return
      }
      case "setTitle": {
        this.pushState({ kind: "title", title: typeof frame.title === "string" ? frame.title : "" })
        return
      }
      case "set_editor_text": {
        this.emit({ type: "editor", sessionId: this.sessionId, command: { kind: "set", text: typeof frame.text === "string" ? frame.text : "" } })
        return
      }
      case "open_url": {
        const url = typeof frame.url === "string" ? frame.url : ""
        const launchUrl = typeof frame.launchUrl === "string" ? frame.launchUrl : url
        const instructions = typeof frame.instructions === "string" ? frame.instructions : ""
        this.emit({ type: "notify", sessionId: this.sessionId, message: [launchUrl ? `打开链接: ${launchUrl}` : "", instructions, launchUrl !== url ? url : ""].filter(Boolean).join("\n"), notifyType: "link" })
        return
      }
      default:
        return
    }
  }

  private openDialog(kind: ExtensionUiDialogRequest["kind"], ompId: string, frame: JsonObject): void {
    if (!ompId || this.pendingByOmpId.has(ompId) || this.settledOmpIds.has(ompId)) return
    const title = typeof frame.title === "string" ? frame.title : ""
    const timeout = typeof frame.timeout === "number" ? frame.timeout : undefined
    const base = stripUndefined({
      requestId: ompId,
      sessionId: this.sessionId,
      title,
      createdAt: new Date().toISOString(),
      ...(timeout !== undefined ? { expiresAt: new Date(Date.now() + timeout).toISOString() } : {}),
    })
    const request: ExtensionUiDialogRequest = kind === "select"
      ? { ...base, kind, options: Array.isArray(frame.options) ? frame.options.map(String) : [],
          ...(Array.isArray(frame.optionDetails) ? { optionDetails: frame.optionDetails.map(detail =>
            isJsonObject(detail) && typeof detail.description === "string" ? { description: detail.description } : {}) } : {}) }
      : kind === "confirm"
        ? { ...base, kind, message: typeof frame.message === "string" ? frame.message : "" }
        : kind === "input"
          ? { ...base, kind, ...(typeof frame.placeholder === "string" ? { placeholder: frame.placeholder } : {}) }
          : { ...base, kind, ...(typeof frame.prefill === "string" ? { prefill: frame.prefill } : {}),
              ...(typeof frame.promptStyle === "boolean" ? { promptStyle: frame.promptStyle } : {}) }
    const pending: PendingDialog = { request, ompId }
    if (timeout !== undefined) {
      pending.timer = setTimeout(() => this.cancel(request.requestId, "timeout"), timeout)
      pending.timer.unref?.()
    }
    this.pending.set(request.requestId, pending)
    this.pendingByOmpId.set(ompId, request.requestId)
    this.emit({ type: "requested", request })
  }

  /** OMPiUI 应答 → OMP extension_ui_response 帧；返回是否命中未决请求 */
  respond(requestId: string, response: JsonObject): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.clearPending(requestId)
    const ompResponse: JsonObject = { type: "extension_ui_response", id: pending.ompId }
    if (isCancelled(response)) {
      ompResponse.cancelled = true
    } else if (pending.request.kind === "confirm") {
      ompResponse.confirmed = response.confirmed === true
    } else {
      ompResponse.value = typeof response.value === "string" ? response.value : ""
    }
    this.write?.(ompResponse)
    this.emit({ type: "settled", requestId, sessionId: pending.request.sessionId, reason: isCancelled(response) ? "user_cancelled" : "submitted" })
    return true
  }

  cancelAll(reason: ExtensionUiSettlementReason, respond = true): void {
    for (const requestId of [...this.pending.keys()]) {
      this.cancel(requestId, reason, respond)
    }
    this.stateMirror.length = 0
  }

  private cancel(requestId: string, reason: ExtensionUiSettlementReason, respond = true): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.clearPending(requestId)
    if (respond) this.write?.({ type: "extension_ui_response", id: pending.ompId, cancelled: true, ...(reason === "timeout" ? { timedOut: true } : {}) })
    this.emit({ type: "settled", requestId, sessionId: pending.request.sessionId, reason })
  }

  private clearPending(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(requestId)
    this.pendingByOmpId.delete(pending.ompId)
    this.settledOmpIds.add(pending.ompId)
  }

  private pushState(patch: ExtensionUiStatePatch): void {
    const index = this.stateMirror.findIndex(previous => previous.kind === patch.kind && (
      !('key' in previous) || ('key' in patch && previous.key === patch.key)
    ))
    if (index >= 0) this.stateMirror[index] = patch
    else this.stateMirror.push(patch)
    this.emit({ type: "state", sessionId: this.sessionId, patch })
  }

  private emit(event: OmpExtensionUiEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /** state.get 快照：未决弹窗（前端重连后重新渲染） */
  listPending(): ExtensionUiDialogRequest[] {
    return [...this.pending.values()].map(pending => pending.request)
  }

  /** state.get 快照：扩展增量 UI 状态 patch 镜像 */
  getStateMirror(): ExtensionUiStatePatch[] {
    return [...this.stateMirror]
  }
}

function isCancelled(response: JsonObject): boolean {
  return response.cancelled === true
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
