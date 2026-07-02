import { createCompositeAgentMemoryProvider } from "./composite.js";
import { createLocalJsonlAgentMemoryProvider } from "./local-jsonl.js";
import { createMem0AgentMemoryProvider } from "./mem0.js";
import { createNoopAgentMemoryProvider } from "./noop.js";
import type {
  AgentMemoryErrorHandler,
  AgentMemoryProvider,
} from "./types.js";

export interface EnvAgentMemoryProviderOptions {
  env?: Record<string, string | undefined>;
  baseDir?: string;
  onError?: AgentMemoryErrorHandler;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function createAgentMemoryProviderFromEnv(
  opts: EnvAgentMemoryProviderOptions = {},
): AgentMemoryProvider {
  const env = opts.env ?? process.env;
  const mode = env.WECHAT2ALL_MEMORY_PROVIDER ?? "local";
  if (mode === "none") return createNoopAgentMemoryProvider();

  const providers: AgentMemoryProvider[] = [];
  if (opts.baseDir) {
    providers.push(createLocalJsonlAgentMemoryProvider({
      baseDir: opts.baseDir,
      maxSearchRows: positiveNumber(env.WECHAT2ALL_MEMORY_LOCAL_MAX_SEARCH_ROWS),
    }));
  }

  const mem0ApiKey = env.WECHAT2ALL_MEM0_API_KEY;
  if ((mode === "mem0" || mem0ApiKey) && mem0ApiKey) {
    providers.push(createMem0AgentMemoryProvider({
      apiKey: mem0ApiKey,
      baseUrl: env.WECHAT2ALL_MEM0_BASE_URL,
      timeoutMs: positiveNumber(env.WECHAT2ALL_MEM0_TIMEOUT_MS),
    }));
  }

  if (providers.length === 0) return createNoopAgentMemoryProvider();
  if (providers.length === 1) return providers[0];
  return createCompositeAgentMemoryProvider({
    providers,
    onError: opts.onError,
  });
}
