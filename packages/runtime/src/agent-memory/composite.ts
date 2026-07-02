import type {
  AgentMemoryAppendTurnParams,
  AgentMemoryErrorHandler,
  AgentMemoryHit,
  AgentMemoryProvider,
  AgentMemorySearchParams,
} from "./types.js";

export interface CompositeAgentMemoryProviderOptions {
  id?: string;
  providers: AgentMemoryProvider[];
  onError?: AgentMemoryErrorHandler;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function hitKey(hit: AgentMemoryHit): string {
  return hit.id ?? hit.content;
}

export function createCompositeAgentMemoryProvider(
  opts: CompositeAgentMemoryProviderOptions,
): AgentMemoryProvider {
  return {
    id: opts.id ?? "composite-agent-memory",
    async appendTurn(params: AgentMemoryAppendTurnParams): Promise<void> {
      for (const provider of opts.providers) {
        try {
          await provider.appendTurn(params);
        } catch (err) {
          await opts.onError?.(toError(err), {
            operation: "appendTurn",
            providerId: provider.id,
            scope: params.scope,
          });
        }
      }
    },
    async search(params: AgentMemorySearchParams): Promise<AgentMemoryHit[]> {
      const hits = new Map<string, AgentMemoryHit>();
      for (const provider of opts.providers) {
        try {
          for (const hit of await provider.search(params)) {
            const key = hitKey(hit);
            const existing = hits.get(key);
            if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) {
              hits.set(key, hit);
            }
          }
        } catch (err) {
          await opts.onError?.(toError(err), {
            operation: "search",
            providerId: provider.id,
            scope: params.scope,
          });
        }
      }
      return [...hits.values()]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, params.limit ?? 10);
    },
  };
}
