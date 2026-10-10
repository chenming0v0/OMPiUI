const SECRET_KEY = /authorization|cookie|token|password|secret|api[-_]?key|credential|ticket|^pair$|^key$/i
const PREVIEW_LIMIT = 4096
const encoder = new TextEncoder()
const byteCountBuffer = new Uint8Array(64 * 1024)

export function redactTrafficUrl(input: string): { url: string; server: string; path: string } {
  const url = new URL(input, typeof location === 'undefined' ? 'http://localhost' : location.origin)
  url.username = ''
  url.password = ''
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_KEY.test(key)) url.searchParams.set(key, '[redacted]')
  }
  return { url: url.toString(), server: url.origin.replace(/^ws/, 'http'), path: url.pathname }
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|ticket|key|pair|secret)=)[^&\s"<>]+/gi, '$1[redacted]')
}

export function trafficPreview(value: unknown): string {
  let remaining = 120
  const visit = (item: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 10) return '[truncated]'
    if (typeof item === 'string') return redactText(item.slice(0, 1024)) + (item.length > 1024 ? ' [truncated]' : '')
    if (!item || typeof item !== 'object') return item
    if (Array.isArray(item)) return item.slice(0, 20).map(child => visit(child, depth + 1))
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(item).slice(0, 30)) {
      result[key] = SECRET_KEY.test(key) ? '[redacted]' : visit(child, depth + 1)
    }
    return result
  }
  const text =
    typeof value === 'string'
      ? redactText(value.slice(0, PREVIEW_LIMIT))
      : (JSON.stringify(visit(value, 0), null, 2) ?? '')
  return text.slice(0, PREVIEW_LIMIT) + (text.length >= PREVIEW_LIMIT ? '\n[truncated]' : '')
}

export function textBodyPreview(text: string): string {
  // 大载荷不额外解析全文；不完整 JSON 也不保存可能含凭证的原始片段。
  if (text.length > 64 * 1024) return '[large payload omitted]'
  try {
    return trafficPreview(JSON.parse(text))
  } catch {
    return '[non-JSON payload omitted]'
  }
}

export function payloadBytes(data: unknown): number | null {
  if (data == null) return 0
  if (typeof data === 'string') {
    // 复用小缓冲计量 UTF-8，避免每个大流式帧都分配一份同等大小的字节数组。
    let offset = 0
    let bytes = 0
    while (offset < data.length) {
      const result = encoder.encodeInto(offset ? data.slice(offset) : data, byteCountBuffer)
      offset += result.read
      bytes += result.written
    }
    return bytes
  }
  if (data instanceof Blob) return data.size
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength
  if (data instanceof URLSearchParams) return payloadBytes(data.toString())
  return null
}
