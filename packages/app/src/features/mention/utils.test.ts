import { describe, expect, it } from 'vitest'
import {
  detectMentionTrigger,
  getFileName,
  normalizePath,
  toAbsolutePath,
  toFileUrl,
} from './utils'

describe('mention utils', () => {
  it('normalizes paths and extracts file names', () => {
    expect(normalizePath('foo\\bar//baz.ts')).toBe('foo/bar/baz.ts')
    expect(getFileName('foo/bar/baz.ts')).toBe('baz.ts')
  })

  it('converts relative paths and file urls correctly', () => {
    expect(toAbsolutePath('./src/app.ts', '/workspace/project')).toBe('/workspace/project/./src/app.ts')
    expect(toAbsolutePath('', '/workspace/project')).toBe('/workspace/project')
    expect(toFileUrl('/workspace/project/src/app.ts')).toBe('file:///workspace/project/src/app.ts')
    expect(toFileUrl('C:/repo/app.ts')).toBe('file:///C:/repo/app.ts')
  })

  it('detects mention trigger only in valid positions', () => {
    expect(detectMentionTrigger('hello @src/com', 14)).toEqual({ startIndex: 6, query: 'src/com' })
    expect(detectMentionTrigger('email@test.com', 14)).toBeNull()
    expect(detectMentionTrigger('hello @src com', 14)).toBeNull()
  })
})
