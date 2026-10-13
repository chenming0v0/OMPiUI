import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { JsonObject, JsonValue } from "./json.js";

export type SubagentBlockRef = {
  fromByte: number;
  nextByte: number;
  hash: string;
};

export type SubagentSyncRequest = {
  version: 1;
  snapshot?: string;
  knownBlocks: SubagentBlockRef[];
};

export type SubagentDataBlock = SubagentBlockRef & {
  kind: "data";
  messages: JsonObject[];
  previewTruncated: boolean;
};

export type SubagentSyncPage = {
  syncVersion: 1;
  snapshot: string;
  projection: string;
  blocks: (
    | SubagentDataBlock
    | (SubagentBlockRef & { kind: "reuse"; previewTruncated: boolean })
  )[];
  fromByte: number;
  nextByte: number;
  hasMore: boolean;
  reset: boolean;
};

// 只规范化协议中的 JSON 数据；undefined 对象字段与 JSON 序列化保持一致。
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function subagentDigest(value: JsonValue): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))))}`;
}

export function subagentBlockHash(
  projection: string,
  block: {
    fromByte: number;
    nextByte: number;
    messages: JsonObject[];
    previewTruncated: boolean;
  },
): string {
  return subagentDigest({
    version: 1,
    projection,
    fromByte: block.fromByte,
    nextByte: block.nextByte,
    messages: block.messages,
    previewTruncated: block.previewTruncated,
  });
}
