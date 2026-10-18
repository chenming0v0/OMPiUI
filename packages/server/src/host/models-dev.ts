import { TextDecoder } from "node:util";

const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BYTES = 12 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

export type ModelsDevLookupResult = {
  found: boolean;
  provider?: string;
  modelId?: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  thinking?: {
    mode?: "effort" | "anthropic-budget-effort" | "budget";
    efforts?: string[];
    defaultLevel?: string;
  };
};

type ModelsDevProvider = {
  id: string;
  name?: string;
  api?: string;
  models: JsonRecord;
};

let cache: { expiresAt: number; providers: ModelsDevProvider[] } | null = null;
let loading: Promise<ModelsDevProvider[]> | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeModelId(value: string): string {
  return normalize(value)
    .replace(/^\[[^\]]+\]/, "")
    .replace(/[^a-z0-9]/g, "");
}

function providerMatches(provider: ModelsDevProvider, hint: string): boolean {
  const normalizedHint = normalize(hint);
  if (!normalizedHint) return false;
  const candidates = [provider.id, provider.name, provider.api].filter(
    (value): value is string => typeof value === "string",
  );
  return candidates.some((candidate) => {
    const normalized = normalize(candidate);
    return (
      normalized === normalizedHint ||
      normalized.includes(normalizedHint) ||
      normalizedHint.includes(normalized)
    );
  });
}

function parseProviders(payload: unknown): ModelsDevProvider[] {
  if (!isRecord(payload)) return [];
  const providers: ModelsDevProvider[] = [];
  for (const [id, rawProvider] of Object.entries(payload)) {
    if (!isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
    providers.push({
      id,
      name: stringValue(rawProvider.name),
      api: stringValue(rawProvider.api),
      models: rawProvider.models,
    });
  }
  return providers;
}

async function fetchCatalog(): Promise<ModelsDevProvider[]> {
  const response = await fetch(MODELS_DEV_URL, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`models.dev returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_FETCH_BYTES)
    throw new Error("models.dev catalog is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FETCH_BYTES)
    throw new Error("models.dev catalog is too large");
  const text = new TextDecoder().decode(bytes);
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("models.dev returned invalid JSON");
  }
  return parseProviders(payload);
}

async function readCatalog(): Promise<ModelsDevProvider[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.providers;
  if (!loading) {
    loading = fetchCatalog()
      .then((providers) => {
        cache = { providers, expiresAt: Date.now() + CACHE_TTL_MS };
        return providers;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

function findModel(
  providers: ModelsDevProvider[],
  modelId: string,
  providerHint: string | undefined,
): { provider: ModelsDevProvider; model: JsonRecord; id: string } | undefined {
  const normalizedId = normalizeModelId(modelId);
  const preferred = providerHint
    ? providers.filter((provider) => providerMatches(provider, providerHint))
    : [];
  const ordered = [
    ...preferred,
    ...providers.filter((provider) => !preferred.includes(provider)),
  ];
  const matches: Array<{
    provider: ModelsDevProvider;
    model: JsonRecord;
    id: string;
    score: number;
    providerPriority: number;
  }> = [];
  for (const provider of ordered) {
    for (const [id, model] of Object.entries(provider.models)) {
      const modelRecord = isRecord(model) ? model : undefined;
      if (!modelRecord) continue;
      const candidates = [
        id,
        stringValue(modelRecord.id),
        stringValue(modelRecord.canonical_model_id),
      ].filter((value): value is string => Boolean(value));
      const normalizedCandidates = candidates.map(normalizeModelId);
      const exact = normalizedCandidates.some(
        (candidate) => candidate === normalizedId,
      );
      const partial =
        normalizedId.length >= 5 &&
        normalizedCandidates.some(
          (candidate) =>
            candidate.length >= 5 &&
            (candidate.includes(normalizedId) ||
              normalizedId.includes(candidate)),
        );
      if (!exact && !partial) continue;
      const matchLength = Math.max(
        ...normalizedCandidates.map((candidate) =>
          candidate.includes(normalizedId) || normalizedId.includes(candidate)
            ? Math.min(candidate.length, normalizedId.length)
            : 0,
        ),
      );
      matches.push({
        provider,
        model: modelRecord,
        id,
        score: exact ? 1_000_000 + normalizedId.length : matchLength,
        providerPriority: preferred.includes(provider) ? 1 : 0,
      });
    }
  }
  matches.sort(
    (left, right) =>
      right.score - left.score ||
      right.providerPriority - left.providerPriority ||
      right.id.length - left.id.length,
  );
  const match = matches[0];
  return match
    ? { provider: match.provider, model: match.model, id: match.id }
    : undefined;
}

function thinkingFromModel(
  model: JsonRecord,
  api: string | undefined,
): ModelsDevLookupResult["thinking"] {
  const options = Array.isArray(model.reasoning_options)
    ? model.reasoning_options.filter(isRecord)
    : [];
  const effortOption = options.find((option) => option.type === "effort");
  if (effortOption && Array.isArray(effortOption.values)) {
    const efforts = effortOption.values.filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    if (efforts.length > 0) {
      const defaultLevel = efforts.includes("high")
        ? "high"
        : efforts[efforts.length - 1];
      return { mode: "effort", efforts, defaultLevel };
    }
  }
  const budgetOption = options.find(
    (option) => option.type === "budget_tokens",
  );
  if (budgetOption) {
    return {
      mode: api === "anthropic-messages" ? "anthropic-budget-effort" : "budget",
    };
  }
  return undefined;
}

export async function lookupModelsDevModel(params: {
  modelId: string;
  providerHint?: string;
  api?: string;
}): Promise<ModelsDevLookupResult> {
  const modelId = params.modelId.trim();
  if (!modelId) throw new Error("modelId must be a non-empty string");
  const providers = await readCatalog();
  const found = findModel(providers, modelId, params.providerHint);
  if (!found) return { found: false };

  const model = found.model;
  const modalities = isRecord(model.modalities) ? model.modalities : undefined;
  const rawInput = Array.isArray(modalities?.input) ? modalities.input : [];
  const input = rawInput.filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  const limit = isRecord(model.limit) ? model.limit : undefined;
  const result: ModelsDevLookupResult = {
    found: true,
    provider: found.provider.id,
    modelId: found.id,
    ...(stringValue(model.name) ? { name: stringValue(model.name) } : {}),
    ...(positiveInteger(limit?.context) !== undefined
      ? { contextWindow: positiveInteger(limit?.context) }
      : {}),
    ...(positiveInteger(limit?.output) !== undefined
      ? { maxTokens: positiveInteger(limit?.output) }
      : {}),
    ...(typeof model.reasoning === "boolean"
      ? { reasoning: model.reasoning }
      : {}),
    ...(input.length > 0 ? { input: [...new Set(input)] } : {}),
  };
  const thinking = thinkingFromModel(model, params.api);
  if (thinking) result.thinking = thinking;
  return result;
}

export function clearModelsDevCache(): void {
  cache = null;
}
