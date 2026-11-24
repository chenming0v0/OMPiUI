export type ReasoningTranslationChunk = { source: string; translation: string }
export type ReasoningTranslationLine = { original: string; translation: string; separator: string; ready: boolean }

const chineseCharacter = /\p{Script=Han}/u

export function buildReasoningTranslationLines(source: string, chunks: readonly ReasoningTranslationChunk[]): ReasoningTranslationLine[] {
  const original = source.split(/(\r?\n)/)
  const fragments: string[] = []
  const readyLines = new Set<number>()
  let sourceOffset = 0
  let lineIndex = 0
  for (const chunk of chunks) {
    const sourceLines = chunk.source.split(/(\r?\n)/)
    const translatedLines = chunk.translation.split(/\r?\n/)
    for (let index = 0; index < sourceLines.length; index++) {
      const text = sourceLines[index]
      if (index % 2) {
        fragments.push(text)
        lineIndex++
      } else {
        const translated = translatedLines[index / 2] ?? ''
        const ready = text.trim().length > 0 && chineseCharacter.test(translated)
        fragments.push(ready ? translated : text)
        if (ready) readyLines.add(lineIndex)
      }
    }
    sourceOffset += chunk.source.length
  }
  // 分块未覆盖的正文始终保留原文，包括仍在增长的同一行后半段。
  fragments.push(source.slice(sourceOffset))
  const combined = fragments.join('').split(/(\r?\n)/)
  const lines: ReasoningTranslationLine[] = []
  for (let index = 0; index < original.length; index += 2) {
    lines.push({ original: original[index], translation: combined[index], separator: original[index + 1] ?? '', ready: readyLines.has(index / 2) })
  }
  return lines
}

export function composeReasoningTranslationLines(lines: readonly ReasoningTranslationLine[], revealedThroughLine: number): string {
  if (!lines.some((line, index) => line.ready && index <= revealedThroughLine)) return ''
  return lines.map((line, index) => (line.ready && index <= revealedThroughLine ? line.translation : line.original) + line.separator).join('')
}
