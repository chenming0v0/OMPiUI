import { expect, it } from 'vitest'
import { assertAttachmentBudget, FILE_BYTE_LIMIT, TOTAL_FILE_BYTE_LIMIT } from './attachmentBudget'

it('rejects oversized files and cumulative uploads before reading them', () => {
  expect(() => assertAttachmentBudget(FILE_BYTE_LIMIT, 0)).not.toThrow()
  expect(() => assertAttachmentBudget(FILE_BYTE_LIMIT + 1, 0)).toThrow()
  expect(() => assertAttachmentBudget(1, TOTAL_FILE_BYTE_LIMIT)).toThrow()
})
