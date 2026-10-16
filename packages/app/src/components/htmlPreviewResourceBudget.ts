import type { FileReadResponse } from '@ompiui/protocol'
import { getFileContent } from '../omp/files'

export const MAX_HTML_INLINE_RESOURCES = 64
export const MAX_HTML_INLINE_BYTES = 8 * 1024 * 1024

/** 读取串行结算剩余额度；CSS、srcset 与重复内联共用同一份预算。 */
export function createHtmlResourceBudget(directory?: string, signal?: AbortSignal) {
  const requests = new Map<string, Promise<FileReadResponse | null>>()
  const encoder = new TextEncoder()
  let queue = Promise.resolve()
  let downloadedBytes = 0
  let inlineBytes = 0
  let truncated = false
  return {
    get truncated() { return truncated },
    inline(value: string): boolean {
      const bytes = encoder.encode(value).byteLength
      if (inlineBytes + bytes > MAX_HTML_INLINE_BYTES) { truncated = true; return false }
      inlineBytes += bytes
      return true
    },
    read(path: string): Promise<FileReadResponse | null> {
      signal?.throwIfAborted()
      const cached = requests.get(path)
      if (cached) return cached
      if (requests.size >= MAX_HTML_INLINE_RESOURCES) { truncated = true; return Promise.resolve(null) }
      const request = queue.then(async () => {
        signal?.throwIfAborted()
        // 为响应信封及拒绝回执保留固定开销，正文预算由服务端在传输前执行。
        downloadedBytes += 512
        const remaining = MAX_HTML_INLINE_BYTES - downloadedBytes
        if (remaining <= 0) { truncated = true; return null }
        try {
          const content = await getFileContent(path, directory, undefined, signal, remaining)
          signal?.throwIfAborted()
          const bytes = encoder.encode(JSON.stringify(content)).byteLength
          if (bytes > remaining) { truncated = true; return null }
          downloadedBytes += bytes
          return content
        } catch (error) {
          signal?.throwIfAborted()
          if (error && typeof error === 'object' && 'code' in error && error.code === 'FILE_TOO_LARGE') truncated = true
          return null
        }
      })
      requests.set(path, request)
      queue = request.then(() => undefined, () => undefined)
      return request
    },
  }
}
