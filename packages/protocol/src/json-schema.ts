import type { JsonObject } from "./json.js";

/**
 * 极简 JSON Schema 构造器——协议的 paramsSchema 只用这个子集：
 * type/enum/const/required/properties/items/anyOf/minimum/additionalProperties。
 * worker 和 server 的入参校验（P5）也只实现这个子集。
 */
export const STRING: JsonObject = { type: "string", maxBytes: 8 * 1024 * 1024 };
export const BOOLEAN: JsonObject = { type: "boolean" };
export const NUMBER: JsonObject = { type: "number" };
export const NULL: JsonObject = { type: "null" };
export const ANY_JSON: JsonObject = { maxJsonBytes: 256 * 1024 };
export const STRING_ARRAY: JsonObject = {
  type: "array",
  items: byteString(4096),
  maxItems: 1024,
};

export function byteString(maxBytes: number): JsonObject {
  return { type: "string", maxBytes };
}

export function objectSchema(
  properties: Record<string, JsonObject>,
  required: string[] = [],
  additionalProperties = false,
): JsonObject {
  return { type: "object", additionalProperties, required, properties };
}

export function nullable(schema: JsonObject): JsonObject {
  return { anyOf: [schema, NULL] };
}

export const EMPTY_PARAMS = objectSchema({});

export const IMAGE_INPUT: JsonObject = objectSchema(
  {
    type: { const: "image" },
    data: { type: "string", maxLength: Math.ceil((5 * 1024 * 1024) / 3) * 4 },
    mimeType: STRING,
  },
  ["type", "data", "mimeType"],
);
export const IMAGES: JsonObject = {
  type: "array",
  items: IMAGE_INPUT,
  maxItems: 16,
};

export function pageParams(extra: JsonObject = {}): JsonObject {
  return objectSchema({
    cursor: nullable(STRING),
    limit: { type: "integer", minimum: 1, maximum: 200 },
    maxBytes: { type: "integer", minimum: 1, maximum: 4 * 1024 * 1024 },
    ...extra,
  });
}
