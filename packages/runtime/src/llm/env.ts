import { createMockLLMProvider } from "./mock.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { LLMProvider } from "./types.js";

export interface EnvLLMProviderOptions {
  env?: Record<string, string | undefined>;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function createLLMProviderFromEnv(
  opts: EnvLLMProviderOptions = {},
): LLMProvider {
  const env = opts.env ?? process.env;
  const provider = env.WECHAT2ALL_LLM_PROVIDER;
  const apiKey = env.WECHAT2ALL_LLM_API_KEY;
  const model = env.WECHAT2ALL_LLM_MODEL;
  const baseUrl = env.WECHAT2ALL_LLM_BASE_URL;

  if (
    provider === "openai-compatible" ||
    (!provider && apiKey && model)
  ) {
    if (!apiKey || !model) {
      throw new Error(
        "WECHAT2ALL_LLM_API_KEY and WECHAT2ALL_LLM_MODEL are required for openai-compatible LLM.",
      );
    }
    return createOpenAICompatibleProvider({
      apiKey,
      model,
      baseUrl,
      temperature: positiveNumber(env.WECHAT2ALL_LLM_TEMPERATURE),
      maxTokens: positiveNumber(env.WECHAT2ALL_LLM_MAX_TOKENS),
      timeoutMs: positiveNumber(env.WECHAT2ALL_LLM_TIMEOUT_MS),
    });
  }

  return createMockLLMProvider();
}
