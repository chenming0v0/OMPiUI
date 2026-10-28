import { isErrorCode, type ErrorCode, type Problem } from "@ompiui/protocol"

/**
 * worker/omp 内部错误码 → 协议 ErrorCode。
 *
 * 协议白名单只认 ErrorCode（packages/protocol/src/problem.ts 的 ERROR_CODES），
 * 而 omp RPC 层、托管 runtime 桥、原生脚本各自抛的是自己的码（OMP_TIMEOUT /
 * OMP_EXITED / SESSION_REPLACED / SUBMISSION_NOT_ADMITTED ...）。这些码不在
 * 白名单里，problemFromError 一律兜底成 INTERNAL，一次"提交没被原生接纳"
 * 和一次"omp 进程退出"在客户端看起来完全一样，排查只能靠猜。这里在 worker
 * 出站边界做一次显式映射，并保留原始码供诊断。
 */
const NATIVE_TO_PROTOCOL_CODE: Record<string, ErrorCode> = {
  OMP_TIMEOUT: "WORKER_RESULT_UNKNOWN",
  OMP_EXITED: "SESSION_RUNTIME_CRASHED",
  OMP_STDIN_ERROR: "SESSION_RUNTIME_CRASHED",
  OMP_PROTOCOL_ERROR: "WORKER_PROTOCOL_MISMATCH",
  SESSION_REPLACED: "SESSION_CONFLICT",
  SUBMISSION_NOT_ADMITTED: "SESSION_BUSY",
  QUEUE_SELECTION_STALE: "STALE_CURSOR",
  OMP_VERSION_UNVERIFIED: "CAPABILITY_DISABLED",
  OMP_SOURCE_MISSING: "CAPABILITY_DISABLED",
  OMP_SOURCE_VERSION_MISMATCH: "CAPABILITY_DISABLED",
}

/** 出站 Problem：保留真实 message，把非协议码翻成协议码并附带原始码。 */
export function workerProblemFromError(error: unknown): Problem {
  const raw = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
  const nativeCode = typeof raw === "string" && raw ? raw : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (nativeCode && isErrorCode(nativeCode)) return { code: nativeCode, message }
  if (!nativeCode) return { code: "INTERNAL", message }
  return {
    code: NATIVE_TO_PROTOCOL_CODE[nativeCode] ?? "INTERNAL",
    message: `${message} (${nativeCode})`,
    details: { nativeCode },
  }
}
