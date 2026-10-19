import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * `~/.omp/agent/models.yml` 的读写层。
 *
 * OMP 的模型供应商只保存在这个文件里（官方 CLI `omp` 也读它），所以 OMPiUI
 * 的「供应商」设置直接编辑它，而不是另存一份私有配置。读操作永远不抛错
 * （解析失败写进 error 字段让界面展示）；写操作原子替换，并在写前把原文件
 * 备份为 models.yml.bak。
 */

export type ModelsProviderModel = {
  id: string;
  name?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  thinking?: {
    mode?: string;
    efforts?: string[];
    defaultLevel?: string;
    effortMap?: Record<string, string>;
  };
  [key: string]: unknown;
};

export type ModelsProviderConfig = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  authHeader?: boolean;
  models: ModelsProviderModel[];
};

export type ModelsProvidersSnapshot = {
  path: string;
  exists: boolean;
  supported: boolean;
  providers: ModelsProviderConfig[];
  error?: string;
};

export type ModelsProviderFetchResult = {
  models: string[];
  removed: string[];
  total: number;
};

type JsonRecord = Record<string, unknown>;

const CUSTOM_MODEL_APIS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
] as const;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh"];
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" });
}

/** 与 omp-worker 的 ompAgentDirectory 保持一致（官方 CLI 以 PI_CODING_AGENT_DIR 为准）。 */
export function resolveModelsConfigPath(): string {
  const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
  if (profile && profile !== "default") {
    return path.join(
      homedir(),
      ".omp",
      "profiles",
      profile,
      "agent",
      "models.yml",
    );
  }
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = override
    ? path.resolve(override.replace(/^~(?=[\\/]|$)/, homedir()))
    : path.join(homedir(), ".omp", "agent");
  return path.join(agentDir, "models.yml");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function normalizeModelInput(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) return ["text", "image"];
  const filtered = value.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return filtered.length > 0 ? [...new Set(filtered)] : ["text"];
}

function normalizeThinking(
  value: unknown,
): ModelsProviderModel["thinking"] | undefined {
  if (!isRecord(value)) return undefined;
  const thinking: ModelsProviderModel["thinking"] = {};
  const mode = stringValue(value.mode);
  if (mode) thinking.mode = mode;
  if (Array.isArray(value.efforts)) {
    thinking.efforts = value.efforts.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  }
  const defaultLevel = stringValue(value.defaultLevel);
  if (defaultLevel) thinking.defaultLevel = defaultLevel;
  if (isRecord(value.effortMap)) {
    const effortMap: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.effortMap)) {
      if (typeof item === "string") effortMap[key] = item;
    }
    if (Object.keys(effortMap).length > 0) thinking.effortMap = effortMap;
  }
  return Object.keys(thinking).length > 0 ? thinking : undefined;
}

function modelToJson(raw: JsonRecord): ModelsProviderModel {
  const id = stringValue(raw.id) ?? "";
  const model: ModelsProviderModel = { id };
  const name = stringValue(raw.name);
  if (name !== undefined) model.name = name;
  const api = stringValue(raw.api);
  if (api !== undefined) model.api = api;
  const contextWindow = positiveInteger(raw.contextWindow);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxTokens = positiveInteger(raw.maxTokens);
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  if (Array.isArray(raw.input)) {
    const input = raw.input.filter(
      (item): item is "text" | "image" => item === "text" || item === "image",
    );
    if (input.length > 0) model.input = input;
  }
  const thinking = normalizeThinking(raw.thinking);
  if (thinking) model.thinking = thinking;
  if (isRecord(raw.cost)) {
    const cost: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      const value = raw.cost[key];
      if (typeof value === "number" && Number.isFinite(value))
        cost[key] = value;
    }
    if (Object.keys(cost).length > 0) model.cost = cost;
  }
  return model;
}

function providerToJson(id: string, raw: JsonRecord): ModelsProviderConfig {
  const models = Array.isArray(raw.models)
    ? raw.models
        .filter(isRecord)
        .map(modelToJson)
        .filter((model) => model.id.length > 0)
    : [];
  return {
    id,
    name: stringValue(raw.name) ?? id,
    api: stringValue(raw.api) ?? "openai-completions",
    baseUrl: stringValue(raw.baseUrl) ?? "",
    apiKey: stringValue(raw.apiKey) ?? "",
    ...(typeof raw.authHeader === "boolean"
      ? { authHeader: raw.authHeader }
      : {}),
    models,
  };
}

type ParsedDocument = {
  doc: JsonRecord;
  exists: boolean;
  error?: string;
};

