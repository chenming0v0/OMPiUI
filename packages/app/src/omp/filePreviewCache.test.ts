import { describe, expect, it } from 'vitest'
import { FilePreviewCache } from './filePreviewCache'
import type { FileReadResponse } from '@ompiui/protocol'

const file = (content: string): FileReadResponse => ({
  path: 'file', content, encoding: 'utf-8', type: 'text', mimeType: 'text/plain', size: content.length, etag: 'v1',
})
describe('file preview cache', () => {
  it('evicts least recently used bodies and rejects oversized single previews', () => {
    const cache = new FilePreviewCache(2200, 2)
    cache.set('a', file('a'))
    cache.set('b', file('b'))
    cache.get('a')
    cache.set('c', file('c'))
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBeDefined()
    cache.set('big', file('x'.repeat(2000)))
    expect(cache.get('big')).toBeUndefined()
  })
  it('retains stale bodies only for conditional revalidation', () => {
    const cache = new FilePreviewCache()
    const original = file('original')
    cache.set('a', original)
    cache.invalidateAll()
    expect(cache.get('a')).toBeUndefined()
    expect(cache.peek('a')).toBe(original)
    cache.set('a', original)
    expect(cache.get('a')).toBe(original)
    cache.clear()
    expect(cache.peek('a')).toBeUndefined()
  })
})
