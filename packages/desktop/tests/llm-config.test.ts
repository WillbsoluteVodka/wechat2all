import assert from "node:assert/strict";
import test from "node:test";

import {
  initialLlmSelection,
  normalizedLlmSelection,
} from "../src/llm-config.js";

test("fresh config uses the real DeepSeek preset shown in the select", () => {
  const selection = initialLlmSelection({
    provider: "mock",
    apiKey: { configured: false, masked: null },
    model: null,
    baseUrl: "https://api.openai.com/v1",
    temperature: null,
    maxTokens: null,
    timeoutMs: null,
  });

  assert.deepEqual(selection, {
    llmProvider: "openai-compatible",
    llmModel: "deepseek-chat",
    llmBaseUrl: "https://api.deepseek.com/v1",
  });
});

test("save derives provider and base URL from the selected model", () => {
  assert.deepEqual(
    normalizedLlmSelection({
      llmProvider: "mock",
      llmModel: "gpt-4.1-mini",
      llmBaseUrl: "https://wrong.example/v1",
    }),
    {
      llmProvider: "openai-compatible",
      llmModel: "gpt-4.1-mini",
      llmBaseUrl: "https://api.openai.com/v1",
    },
  );
});

test("save rejects a genuinely empty model", () => {
  assert.throws(
    () => normalizedLlmSelection({
      llmProvider: "mock",
      llmModel: " ",
      llmBaseUrl: "https://api.openai.com/v1",
    }),
    /Select an LLM model/,
  );
});
