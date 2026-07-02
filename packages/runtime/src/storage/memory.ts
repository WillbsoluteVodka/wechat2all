import crypto from "node:crypto";

import type { MemoryMessage, MemoryScope, MemoryStore } from "../types.js";
export type { MemoryStore } from "../types.js";

function scopeKey(scope: MemoryScope): string {
  return `${scope.profileId}\u0000${scope.connectorId}\u0000${scope.conversationId}`;
}

export class InMemoryMemoryStore implements MemoryStore {
  private messages = new Map<string, MemoryMessage[]>();

  async appendMessage(message: MemoryMessage): Promise<void> {
    const key = scopeKey(message.scope);
    const existing = this.messages.get(key) ?? [];
    existing.push(message);
    this.messages.set(key, existing);
  }

  async getRecentMessages(
    scope: MemoryScope,
    limit: number,
  ): Promise<MemoryMessage[]> {
    const key = scopeKey(scope);
    const existing = this.messages.get(key) ?? [];
    return existing.slice(-Math.max(0, limit));
  }

  async clear(scope: MemoryScope): Promise<void> {
    this.messages.delete(scopeKey(scope));
  }
}

export function createMemoryMessage(params: Omit<MemoryMessage, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
}): MemoryMessage {
  return {
    ...params,
    id: params.id ?? `mem-${crypto.randomUUID()}`,
    createdAt: params.createdAt ?? Date.now(),
  };
}
