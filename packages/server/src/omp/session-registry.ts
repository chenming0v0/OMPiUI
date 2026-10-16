import { resolve } from "node:path"
import type { WorkerSession } from "./worker-client.ts"

export interface AttachedSession {
  sessionId: string
  cwd: string
  sessionFile?: string
  worker: WorkerSession
}

function sessionFileKey(sessionFile: string): string {
  const normalized = resolve(sessionFile).replace(/\\/g, "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

type RuntimeFlight = {
  promise: Promise<unknown>
  controller: AbortController
  waiters: number
}

export class SessionRuntimeRegistry {
  private readonly sessions = new Map<string, AttachedSession>()
  private readonly openFlights = new Map<string, RuntimeFlight>()
  private readonly attachFlights = new Map<string, RuntimeFlight>()

  get(sessionId: string): AttachedSession | undefined {
    return this.sessions.get(sessionId)
  }

  values(): IterableIterator<AttachedSession> {
    return this.sessions.values()
  }

  keys(): IterableIterator<string> {
    return this.sessions.keys()
  }

  set(session: AttachedSession): void {
    this.sessions.set(session.sessionId, session)
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  findBySessionFile(sessionFile: string): AttachedSession | undefined {
    const key = sessionFileKey(sessionFile)
    return [...this.sessions.values()].find(session => session.sessionFile && sessionFileKey(session.sessionFile) === key)
  }

  async openFlight<T>(sessionFile: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.shareFlight(this.openFlights, sessionFileKey(sessionFile), operation, signal)
  }

  private async shareFlight<T>(
    flights: Map<string, RuntimeFlight>, key: string,
    operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw Object.assign(new Error("request aborted"), { code: "REQUEST_ABORTED" })
    let flight = flights.get(key)
    if (flight?.controller.signal.aborted) {
      // 上一次打开仍可能在清理 runtime；完成前不能重试并争用它的租约。
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener("abort", abort); resolve() }
        const abort = () => {
          signal?.removeEventListener("abort", abort)
          reject(Object.assign(new Error("request aborted"), { code: "REQUEST_ABORTED" }))
        }
        signal?.addEventListener("abort", abort, { once: true })
        void flight!.promise.then(finish, finish)
        if (signal?.aborted) abort()
      })
      return this.shareFlight(flights, key, operation, signal)
    }
    if (!flight) {
      const controller = new AbortController()
      const promise = Promise.resolve().then(() => operation(controller.signal))
      flight = { promise, controller, waiters: 0 }
      flights.set(key, flight)
      const current = flight
      void promise.then(
        () => { if (flights.get(key) === current) flights.delete(key) },
        () => { if (flights.get(key) === current) flights.delete(key) },
      )
    }
    flight.waiters += 1
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = () => signal?.removeEventListener("abort", abort)
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        flight!.waiters -= 1
        cleanup()
        callback()
      }
      const abort = () => finish(() => {
        if (flight!.waiters === 0) {
          flight!.controller.abort()
        }
        reject(Object.assign(new Error("request aborted"), { code: "REQUEST_ABORTED" }))
      })
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener("abort", abort, { once: true })
      flight!.promise.then(
        value => finish(() => resolve(value as T)),
        error => finish(() => reject(error)),
      )
    })
  }

  async attachFlight(sessionId: string, operation: (signal: AbortSignal) => Promise<AttachedSession>, signal?: AbortSignal): Promise<AttachedSession> {
    return this.shareFlight(this.attachFlights, sessionId, operation, signal)
  }
}
