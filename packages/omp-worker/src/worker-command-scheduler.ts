import { jsonByteSize, type JsonObject, type JsonValue } from "@ompiui/protocol"
import { workerProblemFromError } from "./worker-error-problem.js"
import type { WorkerRequest, WorkerResponse } from "./ipc.js"
import type { WorkerIpcSender, WorkerResponseReservation } from "./worker-ipc-sender.js"

export interface SchedulerCommand {
  type: string
  params?: JsonObject
  sessionId?: string
  maxResultBytes?: number
}

// 原生回合与控制确认不能被大磁盘页阻塞；
// 其响应连同错误与交付时间也须预留额度。
const SMALL_RESPONSES: Record<string, true> = {
  prompt: true, steer: true, followUp: true, sendUserMessage: true,
  abort: true, abortBash: true, abortCompaction: true, abortBranchSummary: true, abortRetry: true,
  "session.close": true,
}
const RESPONSE_BYTES = 4 * 1024 * 1024 + 64 * 1024
const CONTROL_RESPONSE_BYTES = 64 * 1024
const LARGE_RESPONSE_COMMANDS: Record<string, true> = {
  removeQueuedMessage: true,
  clearQueue: true,
}

interface ScheduledRequest {
  request: WorkerRequest
  lane: string
  bytes: number
  responseBytes: number
  priority: boolean
  cancelled: boolean
  finished?: boolean
  error?: Error
  reservation?: WorkerResponseReservation
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

export type WorkerCommandScheduler = ((request: WorkerRequest) => Promise<void>) & {
  cancel: (id: string) => void
  cancelAll: () => void
  close: (cleanup: () => Promise<void>, drainTimeoutMs?: number) => Promise<void>
}

/** 保留 SDK 原有并发，仅在执行前排队等待出站容量。 */
export function createWorkerCommandScheduler(
  execute: (command: SchedulerCommand) => Promise<JsonValue | undefined | void>,
  sender: WorkerIpcSender,
  generation: string,
  limits: { maxPending?: number; maxPendingBytes?: number; responseBytes?: number } = {},
): WorkerCommandScheduler {
  const requests = new Map<string, ScheduledRequest>()
  const lanes = new Map<string, ScheduledRequest[]>()
  const executing = new Set<ScheduledRequest>()
  const maxPending = limits.maxPending ?? 1024
  const maxPendingBytes = limits.maxPendingBytes ?? 32 * 1024 * 1024
  const responseBytes = Math.min(limits.responseBytes ?? RESPONSE_BYTES, sender.responseReservationLimit)
  const controlResponseBytes = Math.min(CONTROL_RESPONSE_BYTES, responseBytes)
  let pendingBytes = 0
  let closing = false
  let pumping = false
  let lastLane: string | undefined
  let closePromise: Promise<void> | undefined

  const finish = (job: ScheduledRequest, error?: unknown) => {
    if (job.finished) return
    job.finished = true
    job.reservation?.release()
    requests.delete(job.request.id)
    pendingBytes -= job.bytes
    if (error && !job.cancelled) job.reject(error)
    else job.resolve()
    pump()
  }

  const run = async (job: ScheduledRequest, reservation: WorkerResponseReservation) => {
    let response: WorkerResponse
    try {
      if (job.error) throw job.error
      const envelopeBytes = jsonByteSize({ kind: "response", id: job.request.id, generation, ok: true, data: null }, job.responseBytes) - 4
      const data = await execute({
        ...job.request.command, sessionId: job.request.sessionId,
        maxResultBytes: Math.max(0, job.responseBytes - envelopeBytes),
      })
      if (job.cancelled) return
      response = { kind: "response", id: job.request.id, generation, ok: true, data: data === undefined ? undefined : data }
    } catch (error) {
      if (job.cancelled) return
      response = { kind: "response", id: job.request.id, generation, ok: false, error: workerProblemFromError(error) }
    }
    // 预留持续到 process.send 回调，而非缓存或磁盘读取结束；
    // 已生成的页面不另设等待队列。
    await reservation.send(response)
  }

  const startFromLane = (lane: string, queue: ScheduledRequest[]): boolean => {
    for (let index = 0; index < queue.length; index++) {
      const job = queue[index]!
      // 取消只退还响应预算；底层尚未结束的执行仍占独立槽位。
      if (executing.size >= (job.priority ? 64 : 32)) continue
      const reservation = sender.tryReserveResponse(job.responseBytes, job.priority)
      if (!reservation) continue
      queue.splice(index, 1)
      lanes.delete(lane)
      if (queue.length) lanes.set(lane, queue)
      lastLane = lane
      job.reservation = reservation
      executing.add(job)
      void run(job, reservation).then(
        () => { executing.delete(job); finish(job); pump() },
        error => { executing.delete(job); finish(job, error); pump() },
      )
      return true
    }
    return false
  }

  function pump(): void {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        if (lastLane !== undefined) {
          const previous = lanes.get(lastLane)
          if (previous) {
            lanes.delete(lastLane)
            lanes.set(lastLane, previous)
          }
        }
        let started = false
        for (const [lane, queue] of lanes) {
          if (startFromLane(lane, queue)) {
            started = true
            break
          }
        }
        if (!started) return
      }
    } finally {
      pumping = false
    }
  }

  const unsubscribe = sender.onWritable(pump)
  const schedule = ((request: WorkerRequest): Promise<void> => {
    if (closing) return Promise.reject(Object.assign(new Error("worker scheduler is closing"), { code: "RUNTIME_CLOSING" }))
    if (requests.has(request.id)) return Promise.reject(Object.assign(new Error("duplicate worker request id"), { code: "INVALID_REQUEST" }))
    const bytes = jsonByteSize(request, maxPendingBytes) + 512
    if (requests.size >= maxPending || pendingBytes + bytes > maxPendingBytes) {
      return Promise.reject(Object.assign(new Error("worker request admission capacity reached"), { code: "RATE_LIMITED" }))
    }
    const params = request.command.params
    const lane = request.sessionId ?? (typeof params?.sessionId === "string" ? params.sessionId : "")
    const priority = SMALL_RESPONSES[request.command.type] === true
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const job: ScheduledRequest = {
      request, lane, bytes, priority,
      responseBytes: priority
        ? controlResponseBytes
        : LARGE_RESPONSE_COMMANDS[request.command.type]
          ? sender.responseReservationLimit
          : responseBytes,
      cancelled: false, promise, resolve, reject,
    }
    pendingBytes += bytes
    requests.set(request.id, job)
    const queue = lanes.get(lane)
    if (queue) queue.push(job)
    else lanes.set(lane, [job])
    pump()
    return promise
  }) as WorkerCommandScheduler

  schedule.cancel = (id: string): void => {
    const job = requests.get(id)
    if (!job || job.cancelled) return
    job.cancelled = true
    if (job.reservation) {
      job.reservation.cancel()
      finish(job)
      return
    }
    const queue = lanes.get(job.lane)!
    queue.splice(queue.indexOf(job), 1)
    if (!queue.length) lanes.delete(job.lane)
    finish(job)
  }
  schedule.cancelAll = (): void => {
    // 优先取消排队任务，避免空出的槽位先执行另一任务。
    pumping = true
    try {
      for (const id of requests.keys()) schedule.cancel(id)
    } finally {
      pumping = false
    }
  }

  schedule.close = (cleanup, drainTimeoutMs = 3_000): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    for (const queue of lanes.values()) {
      for (const job of queue) {
        job.error = Object.assign(new Error("worker scheduler is closing"), { code: "RUNTIME_CLOSING" })
        job.responseBytes = controlResponseBytes
        job.priority = true
      }
    }
    let timer: NodeJS.Timeout | undefined
    closePromise = Promise.race([
      Promise.allSettled([...requests.values()].map(job => job.promise)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, drainTimeoutMs); timer.unref?.() }),
    ]).then(async () => {
      clearTimeout(timer)
      unsubscribe()
      schedule.cancelAll()
      await cleanup()
    })
    pump()
    return closePromise
  }
  return schedule
}
