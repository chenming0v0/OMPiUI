import type { FileReadResponse } from '@ompiui/protocol'

/** 按实际字符串堆占用计量，失效时保留正文用于条件重验证。 */
export class FilePreviewCache {
  private readonly entries = new Map<string, { value: FileReadResponse; bytes: number; stale: boolean }>()
  private bytes = 0
  private readonly maxBytes: number
  private readonly maxItems: number
  constructor(maxBytes = 16 * 1024 * 1024, maxItems = 32) {
    this.maxBytes = maxBytes
    this.maxItems = maxItems
  }
  get(path: string): FileReadResponse | undefined {
    const item = this.entries.get(path)
    if (!item || item.stale) return undefined
    this.entries.delete(path)
    this.entries.set(path, item)
    return item.value
  }
  peek(path: string): FileReadResponse | undefined { return this.entries.get(path)?.value }
  set(path: string, value: FileReadResponse): void {
    this.delete(path)
    const bytes = value.content.length * 2 + 1024
    if (bytes > this.maxBytes) return
    this.entries.set(path, { value, bytes, stale: false })
    this.bytes += bytes
    while (this.bytes > this.maxBytes || this.entries.size > this.maxItems) this.delete(this.entries.keys().next().value!)
  }
  delete(path: string): void {
    this.bytes -= this.entries.get(path)?.bytes ?? 0
    this.entries.delete(path)
  }
  keys() { return this.entries.keys() }
  invalidateAll(): void { for (const item of this.entries.values()) item.stale = true }
  clear(): void { this.entries.clear(); this.bytes = 0 }
}
