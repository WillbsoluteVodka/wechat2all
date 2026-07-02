import type { LLMMessage, LLMProvider, LLMResult } from "./types.js";

export interface MockLLMProviderOptions {
  id?: string;
  response?: string | ((messages: LLMMessage[]) => string | Promise<string>);
}

function lastUserMessage(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

export function createMockLLMProvider(
  opts: MockLLMProviderOptions = {},
): LLMProvider {
  return {
    id: opts.id ?? "mock",
    async generate(messages): Promise<LLMResult> {
      if (typeof opts.response === "function") {
        return { text: await opts.response(messages) };
      }
      if (typeof opts.response === "string") {
        return { text: opts.response };
      }
      return {
        text:
          "[mock llm] 我已经收到消息，但还没有配置真实 LLM API key。\n" +
          `你刚才说：${lastUserMessage(messages) || "(empty)"}`,
      };
    },
  };
}
