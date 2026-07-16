import assert from "node:assert/strict";
import { test } from "node:test";

import type { LLMProvider } from "@wechat2all/runtime";

import { LlmHealthService } from "../src/llm-health.js";

test("LLM health reports a missing API key without making a request", async () => {
  let providerCreated = false;
  const service = new LlmHealthService({
    env: {
      WECHAT2ALL_LLM_PROVIDER: "openai-compatible",
      WECHAT2ALL_LLM_MODEL: "deepseek-chat",
    },
    createProvider() {
      providerCreated = true;
      throw new Error("provider should not be created");
    },
  });

  const result = await service.check();

  assert.equal(providerCreated, false);
  assert.equal(result.status, "not-configured");
  assert.equal(result.apiKeyConfigured, false);
  assert.equal(result.configured, false);
  assert.equal(result.usable, false);
  assert.equal(result.error?.code, "api_key_missing");
});

test("LLM health sends a minimal request and reports a usable key", async () => {
  const calls: Array<{ messages: unknown; options: unknown }> = [];
  const times = [1_000, 1_037];
  const provider: LLMProvider = {
    id: "test-provider",
    async generate(messages, options) {
      calls.push({ messages, options });
      return { text: "OK" };
    },
  };
  const service = new LlmHealthService({
    env: {
      WECHAT2ALL_LLM_PROVIDER: "openai-compatible",
      WECHAT2ALL_LLM_API_KEY: "sk-test-secret",
      WECHAT2ALL_LLM_MODEL: "deepseek-chat",
    },
    timeoutMs: 1_234,
    createProvider: () => provider,
    now: () => times.shift() ?? 1_037,
  });

  const result = await service.check();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    options: { maxTokens: 8, timeoutMs: 1_234 },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.apiKeyConfigured, true);
  assert.equal(result.configured, true);
  assert.equal(result.usable, true);
  assert.equal(result.latencyMs, 37);
  assert.equal(result.error, null);
  assert.equal(JSON.stringify(result).includes("sk-test-secret"), false);
});

test("LLM health returns provider failures without exposing the API key", async () => {
  const apiKey = "sk-sensitive-health-key";
  const service = new LlmHealthService({
    env: {
      WECHAT2ALL_LLM_PROVIDER: "openai-compatible",
      WECHAT2ALL_LLM_API_KEY: apiKey,
      WECHAT2ALL_LLM_MODEL: "broken-model",
    },
    createProvider: () => ({
      id: "failing-provider",
      async generate() {
        throw new Error(`Provider rejected ${apiKey}`);
      },
    }),
  });

  const result = await service.check();

  assert.equal(result.status, "error");
  assert.equal(result.apiKeyConfigured, true);
  assert.equal(result.configured, true);
  assert.equal(result.usable, false);
  assert.equal(result.error?.code, "request_failed");
  assert.match(result.error?.message ?? "", /\[redacted\]/);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test("concurrent LLM health requests share one provider call", async () => {
  let providerCalls = 0;
  let finish: (() => void) | undefined;
  const providerResult = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = new LlmHealthService({
    env: {
      WECHAT2ALL_LLM_PROVIDER: "openai-compatible",
      WECHAT2ALL_LLM_API_KEY: "sk-test-secret",
      WECHAT2ALL_LLM_MODEL: "deepseek-chat",
    },
    createProvider: () => ({
      id: "slow-provider",
      async generate() {
        providerCalls += 1;
        await providerResult;
        return { text: "OK" };
      },
    }),
  });

  const first = service.check();
  const second = service.check();

  assert.equal(first, second);
  assert.equal(service.snapshot().status, "checking");
  finish?.();
  await first;
  assert.equal(providerCalls, 1);
  assert.equal(service.snapshot().status, "ready");
});
