/** 按 UTF-8 字节预算切片，同时保留完整码点和原字符串偏移。 */
export function splitUtf8Text(text: string, maxBytes: number): string[] {
  if (maxBytes < 4)
    throw new RangeError("UTF-8 chunk budget must be at least 4");
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!;
    const size =
      point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) {
      chunks.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += point > 0xffff ? 2 : 1;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

/** 按 JSON 字符串转义后的字节数分片，保留代理对和原文。 */
export function splitJsonText(text: string, maxBytes: number): string[] {
  if (maxBytes < 6) throw new RangeError("JSON chunk budget must be at least 6");
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index)!;
    const cost = code < 0x20
      ? (code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6)
      : code === 0x22 || code === 0x5c ? 2
      : code <= 0x7f ? 1
      : code <= 0x7ff ? 2
      : code >= 0xd800 && code <= 0xdfff ? 6
      : code <= 0xffff ? 3 : 4;
    if (bytes + cost > maxBytes) {
      chunks.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += cost;
    index += code > 0xffff ? 2 : 1;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

export function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const point = text.codePointAt(end)!;
    const size =
      point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += point > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}

export function utf8Suffix(text: string, maxBytes: number): string {
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    let index = start - 1;
    const low = text.charCodeAt(index);
    if (low >= 0xdc00 && low <= 0xdfff && index > 0) index--;
    const point = text.codePointAt(index)!;
    const size =
      point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    start = index;
  }
  return text.slice(start);
}
