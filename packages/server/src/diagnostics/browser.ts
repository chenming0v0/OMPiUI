import { BROWSER_DIAGNOSTIC_EVENTS, type BrowserDiagnosticMessage } from "@ompiui/protocol"
import { diagnostics } from "./recorder.ts"

export function recordBrowserDiagnostic(
  message: BrowserDiagnosticMessage,
  connectionId: string,
  sessionIds: string[],
): string | undefined {
  if (!BROWSER_DIAGNOSTIC_EVENTS.includes(message.event) ||
      typeof message.clientId !== "string" || message.clientId.length > 80) return
  if (message.sessionId !== undefined && !sessionIds.includes(message.sessionId)) return
  diagnostics.record(`browser.${message.event}`, {
    connectionId, clientId: message.clientId, sessionId: message.sessionId, sessionIds,
    state: message.state, status: message.status, errorCode: message.errorCode,
    visibility: message.visibility, navigation: message.navigation,
    code: message.code, reason: message.reason,
  }, message.event.endsWith("_error") ? "warn" : "info")
  return message.clientId
}
