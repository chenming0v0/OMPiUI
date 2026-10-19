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

  it("does not invent effort levels for budget-only reasoning metadata", async () => {
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
    assert.equal(result.reasoning, true);
    assert.equal(result.thinking, null);
    assert.equal(
      (await lookupModelsDevModel({ modelId: "missing-model" })).found,
      false,
    );
  });

  it("maps provider presets to OMP-native thinking modes and exact effort sets", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          anthropic: {
            id: "anthropic",
            models: {
              "claude-opus-4-6": {
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["low", "medium", "high", "max"] },
                  { type: "budget_tokens", min: 1024 },
                ],
              },
            },
          },
          openai: {
            id: "openai",
            models: {
              "gpt-test": {
                reasoning: true,
                reasoning_options: [
                  {
                    type: "effort",
                    values: ["none", "low", "medium", "high", "xhigh"],
                  },
                ],
              },
            },
          },
          deepseek: {
            id: "deepseek",
            models: {
              "deepseek-test": {
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["low", "high", "max"] },
                ],
              },
            },
          },
          moonshot: {
            id: "moonshot",
            models: {
              "kimi-test": {
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["low", "high", "max"] },
                ],
              },
            },
          },
          zai: {
            id: "zai",
            models: {
              "glm-test": {
                reasoning: true,
                reasoning_options: [{ type: "toggle" }],
              },
            },
          },
          google: {
            id: "google",
            models: {
              "gemini-test": {
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["low", "medium", "high"] },
                ],
              },
            },
          },
          xai: {
            id: "xai",
            models: {
              "grok-test": {
                reasoning: true,
                reasoning_options: [
                  {
                    type: "effort",
                    values: ["low", "medium", "high", "xhigh"],
                  },
                ],
              },
            },
          },
          minimax: {
            id: "minimax",
            models: {
              "MiniMax-M3": { reasoning: true, reasoning_options: [] },
            },
          },
        }),
        { status: 200 },
      );

    const lookups = [
      [
        "claude-opus-4-6",
        "anthropic-messages",
        "anthropic-adaptive",
        ["low", "medium", "high", "max"],
      ],
      [
        "gpt-test",
        "openai-responses",
        "effort",
        ["low", "medium", "high", "xhigh"],
      ],
      ["deepseek-test", "openai-completions", "effort", ["low", "high", "max"]],
      ["kimi-test", "openai-completions", "effort", ["low", "high", "max"]],
      ["glm-test", "openai-completions", null, null],
      [
        "gemini-test",
        "google-generative-ai",
        "google-level",
        ["low", "medium", "high"],
      ],
      [
        "grok-test",
        "openai-responses",
        "effort",
        ["low", "medium", "high", "xhigh"],
      ],
      ["MiniMax-M3", "openai-completions", null, null],
    ] as const;

    for (const [modelId, api, mode, efforts] of lookups) {
      const result = await lookupModelsDevModel({ modelId, api });
      if (mode === null) {
        assert.equal(result.reasoning, true, modelId);
        assert.equal(result.thinking, null, modelId);
      } else {
        assert.equal(result.thinking?.mode, mode, modelId);
        assert.deepEqual(result.thinking?.efforts, efforts, modelId);
      }
    }
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

  it("prefers original provider metadata for custom relays but honors an explicit provider", async () => {
    const model = (efforts: string[]) => ({
      reasoning: true,
      reasoning_options: [{ type: "effort", values: efforts }],
    });
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        requesty: { models: { "gpt-5.4": model(["low", "high", "max"]) } },
        openai: { models: { "gpt-5.4": model(["none", "low", "high", "xhigh"]) } },
      }));

    const original = await lookupModelsDevModel({ modelId: "gpt-5.4", providerHint: "my-relay" });
    assert.equal(original.provider, "openai");
    assert.deepEqual(original.thinking?.efforts, ["low", "high", "xhigh"]);
    const explicit = await lookupModelsDevModel({ modelId: "gpt-5.4", providerHint: "requesty" });
    assert.equal(explicit.provider, "requesty");
    assert.deepEqual(explicit.thinking?.efforts, ["low", "high", "max"]);
  });
});
