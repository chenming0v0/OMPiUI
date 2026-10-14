import type { HistoryPrefetchMode } from '../../../omp/historyPagePrefetch'

const FIRST_IDLE_DELAY = 1000
const MAX_IDLE_DELAY = 60_000

/** 快速补货后指数退避；用户再次向上阅读时立即重置节奏。 */
export class HistoryPrefetchScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private idleCallback: number | undefined
  private request: AbortController | undefined
  private delay = FIRST_IDLE_DELAY
  private running = false
  private fastRequested = false
  private paused = false
  private stopped = false
  private readonly read: (mode: HistoryPrefetchMode, signal: AbortSignal) => Promise<boolean>

  constructor(read: (mode: HistoryPrefetchMode, signal: AbortSignal) => Promise<boolean>) {
    this.read = read
  }

  private clearScheduled(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.idleCallback !== undefined) window.cancelIdleCallback(this.idleCallback)
    this.timer = undefined
    this.idleCallback = undefined
  }

  boost(): void {
    if (this.stopped || this.paused) return
    this.delay = FIRST_IDLE_DELAY
    this.clearScheduled()
    if (this.running) {
      this.fastRequested = true
      return
    }
    void this.run('fast')
  }

  pause(): void {
    this.paused = true
    this.fastRequested = false
    this.clearScheduled()
    this.request?.abort()
  }

  resume(): void {
    this.paused = false
    this.boost()
  }

  stop(): void {
    this.stopped = true
    this.pause()
  }

  private async run(mode: HistoryPrefetchMode): Promise<void> {
    this.running = true
    this.request = new AbortController()
    let canContinue = false
    try {
      canContinue = await this.read(mode, this.request.signal)
    } catch {
      // 后台失败暂停，下一次用户阅读时重新快速补货。
    }
    this.running = false
    this.request = undefined
    if (this.stopped || this.paused) return
    if (this.fastRequested) {
      this.fastRequested = false
      void this.run('fast')
      return
    }
    if (!canContinue) return
    const delay = this.delay
    this.delay = Math.min(this.delay * 2, MAX_IDLE_DELAY)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (typeof window.requestIdleCallback === 'function') {
        this.idleCallback = window.requestIdleCallback(() => {
          this.idleCallback = undefined
          void this.run('idle')
        }, { timeout: 1000 })
      } else {
        void this.run('idle')
      }
    }, delay)
  }
}
