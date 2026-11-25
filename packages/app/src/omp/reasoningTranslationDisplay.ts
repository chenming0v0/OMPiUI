export type ReasoningTranslationChunk = { source: string; translation: string }
export type ReasoningTranslationLine = { original: string; translation: string; separator: string; ready: boolean }

const chineseCharacter = /\p{Script=Han}/u

export function buildReasoningTranslationLines(source: string, chunks: readonly ReasoningTranslationChunk[]): ReasoningTranslationLine[] {
  const original = source.split(/(\r?\n)/)
  const lines: ReasoningTranslationLine[] = []
  for (let index = 0; index < original.length; index += 2) {
    lines.push({ original: original[index], translation: '', separator: original[index + 1] ?? '', ready: false })
  }
  let offset = 0
  let lineIndex = 0
  for (const chunk of chunks) {
    if (!chunk.source || !source.startsWith(chunk.source, offset)) break
    const sourceLines = chunk.source.split(/(\r?\n)/)
    const translatedLines = chunk.translation.split(/\r?\n/)
    const lastText = sourceLines.at(-1) ? (sourceLines.length - 1) / 2 : Math.max(0, (sourceLines.length - 3) / 2)
    for (let index = 0; index < sourceLines.length; index++) {
      if (index % 2) { lineIndex++; continue }
      const text = sourceLines[index]
      const translated = index / 2 === lastText && translatedLines.slice(lastText + 1).some(line => line.trim())
        ? translatedLines.slice(index / 2).join('\n').replace(/\n$/, '') : translatedLines[index / 2] ?? ''
      const ready = text.trim().length > 0 && chineseCharacter.test(translated)
      const line = lines[lineIndex]
      if (line) {
        line.translation += ready ? translated : text
        line.ready ||= ready
      }
    }
    offset += chunk.source.length
  }
  // 源区间决定行归属：译文换行不一致也不能移动下一片段或覆盖已提交前缀。
  const tail = source.slice(offset).split(/(\r?\n)/)
  for (let index = 0; index < tail.length; index++) {
    if (index % 2) lineIndex++
    else if (lines[lineIndex]) lines[lineIndex].translation += tail[index]
  }
  return lines
}

export function composeReasoningTranslationLines(lines: readonly ReasoningTranslationLine[], revealedThroughLine: number): string {
  if (!lines.some((line, index) => line.ready && index <= revealedThroughLine)) return ''
  return lines.map((line, index) => (line.ready && index <= revealedThroughLine ? line.translation : line.original) + line.separator).join('')
}
