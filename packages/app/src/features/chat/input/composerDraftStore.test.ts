import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '../../attachment'

const image: Attachment = {
  id: 'image-1', type: 'file', displayName: 'photo.png', mime: 'image/png', url: 'data:image/png;base64,aW1hZ2U=',
}
const mention: Attachment = {
  id: 'mention-1', type: 'file', displayName: 'README.md', relativePath: 'README.md',
  textRange: { value: '@README.md', start: 0, end: 10 },
}

// 请求和事务通过微任务完成，用于复现异步恢复与编辑并发；真实 IndexedDB 另做浏览器验证。
function memoryDatabase(records: Map<string, unknown>) {
  const db = {
    transaction: () => {
      const transaction = {
        oncomplete: null as (() => void) | null,
        objectStore: () => ({
          get: (key: string) => {
            const request = { result: undefined as unknown, onsuccess: null as (() => void) | null }
            queueMicrotask(() => {
              request.result = structuredClone(records.get(key))
              request.onsuccess?.()
            })
            return request
          },
          put: (value: unknown, key: string) => { records.set(key, structuredClone(value)) },
          delete: (key: string) => { records.delete(key) },
        }),
      }
      queueMicrotask(() => transaction.oncomplete?.())
      return transaction
    },
  }
  return {
    open: () => {
      const request = { result: db, onsuccess: null as (() => void) | null }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
  }
}

describe('composer draft persistence', () => {
  let records: Map<string, unknown>
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    records = new Map()
    vi.stubGlobal('indexedDB', memoryDatabase(records))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('recovers text after module state is recreated, including an explicitly empty draft', async () => {
    const store = await import('./composerDraftStore')
    store.updateComposerDraft('s1', current => ({ ...current, text: 'not sent yet' }))
    vi.resetModules()
    const restored = await import('./composerDraftStore')
    expect(restored.getComposerDraft('s1').text).toBe('not sent yet')
    restored.updateComposerDraft('s1', current => ({ ...current, text: '' }))
    vi.resetModules()
    const empty = await import('./composerDraftStore')
    expect(empty.hasComposerDraft('s1')).toBe(true)
    expect(empty.getComposerDraft('s1').text).toBe('')
    expect(empty.hasComposerDraft('unknown')).toBe(false)
  })

  it('isolates servers, sessions, and home panes without including credentials', async () => {
    const { composerDraftKey: key } = await import('./composerDraftStore')
    const server = { id: 'local', url: 'http://localhost:8787' }
    expect(key(server, 's1', '/a', 'p1')).toBe(key(server, 's1', '/b', 'p2'))
    expect(key(server, 's1', '', 'p1')).not.toBe(key(server, 's2', '', 'p1'))
    expect(key(server, 's1', '', 'p1')).not.toBe(key({ ...server, id: 'remote' }, 's1', '', 'p1'))
    expect(key(server, null, '/a', 'p1')).not.toBe(key(server, null, '/b', 'p1'))
    expect(key(server, null, '/a', 'p1')).not.toBe(key(server, null, '/a', 'p2'))
    expect(key(server, null, '/a', 'p1')).not.toBe(key(server, 'home', '/a', 'p1'))
  })

  it('moves home drafts to a newly created session and clears only the accepted text', async () => {
    const store = await import('./composerDraftStore')
    store.updateComposerDraft('home', current => ({ ...current, text: 'first prompt' }))
    store.moveComposerDraft('home', 'created-session')
    expect(store.getComposerDraft('home').text).toBe('')
    expect(store.getComposerDraft('created-session').text).toBe('first prompt')
    const submitted = store.getComposerDraft('created-session')
    store.updateComposerDraft('created-session', current => ({ ...current, text: 'next prompt' }))
    store.acceptComposerDraft('created-session', submitted)
    expect(store.getComposerDraft('created-session').text).toBe('next prompt')
    vi.resetModules()
    const restored = await import('./composerDraftStore')
    expect(restored.getComposerDraft('home').text).toBe('')
    expect(restored.getComposerDraft('created-session').text).toBe('next prompt')
  })

  it('ignores malformed saved records', async () => {
    localStorage.setItem('ompiui-composer-draft:broken', '{')
    localStorage.setItem('ompiui-composer-draft:wrong-type', JSON.stringify({ text: 42 }))
    const store = await import('./composerDraftStore')
    expect(store.getComposerDraft('broken').text).toBe('')
    expect(store.getComposerDraft('wrong-type').text).toBe('')
  })

  it('restores image bytes and mention ranges after module state is recreated', async () => {
    const store = await import('./composerDraftStore')
    store.updateComposerDraft('images', () => ({
      text: '@README.md describe this image',
      attachments: [image, mention],
      ready: true,
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const record = JSON.parse(localStorage.getItem('ompiui-composer-draft:images')!)
    expect(record).not.toHaveProperty('attachments')
    expect(record.text).toBe('@README.md describe this image')
    vi.resetModules()
    const restored = await import('./composerDraftStore')
    expect(restored.getComposerDraft('images').ready).toBe(false)
    await restored.hydrateComposerDraft('images')
    expect(restored.getComposerDraft('images').attachments).toEqual([image, mention])
    expect(restored.getComposerDraft('images').ready).toBe(true)
  })

  it('does not replace newer text or attachments with a delayed restore', async () => {
    localStorage.setItem('ompiui-composer-draft:delayed', JSON.stringify({ text: 'old text', attachmentRevision: 'old' }))
    records.set('delayed', { revision: 'old', attachments: [image] })
    const store = await import('./composerDraftStore')
    const restore = store.hydrateComposerDraft('delayed')
    store.updateComposerDraft('delayed', current => ({ ...current, text: 'new text', attachments: [mention] }))
    await restore
    expect(store.getComposerDraft('delayed')).toEqual({ text: 'new text', attachments: [mention], ready: true })
  })

  it('keeps edits to text made during attachment restoration', async () => {
    localStorage.setItem('ompiui-composer-draft:typing', JSON.stringify({ text: 'old text', attachmentRevision: 'saved' }))
    records.set('typing', { revision: 'saved', attachments: [image] })
    const store = await import('./composerDraftStore')
    const restore = store.hydrateComposerDraft('typing')
    store.updateComposerDraft('typing', current => ({ ...current, text: 'new text' }))
    await restore
    expect(store.getComposerDraft('typing')).toEqual({ text: 'new text', attachments: [image], ready: true })
  })

  it('never revives old attachments when the saved index belongs to a different revision', async () => {
    localStorage.setItem('ompiui-composer-draft:stale', JSON.stringify({ text: 'new text', attachmentRevision: 'new' }))
    records.set('stale', { revision: 'old', attachments: [image] })
    const store = await import('./composerDraftStore')
    await store.hydrateComposerDraft('stale')
    expect(store.getComposerDraft('stale').attachments).toEqual([])
  })

  it('clears accepted attachments while preserving new ones, and persists the result', async () => {
    const store = await import('./composerDraftStore')
    store.updateComposerDraft('send', () => ({ text: 'submitted', attachments: [image], ready: true }))
    const submitted = store.getComposerDraft('send')
    store.updateComposerDraft('send', () => ({ text: 'next draft', attachments: [image, mention], ready: true }))
    store.acceptComposerDraft('send', submitted)
    expect(store.getComposerDraft('send').attachments).toEqual([mention])
    await new Promise(resolve => setTimeout(resolve, 0))
    vi.resetModules()
    const restored = await import('./composerDraftStore')
    await restored.hydrateComposerDraft('send')
    expect(restored.getComposerDraft('send')).toEqual({ text: 'next draft', attachments: [mention], ready: true })
    restored.acceptComposerDraft('send', restored.getComposerDraft('send'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(records.has('send')).toBe(false)
    expect(restored.getComposerDraft('send')).toEqual({ text: '', attachments: [], ready: true })
  })
})
