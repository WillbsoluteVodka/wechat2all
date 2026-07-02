import type { MemoryRole } from "../types.js";

export interface AgentMemoryScope {
  profileId: string;
  routeId: string;
  connectorId: string;
  conversationId: string;
  senderId: string;
}

export interface AgentMemoryMessage {
  role: Extract<MemoryRole, "user" | "assistant" | "system">;
  content: string;
  createdAt?: number;
}

export interface AgentMemoryAppendTurnParams {
  scope: AgentMemoryScope;
  input: AgentMemoryMessage;
  output?: AgentMemoryMessage;
  metadata?: Record<string, unknown>;
}

export interface AgentMemorySearchParams {
  scope: AgentMemoryScope;
  query: string;
  limit?: number;
}

export interface AgentMemoryHit {
  id?: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentMemoryProvider {
  id: string;
  appendTurn(params: AgentMemoryAppendTurnParams): Promise<void>;
  search(params: AgentMemorySearchParams): Promise<AgentMemoryHit[]>;
}

export type AgentMemoryErrorHandler = (
  error: Error,
  context: {
    operation: "appendTurn" | "search";
    providerId: string;
    scope: AgentMemoryScope;
  },
) => void | Promise<void>;
