import { diagnostics, diagnosticErrorCode, diagnosticNativeCode, summarizeRunState } from "./recorder.ts"

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
      // 只有 errorCode 时，「提交未被原生接纳」和「OMP 进程退出」在日志里长得
      // 一样；补一个经过白名单校验的机器码即可区分失败类别。绝不记录
      // error.message —— 自由文本可能夹带路径、URL、用户内容（隐私红线）。
      const nativeCode = diagnosticNativeCode(error)
      diagnostics.record("worker.request.failed", {
        ...request, errorCode, durationMs: Math.round(performance.now() - started),
        reason: errorCode === "REQUEST_ABORTED" ? "caller_cancelled_request_not_agent_abort" : "request_failed",
        ...(nativeCode ? { nativeCode } : {}),
      }, errorCode === "REQUEST_ABORTED" ? "info" : "error")
    },
  }
}
