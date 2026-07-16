import {
  createLLMProviderFromEnv,
  type LLMProvider,
} from "@wechat2all/runtime";

const DEFAULT_CHECK_TIMEOUT_MS = 15_000;
const CHECK_PROMPT = "Reply with exactly: OK";

export type LlmHealthStatus =
  | "idle"
  | "checking"
  | "not-configured"
  | "ready"
  | "error";

export type LlmHealthErrorCode =
  | "api_key_missing"
  | "model_missing"
  | "provider_unsupported"
  | "request_failed";

export interface LlmHealthError {
  code: LlmHealthErrorCode;
  message: string;
}

export interface LlmHealthSnapshot {
  status: LlmHealthStatus;
  provider: string;
  model: string | null;
  apiKeyConfigured: boolean;
  configured: boolean;
  usable: boolean;
  checkedAt: string | null;
  latencyMs: number | null;
  error: LlmHealthError | null;
}

export interface LlmHealthServiceOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  createProvider?: (env: NodeJS.ProcessEnv) => LLMProvider;
  now?: () => number;
  onResult?: (result: LlmHealthSnapshot) => void;
}

interface LlmConfiguration {
  provider: string;
  model: string | null;
  apiKey: string | null;
  apiKeyConfigured: boolean;
  configured: boolean;
}

function normalized(value: string | undefined): string | null {
  const result = value?.trim();
  return result || null;
}

function readConfiguration(env: NodeJS.ProcessEnv): LlmConfiguration {
  const apiKey = normalized(env.WECHAT2ALL_LLM_API_KEY);
  const model = normalized(env.WECHAT2ALL_LLM_MODEL);
  const configuredProvider = normalized(env.WECHAT2ALL_LLM_PROVIDER);
  const provider = configuredProvider ??
    (apiKey && model ? "openai-compatible" : "mock");
  const apiKeyConfigured = Boolean(apiKey);

  return {
    provider,
    model,
    apiKey,
    apiKeyConfigured,
    configured:
      provider === "openai-compatible" && apiKeyConfigured && Boolean(model),
  };
}

function sanitizeError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw.split(apiKey).join("[redacted]").trim();
  return (redacted || "Unknown LLM health-check error.").slice(0, 1_000);
}

function cloneSnapshot(snapshot: LlmHealthSnapshot): LlmHealthSnapshot {
  return {
    ...snapshot,
    error: snapshot.error ? { ...snapshot.error } : null,
  };
}

export class LlmHealthService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly createProvider: (env: NodeJS.ProcessEnv) => LLMProvider;
  private readonly now: () => number;
  private readonly onResult?: (result: LlmHealthSnapshot) => void;
  private state: LlmHealthSnapshot;
  private inFlight: Promise<LlmHealthSnapshot> | undefined;

  constructor(opts: LlmHealthServiceOptions = {}) {
    this.env = opts.env ?? process.env;
    const timeoutMs = opts.timeoutMs;
    this.timeoutMs =
      typeof timeoutMs === "number" &&
        Number.isFinite(timeoutMs) &&
        timeoutMs > 0
        ? timeoutMs
        : DEFAULT_CHECK_TIMEOUT_MS;
    this.createProvider = opts.createProvider ?? ((env) =>
      createLLMProviderFromEnv({ env }));
    this.now = opts.now ?? Date.now;
    this.onResult = opts.onResult;

    const config = readConfiguration(this.env);
    this.state = {
      status: "idle",
      provider: config.provider,
      model: config.model,
      apiKeyConfigured: config.apiKeyConfigured,
      configured: config.configured,
      usable: false,
      checkedAt: null,
      latencyMs: null,
      error: null,
    };
  }

  snapshot(): LlmHealthSnapshot {
    return cloneSnapshot(this.state);
  }

  check(): Promise<LlmHealthSnapshot> {
    if (this.inFlight) return this.inFlight;

    const config = readConfiguration(this.env);
    const startedAt = this.now();
    this.state = {
      status: "checking",
      provider: config.provider,
      model: config.model,
      apiKeyConfigured: config.apiKeyConfigured,
      configured: config.configured,
      usable: false,
      checkedAt: null,
      latencyMs: null,
      error: null,
    };

    const current = this.performCheck(config, startedAt);
    this.inFlight = current;
    const clearInFlight = () => {
      if (this.inFlight === current) this.inFlight = undefined;
    };
    void current.then(clearInFlight, clearInFlight);
    return current;
  }

  private finish(
    config: LlmConfiguration,
    startedAt: number,
    result: Pick<LlmHealthSnapshot, "status" | "usable" | "error">,
  ): LlmHealthSnapshot {
    const finishedAt = this.now();
    this.state = {
      ...result,
      provider: config.provider,
      model: config.model,
      apiKeyConfigured: config.apiKeyConfigured,
      configured: config.configured,
      checkedAt: new Date(finishedAt).toISOString(),
      latencyMs: Math.max(0, Math.round(finishedAt - startedAt)),
    };
    const snapshot = this.snapshot();
    this.onResult?.(snapshot);
    return snapshot;
  }

  private async performCheck(
    config: LlmConfiguration,
    startedAt: number,
  ): Promise<LlmHealthSnapshot> {
    if (!config.apiKey) {
      return this.finish(config, startedAt, {
        status: "not-configured",
        usable: false,
        error: {
          code: "api_key_missing",
          message: "WECHAT2ALL_LLM_API_KEY is not configured.",
        },
      });
    }
    if (!config.model) {
      return this.finish(config, startedAt, {
        status: "not-configured",
        usable: false,
        error: {
          code: "model_missing",
          message: "WECHAT2ALL_LLM_MODEL is not configured.",
        },
      });
    }
    if (config.provider !== "openai-compatible") {
      return this.finish(config, startedAt, {
        status: "not-configured",
        usable: false,
        error: {
          code: "provider_unsupported",
          message: `LLM health check does not support provider: ${config.provider}.`,
        },
      });
    }

    try {
      const provider = this.createProvider(this.env);
      await provider.generate(
        [{ role: "user", content: CHECK_PROMPT }],
        { maxTokens: 8, timeoutMs: this.timeoutMs },
      );
      return this.finish(config, startedAt, {
        status: "ready",
        usable: true,
        error: null,
      });
    } catch (error) {
      return this.finish(config, startedAt, {
        status: "error",
        usable: false,
        error: {
          code: "request_failed",
          message: sanitizeError(error, config.apiKey),
        },
      });
    }
  }
}
