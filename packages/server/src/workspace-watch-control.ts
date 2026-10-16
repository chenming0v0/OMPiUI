import { jsonByteSize } from "@ompiui/protocol"

type WatchControl =
  | { type: "configure"; maxWatchDirectories: number; startupDelayMs: number }
  | { type: "sync"; roots: string[] }

/** 只保留最终监听集合，发送回调结算前不再向 IPC 追加控制消息。 */
export class WorkspaceWatchControl {
  private roots: string[] = []
  private version = 0
  private delivered = -1
  private configured = false
  private sending = false
  private closed = false

  constructor(
    private readonly transmit: (message: WatchControl, done: (error?: Error) => void) => void,
    private readonly configuration: { maxWatchDirectories: number; startupDelayMs: number },
    private readonly onError: (error: Error) => void,
  ) {}

  sync(roots: string[]): void {
    const message: WatchControl = { type: "sync", roots }
    if (roots.length > 32 || jsonByteSize(message, 4 * 1024 * 1024) > 4 * 1024 * 1024)
      throw Object.assign(new Error("workspace watch control capacity reached"), { code: "RATE_LIMITED" })
    this.roots = [...roots]
    this.version++
    this.pump()
  }

  dispose(): void { this.closed = true; this.roots = [] }

  private pump(): void {
    if (this.closed || this.sending || this.configured && this.delivered === this.version) return
    const configuring = !this.configured
    const version = this.version
    const message: WatchControl = configuring
      ? { type: "configure", ...this.configuration }
      : { type: "sync", roots: this.roots }
    this.sending = true
    let finished = false
    const done = (error?: Error) => {
      if (finished || this.closed) return
      finished = true
      this.sending = false
      if (error) {
        this.dispose()
        this.onError(error)
        return
      }
      if (configuring) this.configured = true
      else this.delivered = version
      this.pump()
    }
    try { this.transmit(message, done) }
    catch (error) { done(error instanceof Error ? error : new Error(String(error))) }
  }
}
