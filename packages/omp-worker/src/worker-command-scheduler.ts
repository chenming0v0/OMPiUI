import { jsonByteSize, problemFromError, type JsonObject, type JsonValue } from "@ompiui/protocol"
import type { WorkerRequest, WorkerResponse } from "./ipc.js"
import type { WorkerIpcSender, WorkerResponseReservation } from "./worker-ipc-sender.js"

export interface SchedulerCommand {
  type: string
  params?: JsonObject
  sessionId?: string
}

// Native turn/control acknowledgements must not wait behind a large disk page.
// Their response budget is reserved as well, including errors and delivery time.
const SMALL_RESPONSES: Record<string, true> = {
  prompt: true, steer: true, followUp: true, sendUserMessage: true,
  abort: true, abortBash: true, abortCompaction: true, abortBranchSummary: true, abortRetry: true,
  "session.close": true,
}
const RESPONSE_BYTES = 4 * 1024 * 1024 + 64 * 1024
const CONTROL_RESPONSE_BYTES = 64 * 1024

interface ScheduledRequest {
  request: WorkerRequest
  lane: string
  bytes: number
  responseBytes: number
  priority: boolean
  cancelled: boolean
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

/** SDK concurrency stays native; only output-capacity admission is queued, before execution. */
export function createWorkerCommandScheduler(
  execute: (command: SchedulerCommand) => Promise<JsonValue | undefined | void>,
  sender: WorkerIpcSender,
  generation: string,
  limits: { maxPending?: number; maxPendingBytes?: number; responseBytes?: number } = {},
): WorkerCommandScheduler {
  const requests = new Map<string, ScheduledRequest>()
  const lanes = new Map<string, ScheduledRequest[]>()
  const maxPending = limits.maxPending ?? 1024
  const maxPendingBytes = limits.maxPendingBytes ?? 32 * 1024 * 1024
  const responseBytes = Math.min(limits.responseBytes ?? RESPONSE_BYTES, sender.responseByteLimit)
  const controlResponseBytes = Math.min(CONTROL_RESPONSE_BYTES, responseBytes)
  let pendingBytes = 0
  let closing = false
  let pumping = false
  let lastLane: string | undefined
  let closePromise: Promise<void> | undefined

  const finish = (job: ScheduledRequest, error?: unknown) => {
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
      const data = await execute({ ...job.request.command, sessionId: job.request.sessionId })
      if (job.cancelled) return
      response = { kind: "response", id: job.request.id, generation, ok: true, data: data === undefined ? undefined : data }
    } catch (error) {
      if (job.cancelled) return
      response = { kind: "response", id: job.request.id, generation, ok: false, error: problemFromError(error) }
    }
    // The reservation is held until process.send's callback, not just until a
    // cached/disk producer finishes. There is no waiting queue of produced pages.
    await reservation.send(response)
  }

  const startFromLane = (lane: string, queue: ScheduledRequest[]): boolean => {
    for (let index = 0; index < queue.length; index++) {
      const job = queue[index]!
      const reservation = sender.tryReserveResponse(job.responseBytes, job.priority)
      if (!reservation) continue
      queue.splice(index, 1)
      lanes.delete(lane)
      if (queue.length) lanes.set(lane, queue)
      lastLane = lane
      job.reservation = reservation
      void run(job, reservation).then(() => finish(job), error => finish(job, error))
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
      request, lane, bytes, priority, responseBytes: priority ? controlResponseBytes : responseBytes,
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
      return
    }
    const queue = lanes.get(job.lane)!
    queue.splice(queue.indexOf(job), 1)
    if (!queue.length) lanes.delete(job.lane)
    finish(job)
  }
  schedule.cancelAll = (): void => {
    // Cancel queued jobs first without allowing a freed slot to execute another.
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
