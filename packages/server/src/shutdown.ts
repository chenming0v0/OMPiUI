import type { Server as HttpServer } from "node:http"
import type { WebSocketServer } from "ws"
import { closeEventWebSocket } from "./ws.ts"

export interface ShutdownOptions {
  timeoutMs?: number
  hardStopGraceMs?: number
  cleanupTimeoutMs?: number
  forceExit?: (code: number) => void
  onTimeout?: () => void
  cleanup?: () => Promise<void>
}

export function shutdownAppServer(
  server: HttpServer,
  eventServer: WebSocketServer,
  options: ShutdownOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000
  const hardStopGraceMs = options.hardStopGraceMs ?? 500
  const forceExit = options.forceExit ?? (code => process.exit(code))
  let hardStop: NodeJS.Timeout | undefined
  const deadline = setTimeout(() => {
    options.onTimeout?.()
    server.closeAllConnections()
    hardStop = setTimeout(() => forceExit(1), hardStopGraceMs)
    hardStop.unref()
  }, timeoutMs)
  deadline.unref()

  const closing = Promise.allSettled([
    new Promise<void>((resolve, reject) => {
      closeEventWebSocket(eventServer, error => (error ? reject(error) : resolve()))
    }),
    new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    }),
  ]).then(async results => {
    // 连接排空与 worker 清理使用独立预算，端口已关闭后不能再被 HTTP 短超时误杀。
    clearTimeout(deadline)
    if (hardStop) clearTimeout(hardStop)
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) throw failure.reason
    if (options.cleanup) {
      const cleanupDeadline = setTimeout(() => forceExit(1), options.cleanupTimeoutMs ?? 20_000)
      cleanupDeadline.unref()
      try {
        await options.cleanup()
      } finally {
        clearTimeout(cleanupDeadline)
      }
    }
  })

  void closing.finally(() => {
    clearTimeout(deadline)
    if (hardStop) clearTimeout(hardStop)
  }).catch(() => undefined)
  return closing
}
