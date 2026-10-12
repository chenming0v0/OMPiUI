/** 按 UTF-8 字节预算切片，同时保留完整码点和原字符串偏移。 */
export function splitUtf8Text(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new RangeError("UTF-8 chunk budget must be at least 4")
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes + size > maxBytes) {
      chunks.push(text.slice(start, index))
      start = index
      bytes = 0
    }
    bytes += size
    index += point > 0xffff ? 2 : 1
  }
  if (start < text.length) chunks.push(text.slice(start))
  return chunks
}
