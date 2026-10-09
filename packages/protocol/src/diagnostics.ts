import type { PROTOCOL_VERSION } from "./version.js"

export type DiagnosticRunState = {
  isStreaming?: boolean
  isIdle?: boolean
  isCompacting?: boolean
  isBashRunning?: boolean
  hasPendingAsyncWork?: boolean
  readOnly?: boolean
  pendingMessageCount?: number
  goalStatus?: string
}

export const BROWSER_DIAGNOSTIC_EVENTS = [
  "connected", "disconnect", "pagehide", "visibility", "state", "state_error", "branch_error", "activity",
] as const

export type BrowserDiagnosticMessage = {
  type: "diagnostic"
  protocolVersion: typeof PROTOCOL_VERSION
  event: typeof BROWSER_DIAGNOSTIC_EVENTS[number]
  clientId: string
  sessionId?: string
  state?: DiagnosticRunState
  status?: string
  errorCode?: string
  visibility?: string
  navigation?: string
  code?: number
  reason?: string
}
