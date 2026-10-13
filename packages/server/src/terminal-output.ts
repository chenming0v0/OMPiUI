const OUTPUT_FRAME_BYTES = 32 * 1024;
const OUTPUT_DATA_BYTES = OUTPUT_FRAME_BYTES - 128;

/** JSON 转义的真实成本；输出游标仍使用 UTF-16 字符数。 */
export function splitTerminalOutput(data: string): string[] {
  if (Buffer.byteLength(data) <= OUTPUT_DATA_BYTES && !/[\u0000-\u001f"\\\ud800-\udfff]/.test(data))
    return data ? [data] : [];
  return splitJsonText(data, OUTPUT_DATA_BYTES);
}
import { splitJsonText } from "@ompiui/protocol";
