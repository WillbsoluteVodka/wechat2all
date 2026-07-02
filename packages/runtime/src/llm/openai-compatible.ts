import type {
  LLMGenerateOptions,
  LLMMessage,
  LLMProvider,
  LLMResult,
} from "./types.js";

export interface OpenAICompatibleProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  id?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
    type?: string;
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function extractText(resp: ChatCompletionResponse): string {
  const content = resp.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part.text)
      .filter((text): text is string => Boolean(text))
      .join("");
  }
  return "";
}

function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

function createTimeoutSignal(ms: number | undefined): {
  signal?: AbortSignal;
  cancel(): void;
} {
  if (!Number.isFinite(ms) || ms === undefined || ms <= 0) {
    return { cancel() {} };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`LLM request timed out after ${ms}ms`));
  }, ms);
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timeout);
    },
  };
}

function describeFetchError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const cause = err.cause;
  if (
    err.name === "AbortError" ||
    (cause instanceof Error && cause.message.includes("timed out"))
  ) {
    return new Error("LLM request timed out.");
  }
  if (err.message === "fetch failed" && cause instanceof Error) {
    return new Error(`LLM network request failed: ${cause.message}`);
  }
  return err;
}

export function createOpenAICompatibleProvider(
  opts: OpenAICompatibleProviderOptions,
): LLMProvider {
  const baseUrl = trimTrailingSlash(opts.baseUrl ?? "https://api.openai.com/v1");

  return {
    id: opts.id ?? "openai-compatible",
    async generate(
      messages: LLMMessage[],
      options: LLMGenerateOptions = {},
    ): Promise<LLMResult> {
      let resp: Response;
      const timeout = createTimeoutSignal(options.timeoutMs ?? opts.timeoutMs);
      try {
        resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: opts.model,
            messages,
            temperature: options.temperature ?? opts.temperature,
            max_tokens: options.maxTokens ?? opts.maxTokens,
          }),
          signal: mergeAbortSignals(
            options.signal,
            timeout.signal,
          ),
        });
      } catch (err) {
        throw describeFetchError(err);
      } finally {
        timeout.cancel();
      }

      const raw = (await resp.json().catch(() => ({}))) as ChatCompletionResponse;
      if (!resp.ok) {
        throw new Error(
          raw.error?.message ??
            `LLM request failed: ${resp.status} ${resp.statusText}`,
        );
      }

      const text = extractText(raw).trim();
      if (!text) {
        throw new Error("LLM response did not contain text.");
      }
      return { text, raw };
    },
  };
}