async function readDocument(): Promise<ParsedDocument> {
  const file = resolveModelsConfigPath();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { doc: {}, exists: false };
    return {
      doc: {},
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const parsed = parseYaml(text) as unknown;
    if (parsed === null || parsed === undefined)
      return { doc: {}, exists: true };
    if (!isRecord(parsed))
      return { doc: {}, exists: true, error: "models.yml 顶层必须是对象" };
    return { doc: parsed, exists: true };
  } catch (error) {
    return {
      doc: {},
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function providersOf(doc: JsonRecord): JsonRecord {
  return isRecord(doc.providers) ? doc.providers : {};
}

/** 读快照：永不抛错，错误放在 error 里给界面展示。 */
export async function readModelProvidersSnapshot(): Promise<ModelsProvidersSnapshot> {
  const file = resolveModelsConfigPath();
  const { doc, exists, error } = await readDocument();
  const providers = Object.entries(providersOf(doc))
    .filter((entry): entry is [string, JsonRecord] => isRecord(entry[1]))
    .map(([id, raw]) => providerToJson(id, raw))
    .filter((provider) => provider.id.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    path: file,
    exists,
    supported: true,
    providers,
    ...(error ? { error } : {}),
  };
}

function slugifyProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `custom-${Date.now().toString(36)}`;
}

function normalizeApi(value: unknown): (typeof CUSTOM_MODEL_APIS)[number] {
  return CUSTOM_MODEL_APIS.includes(value as (typeof CUSTOM_MODEL_APIS)[number])
    ? (value as (typeof CUSTOM_MODEL_APIS)[number])
    : "openai-completions";
}

function mergeModel(
  existing: JsonRecord | undefined,
  input: JsonRecord,
): JsonRecord {
  const next: JsonRecord = existing ? { ...existing } : {};
  const id = (stringValue(input.id) ?? "").trim();
  next.id = id;
  const name = (stringValue(input.name) ?? "").trim();
  next.name = name || stringValue(existing?.name) || id;
  const contextWindow = positiveInteger(input.contextWindow);
  if (contextWindow !== undefined) next.contextWindow = contextWindow;
  else if (positiveInteger(existing?.contextWindow) === undefined)
    next.contextWindow = DEFAULT_CONTEXT_WINDOW;
  const maxTokens = positiveInteger(input.maxTokens);
  if (maxTokens !== undefined) next.maxTokens = maxTokens;
  else if (positiveInteger(existing?.maxTokens) === undefined)
    next.maxTokens = DEFAULT_MAX_TOKENS;
  if (Array.isArray(input.input)) next.input = normalizeModelInput(input.input);
  else if (!Array.isArray(existing?.input)) next.input = ["text", "image"];

  const reasoning =
    typeof input.reasoning === "boolean" ? input.reasoning : undefined;
  if (reasoning !== undefined) next.reasoning = reasoning;
  if (reasoning === false || input.thinking === null) {
    delete next.thinking;
  } else if (reasoning === true || isRecord(input.thinking)) {
    const previous = isRecord(next.thinking) ? next.thinking : {};
    const thinkingInput = isRecord(input.thinking) ? input.thinking : {};
    const thinking: JsonRecord = { ...previous };
    const mode = stringValue(thinkingInput.mode);
    if (mode) thinking.mode = mode;
    if (!stringValue(thinking.mode)) thinking.mode = "effort";
    if (Array.isArray(thinkingInput.efforts)) {
      const efforts = thinkingInput.efforts.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      );
      if (efforts.length > 0) thinking.efforts = efforts;
    }
    if (
      !Array.isArray(thinking.efforts) ||
      (thinking.efforts as unknown[]).length === 0
    ) {
      thinking.efforts = [...DEFAULT_EFFORTS];
    }
    const defaultLevel = stringValue(thinkingInput.defaultLevel);
    if (defaultLevel) thinking.defaultLevel = defaultLevel;
    if (isRecord(thinkingInput.effortMap)) {
      const effortMap: Record<string, string> = {};
      for (const [key, item] of Object.entries(thinkingInput.effortMap)) {
        if (typeof item === "string") effortMap[key] = item;
      }
      if (Object.keys(effortMap).length > 0) thinking.effortMap = effortMap;
      else delete thinking.effortMap;
    }
    next.thinking = thinking;
  }
  return next;
}

async function writeDocument(doc: JsonRecord): Promise<void> {
  const file = resolveModelsConfigPath();
  await mkdir(path.dirname(file), { recursive: true });
  if (existsSync(file)) await copyFile(file, `${file}.bak`);
  const text = stringifyYaml(doc, { lineWidth: 0 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, text, "utf8");
  await rename(temp, file);
}

let writeChain: Promise<unknown> = Promise.resolve();

/** 串行化写操作：并发的自动保存不能互相覆盖。 */
function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

export function saveModelProvider(
  rawProvider: JsonRecord,
): Promise<ModelsProvidersSnapshot> {
  return withWriteLock(async () => {
    const { doc, error } = await readDocument();
    if (error) throw invalid(`models.yml 解析失败，未写入：${error}`);

    const name = (stringValue(rawProvider.name) ?? "").trim();
    if (!name) throw invalid("params.provider.name must be a non-empty string");
    const baseUrl = (stringValue(rawProvider.baseUrl) ?? "").trim();
    if (!baseUrl)
      throw invalid("params.provider.baseUrl must be a non-empty string");
    const requestedId = (stringValue(rawProvider.id) ?? "").trim();
    const id = requestedId || slugifyProviderId(name);
    if (/[\r\n]/.test(id))
      throw invalid("params.provider.id must not contain newlines");

    const providers = providersOf(doc);
    const existingProvider = isRecord(providers[id])
      ? providers[id]
      : undefined;
    const nextProvider: JsonRecord = { ...(existingProvider ?? {}) };
    nextProvider.name = name;
    nextProvider.api = normalizeApi(rawProvider.api);
    nextProvider.baseUrl = baseUrl;
    if (typeof rawProvider.apiKey === "string")
      nextProvider.apiKey = rawProvider.apiKey.trim();
    else if (!stringValue(existingProvider?.apiKey)) nextProvider.apiKey = "";
    if (typeof rawProvider.authHeader === "boolean")
      nextProvider.authHeader = rawProvider.authHeader;

    const incomingModels = Array.isArray(rawProvider.models)
      ? rawProvider.models.filter(isRecord)
      : [];
    const existingModels = Array.isArray(existingProvider?.models)
      ? (existingProvider?.models as unknown[]).filter(isRecord)
      : [];
    const usedIds = new Set<string>();
    const mergedModels: JsonRecord[] = [];
    for (const incoming of incomingModels) {
      const modelId = (stringValue(incoming.id) ?? "").trim();
      if (!modelId)
        throw invalid("params.provider.models[].id must be a non-empty string");
      const originalId = (stringValue(incoming.originalId) ?? "").trim();
      const previous = existingModels.find((model) => {
        const id = stringValue(model.id);
        return (
          id !== undefined && (originalId ? id === originalId : id === modelId)
        );
      });
      if (usedIds.has(modelId)) throw invalid(`duplicate model id: ${modelId}`);
      usedIds.add(modelId);
      mergedModels.push(mergeModel(previous, incoming));
    }
    nextProvider.models = mergedModels;

    doc.providers = { ...providers, [id]: nextProvider };
    await writeDocument(doc);
    return readModelProvidersSnapshot();
  });
}

export function deleteModelProvider(
  providerId: string,
): Promise<ModelsProvidersSnapshot> {
  return withWriteLock(async () => {
    const { doc, error } = await readDocument();
    if (error) throw invalid(`models.yml 解析失败，未写入：${error}`);
    const providers = providersOf(doc);
    if (!isRecord(providers[providerId]))
      throw Object.assign(new Error(`provider not found: ${providerId}`), {
        code: "NOT_FOUND",
      });
    const nextProviders = { ...providers };
    delete nextProviders[providerId];
    doc.providers = nextProviders;
    await writeDocument(doc);
    return readModelProvidersSnapshot();
  });
}

function modelsUrls(baseUrl: string, api: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (api === "google-generative-ai") {
    if (/\/v1beta$/i.test(base)) return [`${base}/models`];
    return [`${base}/v1beta/models`, `${base}/models`];
  }
  if (/\/v1$/i.test(base)) return [`${base}/models`];
  return [`${base}/v1/models`, `${base}/models`];
}

function upstreamHeaders(api: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    if (api === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (api === "google-generative-ai") {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }
  } else if (api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function extractModelIds(payload: unknown, api: string): string[] {
  let list: unknown[] = [];
  if (Array.isArray(payload)) list = payload;
  else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) list = payload.data;
    else if (Array.isArray(payload.models)) list = payload.models;
  }
  const ids = list
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item)) {
        const id = stringValue(item.id) ?? stringValue(item.name);
        return api === "google-generative-ai"
          ? id?.replace(/^models\//, "")
          : id;
      }
      return undefined;
    })
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

