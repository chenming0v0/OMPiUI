import type { JsonObject, JsonValue } from '@ompiui/protocol'

const BYTE_LIMIT = 8 * 1024 * 1024
const MESSAGE_LIMIT = 2000
type Transcript = { messages: JsonObject[]; pending: string; nextByte: number; bytes: number; truncated: boolean }
type Flight = { controller: AbortController; promise: Promise<JsonValue>; users: number }
const cache = new Map<string, Transcript>()
const flights = new Map<string, Flight>()
const encoder = new TextEncoder()

export function clearSubagentTranscripts(): void {
  for (const flight of flights.values()) flight.controller.abort()
  flights.clear()
  cache.clear()
}

export function readSubagentTranscript(
  key: string,
  fromByte: number | undefined,
  fetchPage: (cursor: number, signal: AbortSignal) => Promise<JsonValue>,
  signal?: AbortSignal,
): Promise<JsonValue> {
  signal?.throwIfAborted()
  const flightKey = JSON.stringify([key, fromByte])
  let flight = flights.get(flightKey)
  if (!flight) {
    const controller = new AbortController()
    flight = { controller, users: 0, promise: Promise.resolve(null) }
    const current = flight
    current.promise = readPages(key, fromByte, fetchPage, controller.signal).finally(() => {
      if (flights.get(flightKey) === current) flights.delete(flightKey)
    })
    flights.set(flightKey, current)
  }
  const current = flight
  current.users++
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (--current.users === 0) {
        current.controller.abort()
        if (flights.get(flightKey) === current) flights.delete(flightKey)
      }
      return true
    }
    const onAbort = () => {
      if (finish()) reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    current.promise.then(value => { if (finish()) resolve(value) }, error => { if (finish()) reject(error) })
  })
}

async function readPages(
  key: string,
  fromByte: number | undefined,
  fetchPage: (cursor: number, signal: AbortSignal) => Promise<JsonValue>,
  signal: AbortSignal,
): Promise<JsonValue> {
  const previous = fromByte === undefined ? cache.get(key) : undefined
  const state: Transcript = previous
    ? { ...previous, messages: [...previous.messages] }
    : { messages: [], pending: '', nextByte: fromByte ?? 0, bytes: 0, truncated: false }
  let downloaded = 0
  let pages = 0
  let reset = false
  let hasMore = false
  do {
    signal.throwIfAborted()
    const page = await fetchPage(state.nextByte, signal)
    signal.throwIfAborted()
    if (!page || typeof page !== 'object' || Array.isArray(page) || typeof page.transcript !== 'string') return page
    if (page.reset) {
      state.messages = []
      state.pending = ''
      state.bytes = 0
      state.truncated = false
      state.nextByte = 0
      reset = true
    }
    downloaded += encoder.encode(page.transcript).byteLength
    pages++
    state.pending += page.transcript
    if (encoder.encode(state.pending).byteLength > BYTE_LIMIT) {
      throw Object.assign(new Error('Subagent transcript line exceeds 8 MiB'), { code: 'FILE_TOO_LARGE' })
    }
    const lines = state.pending.split('\n')
    state.pending = lines.pop() ?? ''
    if (!page.hasMore && state.pending) {
      try {
        JSON.parse(state.pending)
        lines.push(state.pending)
        state.pending = ''
      } catch { /* 未写完的末行保留到下次续读。 */ }
    }
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonObject
        if (entry.type === 'message' && entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message)) {
          state.messages.push(entry.message)
          state.bytes += encoder.encode(JSON.stringify(entry.message)).byteLength
        }
      } catch { /* 跳过非消息及损坏的完整行。 */ }
    }
    while (state.messages.length > MESSAGE_LIMIT || state.bytes > BYTE_LIMIT) {
      state.bytes -= encoder.encode(JSON.stringify(state.messages.shift())).byteLength
      state.truncated = true
    }
    const next = Number(page.nextByte)
    hasMore = Boolean(page.hasMore)
    if (!Number.isSafeInteger(next) || next < 0 || (hasMore && next <= state.nextByte)) {
      throw new Error('Transcript cursor did not advance')
    }
    state.nextByte = next
  } while (hasMore && downloaded < BYTE_LIMIT && pages < 64)
  signal.throwIfAborted()
  cache.delete(key)
  cache.set(key, state)
  while (cache.size > 4) cache.delete(cache.keys().next().value!)
  return {
    messages: state.messages, fromByte: fromByte ?? 0, nextByte: state.nextByte,
    reset, hasMore, truncated: hasMore || state.truncated,
  }
}
