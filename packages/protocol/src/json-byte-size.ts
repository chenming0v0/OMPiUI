/**
 * 有界计量 JSON 字节，不创建整份序列化字符串；超过预算即返回 budget + 1。
 * 不实现 toJSON：线上载荷是 JsonValue（无 Date/Map/Set），Buffer 方向为高估。
 * 不要用"Date 少计 13 倍"这类离线语义差异推断预算会被击穿。
 */
export function jsonByteSize(value: unknown, budget: number): number {
  let bytes = 0;
  const add = (size: number) => {
    bytes = Math.min(budget + 1, bytes + size);
  };
  const string = (text: string) => {
    if (text.length + 2 > budget - bytes) {
      bytes = budget + 1;
      return;
    }
    add(2);
    for (let index = 0; index < text.length && bytes <= budget; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || code === 8 || code === 9 ||
          code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index++;
        } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (item: unknown): void => {
    if (bytes > budget) return;
    if (typeof item === "string") return string(item);
    if (item === null || item === undefined) return add(4);
    if (typeof item === "boolean") return add(item ? 4 : 5);
    if (typeof item === "number") return add(String(Number.isFinite(item) ? item : null).length);
    if (Array.isArray(item)) {
      add(2);
      for (let index = 0; index < item.length && bytes <= budget; index++) {
        if (index) add(1);
        visit(item[index]);
      }
      return;
    }
    if (typeof item === "object") {
      add(2);
      let first = true;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        const field = (item as Record<string, unknown>)[key];
        if (field === undefined || typeof field === "function" || typeof field === "symbol") continue;
        if (!first) add(1);
        first = false;
        string(key);
        add(1);
        visit(field);
        if (bytes > budget) break;
      }
    }
  };
  visit(value);
  return bytes;
}
