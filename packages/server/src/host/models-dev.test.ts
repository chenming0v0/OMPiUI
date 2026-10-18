import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clearModelsDevCache, lookupModelsDevModel } from "./models-dev.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelsDevCache();
});

describe("models.dev lookup", () => {
  it("maps limits, modalities and effort levels", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          openai: {
            id: "openai",
            name: "OpenAI",
            models: {
              "gpt-test": {
                id: "gpt-test",
                name: "GPT Test",
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["low", "medium", "high"] },
                ],
                modalities: { input: ["text", "image"], output: ["text"] },
                limit: { context: 400_000, output: 128_000 },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const result = await lookupModelsDevModel({
      modelId: "gpt-test",
      providerHint: "openai",
    });
    assert.deepEqual(result, {
      found: true,
      provider: "openai",
      modelId: "gpt-test",
      name: "GPT Test",
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"],
      thinking: {
        mode: "effort",
        efforts: ["low", "medium", "high"],
        defaultLevel: "high",
      },
    });
  });

  it("maps Anthropic budget reasoning and returns misses without throwing", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          anthropic: {
            id: "anthropic",
            models: {
              "claude-test": {
                id: "claude-test",
                reasoning: true,
                reasoning_options: [{ type: "budget_tokens", min: 1024 }],
                limit: { context: 200_000, output: 64_000 },
              },
            },
          },
        }),
        { status: 200 },
      );

    const result = await lookupModelsDevModel({
      modelId: "claude-test",
      providerHint: "anthropic",
      api: "anthropic-messages",
    });
    assert.equal(result.thinking?.mode, "anthropic-budget-effort");
    assert.equal(
      (await lookupModelsDevModel({ modelId: "missing-model" })).found,
      false,
    );
  });

  it("matches a model ID fragment and prefers an exact match", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          openai: {
            id: "openai",
            models: {
              "gpt-6-luna": {
                id: "gpt-6-luna",
                limit: { context: 400_000, output: 128_000 },
              },
              "gpt-6-luna-preview": {
                id: "gpt-6-luna-preview",
                limit: { context: 200_000, output: 32_000 },
              },
            },
          },
        }),
        { status: 200 },
      );

    const partial = await lookupModelsDevModel({
      modelId: "[relay]gpt-6-luna",
      providerHint: "openai",
    });
    assert.equal(partial.found, true);
    assert.equal(partial.modelId, "gpt-6-luna");
    assert.equal(partial.contextWindow, 400_000);

    clearModelsDevCache();
    const exact = await lookupModelsDevModel({
      modelId: "gpt-6-luna-preview",
      providerHint: "openai",
    });
    assert.equal(exact.modelId, "gpt-6-luna-preview");
    assert.equal(exact.contextWindow, 200_000);
  });
});
