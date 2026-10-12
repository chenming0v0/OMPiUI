import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSubagentTranscripts, readSubagentTranscript } from './subagentTranscript'

afterEach(clearSubagentTranscripts)
const line = (text: string) => `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: text } })}\n`

describe('subagent transcript cursor cache', () => {
  it('continues from zero after the file is truncated and reset', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ transcript: line('old'), nextByte: 500, hasMore: false })
      .mockResolvedValueOnce({ transcript: line('replacement'), reset: true, nextByte: 100, hasMore: true })
      .mockResolvedValueOnce({ transcript: line('new'), nextByte: 200, hasMore: false })
    await readSubagentTranscript('child', undefined, fetch)
    expect(await readSubagentTranscript('child', undefined, fetch)).toMatchObject({
      reset: true, messages: [{ content: 'replacement' }, { content: 'new' }],
    })
    expect(fetch.mock.calls[2][0]).toBe(100)
  })

  it('retains complete messages and an unfinished JSONL tail between expansions', async () => {
    const complete = line('one')
    const second = line('two')
    const fetch = vi.fn().mockResolvedValueOnce({ transcript: complete + second.slice(0, 15), nextByte: 100, hasMore: false })
      .mockResolvedValueOnce({ transcript: second.slice(15), nextByte: 200, hasMore: false })
    expect(await readSubagentTranscript('child', undefined, fetch)).toMatchObject({ messages: [{ content: 'one' }] })
    expect(await readSubagentTranscript('child', undefined, fetch)).toMatchObject({ messages: [{ content: 'one' }, { content: 'two' }] })
    expect(fetch.mock.calls[1][0]).toBe(100)
  })

  it('shares a flight but canceling one pane does not cancel another', async () => {
    let resolve!: (value: { transcript: string; nextByte: number; hasMore: boolean }) => void
    let shared!: AbortSignal
    const fetch = vi.fn((_cursor: number, signal: AbortSignal) => {
      shared = signal
      return new Promise<{ transcript: string; nextByte: number; hasMore: boolean }>(done => { resolve = done })
    })
    const pane = new AbortController()
    const one = readSubagentTranscript('child', undefined, fetch, pane.signal)
    const two = readSubagentTranscript('child', undefined, fetch)
    const rejection = expect(one).rejects.toMatchObject({ name: 'AbortError' })
    pane.abort()
    await rejection
    expect(shared.aborted).toBe(false)
    resolve({ transcript: line('shared'), nextByte: 100, hasMore: false })
    expect(await two).toMatchObject({ messages: [{ content: 'shared' }] })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
