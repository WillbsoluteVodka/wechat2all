import type { LlmLocalConfig } from "./types";

export const LLM_PRESETS = {
  "deepseek-chat": {
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
  },
  "gpt-4.1-mini": {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
  },
} as const;

export type LlmPresetModel = keyof typeof LLM_PRESETS;

export const DEFAULT_LLM_MODEL: LlmPresetModel = "deepseek-chat";

export interface LlmDraftSelection {
  llmProvider: string;
  llmModel: string;
  llmBaseUrl: string;
}

export function isLlmPresetModel(value: string): value is LlmPresetModel {
  return Object.hasOwn(LLM_PRESETS, value);
}

/**
 * A fresh daemon reports provider=mock and model=null. The select still paints
 * its first option in that state, so keep the React draft aligned with what the
 * user actually sees.
 */
export function initialLlmSelection(config: LlmLocalConfig): LlmDraftSelection {
  const model = config.model?.trim() || DEFAULT_LLM_MODEL;
  const preset = isLlmPresetModel(model) ? LLM_PRESETS[model] : undefined;
  return {
    llmProvider: preset?.provider ?? config.provider,
    llmModel: model,
    llmBaseUrl: preset?.baseUrl ?? config.baseUrl,
  };
}

/** Re-derive coupled fields at save time so a stale `mock` draft cannot leak. */
export function normalizedLlmSelection(
  selection: LlmDraftSelection,
): LlmDraftSelection {
  const model = selection.llmModel.trim();
  if (!model) {
    throw new Error("Select an LLM model before saving.");
  }
  const preset = isLlmPresetModel(model) ? LLM_PRESETS[model] : undefined;
  return {
    llmProvider: preset?.provider ?? selection.llmProvider,
    llmModel: model,
    llmBaseUrl: preset?.baseUrl ?? selection.llmBaseUrl,
  };
}