async function fetchModelsAt(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

export async function fetchModelProviderModels(
  params: JsonRecord,
): Promise<ModelsProviderFetchResult> {
  const baseUrl = (stringValue(params.baseUrl) ?? "").trim();
  if (!baseUrl) throw invalid("params.baseUrl must be a non-empty string");
  const api = normalizeApi(params.api);
  const apiKey = (stringValue(params.apiKey) ?? "").trim();
  const knownModelIds = Array.isArray(params.knownModelIds)
    ? params.knownModelIds.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];

  const headers = upstreamHeaders(api, apiKey);
  const urls = modelsUrls(baseUrl, api);
  let lastFailure = "";
  for (const [index, url] of urls.entries()) {
    let response: Response;
    try {
      response = await fetchModelsAt(url, headers);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      if (index + 1 < urls.length) continue;
      break;
    }
    if (!response.ok) {
      const snippet = await response.text().catch(() => "");
      lastFailure = `HTTP ${response.status}${snippet ? ` ${snippet.slice(0, 300)}` : ""}`;
      const retryable = response.status === 404 || response.status === 405;
      if (retryable && index + 1 < urls.length) continue;
      break;
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_FETCH_BYTES)
      throw new Error(`上游模型列表过大（${declared} 字节）`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_FETCH_BYTES) {
      throw new Error("上游模型列表超过 2MB，已拒绝解析");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error("上游返回的不是 JSON");
    }
    const models = extractModelIds(payload, api);
    const modelSet = new Set(models);
    return {
      models,
      removed: knownModelIds.filter((id) => !modelSet.has(id)),
      total: models.length,
    };
  }
  throw new Error(`拉取模型失败：${lastFailure || "无法连接上游"}`);
}
