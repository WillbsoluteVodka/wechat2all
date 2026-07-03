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
  fingerprintTtlMs?: number;
}

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FINGERPRINT_TTL_MS = 2_000;

export function runtimeMessageDedupeKey(message: RuntimeMessage): string {
  return [
    message.platform,
    message.profileId,
    message.conversationId,
    message.senderId,
    message.id,
  ].join(":");
}

function normalizedTextFingerprint(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}

export function runtimeMessageFingerprintKey(message: RuntimeMessage): string {
  return [
    "fingerprint",
    message.platform,
    message.profileId,
    message.conversationId,
    message.senderId,
    message.kind,
    normalizedTextFingerprint(message.text),
    message.attachments.map((attachment) => [
      attachment.kind,
      attachment.id ?? "",
      attachment.fileName ?? "",
      attachment.size ?? "",
      attachment.durationMs ?? "",
    ].join(",")).join("|"),
  ].join(":");
}

function isRecentDuplicate(
  seen: Map<string, number>,
  key: string,
  ttlMs: number,
  now = Date.now(),
): boolean {
  const seenAt = seen.get(key);
  return seenAt !== undefined && now - seenAt <= ttlMs;
}

export class InMemoryRuntimeMessageDeduper implements RuntimeMessageDeduper {
  readonly id: string;
  private maxEntries: number;
  private ttlMs: number;
  private fingerprintTtlMs: number;
  private seen = new Map<string, number>();
  private fingerprints = new Map<string, number>();

  constructor(opts: InMemoryRuntimeMessageDeduperOptions = {}) {
    this.id = opts.id ?? "in-memory-message-deduper";
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fingerprintTtlMs =
      opts.fingerprintTtlMs ?? DEFAULT_FINGERPRINT_TTL_MS;
  }

  async claim(message: RuntimeMessage): Promise<boolean> {
    const now = Date.now();
    const key = runtimeMessageDedupeKey(message);
    const fingerprintKey = runtimeMessageFingerprintKey(message);
    this.prune();
    if (this.seen.has(key)) return false;
    if (isRecentDuplicate(this.fingerprints, fingerprintKey, this.fingerprintTtlMs, now)) {
      return false;
    }
    this.seen.set(key, now);
    this.fingerprints.set(fingerprintKey, now);
    return true;
  }

  private prune(): void {
    const now = Date.now();
    const minSeenAt = now - this.ttlMs;
    for (const [key, seenAt] of this.seen) {
      if (seenAt < minSeenAt) this.seen.delete(key);
    }
    const minFingerprintSeenAt = now - this.fingerprintTtlMs;
    for (const [key, seenAt] of this.fingerprints) {
      if (seenAt < minFingerprintSeenAt) this.fingerprints.delete(key);
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
  private fingerprintTtlMs: number;
  private pending = new Set<string>();
  private fingerprints = new Map<string, number>();

  constructor(
    store: RuntimeStateStore,
    id = "state-store-message-deduper",
    fingerprintTtlMs = DEFAULT_FINGERPRINT_TTL_MS,
  ) {
    this.store = store;
    this.id = id;
    this.fingerprintTtlMs = fingerprintTtlMs;
  }

  async claim(message: RuntimeMessage): Promise<boolean> {
    const now = Date.now();
    const key = runtimeMessageDedupeKey(message);
    const fingerprintKey = runtimeMessageFingerprintKey(message);
    this.pruneFingerprints(now);
    if (
      this.pending.has(key) ||
      this.pending.has(fingerprintKey) ||
      isRecentDuplicate(this.fingerprints, fingerprintKey, this.fingerprintTtlMs, now)
    ) {
      return false;
    }

    this.pending.add(key);
    this.pending.add(fingerprintKey);
    try {
      if (await this.store.hasProcessedMessage(message.profileId, key)) {
        return false;
      }
      await this.store.markProcessedMessage({
        key,
        profileId: message.profileId,
        messageId: message.id,
        conversationId: message.conversationId,
        processedAt: now,
      });
      this.fingerprints.set(fingerprintKey, now);
      return true;
    } finally {
      this.pending.delete(key);
      this.pending.delete(fingerprintKey);
    }
  }

  private pruneFingerprints(now = Date.now()): void {
    const minSeenAt = now - this.fingerprintTtlMs;
    for (const [key, seenAt] of this.fingerprints) {
      if (seenAt < minSeenAt) this.fingerprints.delete(key);
    }
  }
}

export function createStateStoreMessageDeduper(
  store: RuntimeStateStore,
): RuntimeMessageDeduper {
  return new StateStoreRuntimeMessageDeduper(store);
}
