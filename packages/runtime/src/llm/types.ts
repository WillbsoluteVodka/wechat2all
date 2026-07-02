export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LLMResult {
  text: string;
  raw?: unknown;
}

export interface LLMProvider {
  id: string;
  generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions,
  ): Promise<LLMResult>;
}
