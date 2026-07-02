import type { RuntimeMessage } from "./types.js";
import type { RuntimeStateStore } from "./state/types.js";

export interface RuntimeMessageDeduper {
  id: string;
  claim(message: RuntimeMessage): Promise<boolean>;
}

export interface InMemoryRuntimeMessageDeduperOptions {
  id?: string;
  maxEntries?: number;
  ttlMs?: number;
}

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export function runtimeMessageDedupeKey(message: RuntimeMessage): string {
  return [
    message.platform,
    message.profileId,
    message.conversationId,
    message.senderId,
    message.id,
  ].join(":");
}

export class InMemoryRuntimeMessageDeduper implements RuntimeMessageDeduper {
  readonly id: string;
  private maxEntries: number;
  private ttlMs: number;
  private seen = new Map<string, number>();

  constructor(opts: InMemoryRuntimeMessageDeduperOptions = {}) {
    this.id = opts.id ?? "in-memory-message-deduper";
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async claim(message: RuntimeMessage): Promise<boolean> {
    const key = runtimeMessageDedupeKey(message);
    this.prune();
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now());
    return true;
  }

  private prune(): void {
    const minSeenAt = Date.now() - this.ttlMs;
    for (const [key, seenAt] of this.seen) {
      if (seenAt < minSeenAt) this.seen.delete(key);
    }
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seen.delete(oldest);
    }
  }
}

export class StateStoreRuntimeMessageDeduper implements RuntimeMessageDeduper {
  readonly id: string;
  private store: RuntimeStateStore;

  constructor(store: RuntimeStateStore, id = "state-store-message-deduper") {
    this.store = store;
    this.id = id;
  }

  async claim(message: RuntimeMessage): Promise<boolean> {
    const key = runtimeMessageDedupeKey(message);
    if (await this.store.hasProcessedMessage(message.profileId, key)) {
      return false;
    }
    await this.store.markProcessedMessage({
      key,
      profileId: message.profileId,
      messageId: message.id,
      conversationId: message.conversationId,
      processedAt: Date.now(),
    });
    return true;
  }
}

export function createStateStoreMessageDeduper(
  store: RuntimeStateStore,
): RuntimeMessageDeduper {
  return new StateStoreRuntimeMessageDeduper(store);
}
