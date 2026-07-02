import type {
  AgentMemoryHit,
  AgentMemoryProvider,
  AgentMemorySearchParams,
} from "./types.js";

export function createNoopAgentMemoryProvider(
  id = "noop-agent-memory",
): AgentMemoryProvider {
  return {
    id,
    async appendTurn() {
      // Intentionally empty.
    },
    async search(_params: AgentMemorySearchParams): Promise<AgentMemoryHit[]> {
      return [];
    },
  };
}
