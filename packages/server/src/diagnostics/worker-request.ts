import { diagnostics, diagnosticErrorCode, summarizeRunState } from "./recorder.ts"

const IMPORTANT_COMMANDS = new Set([
  "prompt", "sendUserMessage", "abort", "abortRetry", "abortCompaction", "compact",
  "goal", "session.open", "session.close", "dispose", "switchSession",
])

export function traceWorkerRequest(
  request: { sessionId?: string; requestId: string; command: string; workerPid?: number },
): {
  completed: (data: unknown) => void
  failed: (error: unknown) => void
} {
  const started = performance.now()
  const level = IMPORTANT_COMMANDS.has(request.command) ? "info" : "debug"
  diagnostics.record("worker.request.started", request, level)
  return {
    completed(data) {
      diagnostics.record("worker.request.completed", {
        ...request, durationMs: Math.round(performance.now() - started),
        ...(request.command === "state.get" ? { state: summarizeRunState(data) } : {}),
      }, level)
    },
    failed(error) {
      const errorCode = diagnosticErrorCode(error)
      diagnostics.record("worker.request.failed", {
        ...request, errorCode, durationMs: Math.round(performance.now() - started),
        reason: errorCode === "REQUEST_ABORTED" ? "caller_cancelled_request_not_agent_abort" : "request_failed",
      }, errorCode === "REQUEST_ABORTED" ? "info" : "error")
    },
  }
}
