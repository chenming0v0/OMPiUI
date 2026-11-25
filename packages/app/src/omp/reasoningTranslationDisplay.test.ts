import { describe, expect, it } from 'vitest'
import { buildReasoningTranslationLines, composeReasoningTranslationLines } from './reasoningTranslationDisplay'

function display(source: string, translation: string, revealedThroughLine = Infinity) {
  return composeReasoningTranslationLines(buildReasoningTranslationLines(source, [{ source, translation }]), revealedThroughLine)
}

describe('progressive reasoning translation display', () => {
  it('keeps all original text until a Chinese character arrives', () => {
    expect(display('Inspect Docker logs.\nThen inspect the config.', 'Docker: ')).toBe('')
    expect(display('Inspect Docker logs.\nThen inspect the config.', '\n')).toBe('')
  })

  it('replaces only the line that has received Chinese text', () => {
    const source = 'Inspect Docker logs.\nThen inspect the config.\nPreserve existing behavior.'
    expect(display(source, 'Docker: 检')).toBe('Docker: 检\nThen inspect the config.\nPreserve existing behavior.')
    expect(display(source, 'Docker: 检查日志。\nThen ')).toBe('Docker: 检查日志。\nThen inspect the config.\nPreserve existing behavior.')
    expect(display(source, 'Docker: 检查日志。\n再')).toBe('Docker: 检查日志。\n再\nPreserve existing behavior.')
  })

  it('reveals buffered translations one source line at a time', () => {
    const source = 'First line.\nSecond line.\nThird line.'
    const translation = '第一行。\n第二行。\n第三行。'
    expect(display(source, translation, -1)).toBe('')
    expect(display(source, translation, 0)).toBe('第一行。\nSecond line.\nThird line.')
    expect(display(source, translation, 1)).toBe('第一行。\n第二行。\nThird line.')
    expect(display(source, translation, 2)).toBe(translation)
  })

  it('preserves blank lines, CRLF and untranslated code', () => {
    const source = 'Inspect the config.\r\n\r\nconst enabled = true\r\nFinish the task.'
    expect(display(source, '检查配置。\n\nconst enabled = true\n完')).toBe('检查配置。\r\n\r\nconst enabled = true\r\n完')
  })

  it('keeps the untranslated suffix when a chunk ends inside the same line', () => {
    const lines = buildReasoningTranslationLines('Inspect the config and preserve existing behavior.\nNext line.', [
      { source: 'Inspect the config ', translation: '检查配置' },
    ])
    expect(composeReasoningTranslationLines(lines, 0)).toBe('检查配置and preserve existing behavior.\nNext line.')
  })

  it('keeps earlier completed lines while a later chunk has no Chinese yet', () => {
    const lines = buildReasoningTranslationLines('First line.\nSecond line.\nThird line.', [
      { source: 'First line.\n', translation: '第一行。\n' },
      { source: 'Second line.\nThird line.', translation: 'Second ' },
    ])
    expect(composeReasoningTranslationLines(lines, Infinity)).toBe('第一行。\nSecond line.\nThird line.')
  })
})
