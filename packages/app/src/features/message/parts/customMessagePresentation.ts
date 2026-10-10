import type { PiCustomMessageItem } from '../../../omp/domain/index.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function customMessageText(item: PiCustomMessageItem): string {
  return typeof item.content === 'string' ? item.content : item.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

export function readAgentMessage(item: PiCustomMessageItem): { sender: string; body: string } | undefined {
  if (item.customType !== 'irc:incoming') return undefined
  const details = record(item.details)
  const sender = string(details?.from)
  // 原生 details 保留消息正文，不包含提供给模型的应答指令。
  if (sender && typeof details?.message === 'string') return { sender, body: details.message }

  const envelope = /^<irc>\s*\nIncoming IRC message from agent `([^`\n]+)`(?: \(reply to [^\n]+\))?:\n\n([\s\S]*)\n<\/irc>\s*$/.exec(customMessageText(item).trim())
  if (!envelope) return undefined
  const from = envelope[1]
  let body = envelope[2]
  const instructions = [
    `If response expected, reply via \`write\` (\`path: "agent://${from}"\`, \`content: "…"\`); may finish current step first. No one replies on your behalf.`,
    `If response expected, reply via \`write\` (\`path: "agent://${from}"\`, \`content: "…"\`), when available; otherwise what you \`yield\` or say last this turn is delivered to \`${from}\` when you stop.`,
  ]
  for (const instruction of instructions) {
    if (!body.endsWith(instruction)) continue
    body = body.slice(0, -instruction.length).trimEnd()
    const notice = '\n\nSent while waiting/working. Active interruptible wait stopped early for immediate reading.'
    if (body.endsWith(notice)) body = body.slice(0, -notice.length)
    break
  }
  return { sender: from, body }
}

export interface BackgroundJobView {
  id: string
  name: string
  status: string
  durationMs?: number
  duration?: string
  summary?: string
  body: string
  errors: string[]
  fullOutput?: string
  metadata?: Record<string, unknown>
}

function summaryText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().split(/\n\s*\n/)[0]
  const data = record(value)
  if (!data) return undefined
  for (const key of ['summary', 'message', 'description', 'report', 'rootCause', 'result', 'error']) {
    if (typeof data[key] === 'string') return summaryText(data[key])
  }
  return undefined
}

function parsePayload(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return text }
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1]
}

function unwrapDelivery(text: string): string {
  const match = /^<system-notice>\s*\n(?:Background job [^\n]+ has completed\. Resume your work using the result below\.|\d+ background jobs have completed\. Resume your work using the results below\.)\s*\n([\s\S]*)\n<\/system-notice>\s*$/.exec(text.trim())
  return match ? match[1].trim() : text.trim()
}

function jobSections(text: string): Array<{ id?: string; text: string }> {
  const body = unwrapDelivery(text)
  const headers = [...body.matchAll(/^── Job (.+?)(?: \([^\n]*\))? ──[ \t]*$/gm)]
  if (headers.length) {
    return headers.map((header, index) => ({
      id: header[1],
      text: body.slice(header.index! + header[0].length, headers[index + 1]?.index ?? body.length).trim(),
    }))
  }
  return [{ text: body }]
}

function taskBody(text: string) {
  const task = /^<task-result\s+([^>]*)>\s*\n([\s\S]*?)\n<\/task-result>([\s\S]*)$/.exec(text)
  const base = {
    output: text, supplement: '', errors: [] as string[],
    id: task ? attribute(task[1], 'id') : undefined,
    status: task ? attribute(task[1], 'status') : undefined,
    duration: task ? attribute(task[1], 'duration') : undefined,
    fullOutput: undefined as string | undefined,
  }
  if (!task) return base
  const content = task[2]
  const output = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*)\n?<\/\1>/.exec(content)
  if (!output) return base
  const metadata = content.slice(0, output.index) + content.slice(output.index + output[0].length)
  const errors = [...metadata.matchAll(/<(error|abort-reason)>([\s\S]*?)<\/\1>/g)].map(match => match[2].trim())
  const merge = /<merge-summary>\s*\n([\s\S]*?)\n<\/merge-summary>/.exec(metadata)?.[1]
  // 仅移除已知投递脚注，未知尾部内容仍作为结果保留。
  const trailing = task[3].trim().split('\n').filter(line =>
    !/^[^\n]+ is now idle — (?:message it via `write agent:\/\/[^`]+` to follow up; )?transcript at history:\/\/\S+$/.test(line) &&
    !/^Structured output: (?:schema (?:valid|invalid|error)|unavailable)(?:[;:].*)?$/.test(line),
  ).join('\n').trim()
  return {
    ...base, output: output[2].trim(), errors,
    supplement: [merge, trailing].filter(Boolean).join('\n\n'),
    fullOutput: output[1] === 'preview' ? attribute(output[0].slice(0, output[0].indexOf('>')), 'full-output') : undefined,
  }
}

export function readBackgroundJobs(item: PiCustomMessageItem): BackgroundJobView[] | undefined {
  if (item.customType !== 'async-result' && item.customType !== 'Background job') return undefined
  const details = record(item.details)
  const metadata = Array.isArray(details?.jobs) ? details.jobs.map(record).filter(job => job !== undefined) : details ? [details] : []
  const sections = jobSections(customMessageText(item))
  const count = Math.max(metadata.length, sections.length)
  return Array.from({ length: count }, (_, index) => {
    const job = metadata[index] ?? {}
    const id = string(job.jobId) ?? sections[index]?.id ?? String(index + 1)
    const section = sections.find(section => section.id === id) ?? sections[index]
    const result = taskBody(section?.text ?? '')
    const schema = record(job.schema)
    const hasData = schema && Object.hasOwn(schema, 'data')
    const payload = hasData ? schema.data : parsePayload(result.output)
    let body = hasData ? (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) ?? '') : result.output
    // 完整结构化数据可以替换截断预览，但不能覆盖另一份独立文本结果。
    if (hasData && !result.fullOutput && result.output && JSON.stringify(parsePayload(result.output)) !== JSON.stringify(payload)) {
      body += `\n\n${result.output}`
    }
    if (result.supplement) body += `\n\n${result.supplement}`
    const errors = [...new Set([...result.errors, string(schema?.error), string(job.error)].filter((error): error is string => Boolean(error)))]
    return {
      id, name: string(job.label) ?? string(job.jobId) ?? section?.id ?? result.id ?? string(job.type) ?? id,
      status: string(job.status) ?? result.status ?? 'completed',
      durationMs: typeof job.durationMs === 'number' ? job.durationMs : undefined,
      duration: result.duration,
      summary: errors[0] ?? summaryText(payload), body, errors,
      fullOutput: hasData ? undefined : result.fullOutput,
      metadata: record(job.meta),
    }
  })
}
