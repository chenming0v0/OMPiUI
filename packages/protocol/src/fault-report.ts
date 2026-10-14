export type FaultKind = "runtime_crashed" | "connection_lost" | "server_restarted"

export type FaultNotice = {
  id: string
  kind: FaultKind
  time: string
  sessionId?: string
  errorCode?: string
}

export type FaultReport = {
  content: string
  complete: boolean
  unavailable: string[]
  files: number
}

export type FaultStatus = {
  runId: string
  version: string
  faults: FaultNotice[]
  activeSessionIds?: string[]
}

/** 报告仍须按字段白名单收集；脱敏仅作为输出前的第二道防线。 */
export function redactDiagnosticText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9_./+=%-]+/gi, "$1 [REDACTED]")
    .replace(/((?:["']?(?:authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)["']?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, "[REDACTED]")
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+/g, "[URL REDACTED]")
    .replace(/([a-zA-Z]:[\\/]+Users[\\/]+)[^\\/\s"]+/gi, "$1[USER]")
    .replace(/(\/(?:home|Users)\/)[^/\s"]+/g, "$1[USER]")
}

const encoder = new TextEncoder()

/** 按 UTF-8 字节和行数双重分片，保留全部内容及超长单行，不交给平台截断。 */
export function splitFaultReport(content: string, maxBytes = 9 * 1024 * 1024, maxLines = 24_000, formEncoded = false): string[] {
  if (maxBytes < 4 || maxLines < 1) throw new Error("Invalid report limits")
  const budget = maxBytes - (formEncoded ? 8 : 0)
  if (budget < 12 && formEncoded) throw new Error("Invalid encoded report limit")
  const measure = (text: string) => {
    if (!formEncoded) return encoder.encode(text).byteLength
    let size = 0
    for (const byte of encoder.encode(text)) {
      size += byte >= 0x30 && byte <= 0x39 || byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a || byte === 0x2a || byte === 0x2e || byte === 0x5f || byte === 0x2d || byte === 0x20 ? 1 : 3
    }
    return size
  }
  const parts: string[] = []
  let current = ""
  let bytes = 0
  let lines = 0
  const flush = () => {
    if (current) parts.push(current)
    current = ""
    bytes = 0
    lines = 0
  }
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const size = measure(line)
    if (size <= budget) {
      if (bytes + size > budget || lines >= maxLines) flush()
      current += line
      bytes += size
      lines++
      continue
    }
    flush()
    for (const char of line) {
      const size = measure(char)
      if (bytes + size > budget) flush()
      current += char
      bytes += size
    }
    lines = 1
  }
  flush()
  return parts.length ? parts : ["OMPiUI diagnostic report: no records available."]
}

export type FaultUploadProgress = { links: string[]; total: number; indexUrl?: string }

export async function uploadFaultReport(
  content: string,
  fetchImpl: typeof fetch,
  previous: FaultUploadProgress = { links: [], total: 0 },
  onProgress: (progress: FaultUploadProgress) => void = () => {},
): Promise<FaultUploadProgress> {
  const parts = splitFaultReport(content, 9 * 1024 * 1024, 24_000, true)
  const links = [...previous.links]
  if (links.length > parts.length) throw new Error("Report changed; upload cannot be resumed")
  const publish = async (text: string): Promise<string> => {
    // 此请求绝不使用 OMPiUI 的鉴权 fetch，不能把后端令牌发给第三方。
    const response = await fetchImpl("https://api.mclo.gs/1/log", {
      method: "POST", credentials: "omit", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ content: text }).toString(),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`MCLOG_UPLOAD_HTTP_${response.status}`)
    const body = await response.json() as { success?: boolean; id?: unknown; url?: unknown }
    if (body.success !== true || typeof body.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(body.id) ||
      body.url !== `https://mclo.gs/${body.id}`) throw new Error("MCLOG_UPLOAD_INVALID_RESPONSE")
    return body.url
  }
  for (let index = links.length; index < parts.length; index++) {
    links.push(await publish(parts[index]!))
    onProgress({ links: [...links], total: parts.length })
  }
  const indexUrl = previous.indexUrl ?? (links.length === 1 ? links[0]!
    : await publish(`OMPiUI diagnostic report index\nParts: ${links.length}\n\n${links.map((url, index) => `${index + 1}. ${url}`).join("\n")}`))
  const result = { links, total: parts.length, indexUrl }
  onProgress(result)
  return result
}
