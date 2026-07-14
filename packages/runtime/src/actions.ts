import type { WeChatClient } from "wechat2all";

import type { RuntimeAction, RuntimeActionResult } from "./types.js";

export interface RuntimeActionExecutorOptions {
  continueOnError?: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  dedupeWindowMs?: number;
  shouldRetry?: (result: RuntimeActionResult, attempt: number) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runtimeActionDedupeKey(action: RuntimeAction): string {
  if (action.dedupeKey) return action.dedupeKey;
  switch (action.type) {
    case "send_text":
      return [
        action.type,
        action.conversationId,
        action.contextToken ?? "",
        action.text,
      ].join(":");
    case "send_media":
      return [
        action.type,
        action.conversationId,
        action.contextToken ?? "",
        action.filePath,
        action.caption ?? "",
      ].join(":");
    case "send_voice":
      return [
        action.type,
        action.conversationId,
        action.contextToken ?? "",
        action.filePath,
        String(action.playtimeMs ?? ""),
      ].join(":");
    case "typing":
      return [
        action.type,
        action.conversationId,
        action.contextToken ?? "",
        action.status,
      ].join(":");
    case "noop":
      return [action.type, action.reason ?? ""].join(":");
  }
}

export async function executeRuntimeAction(params: {
  client: WeChatClient;
  action: RuntimeAction;
}): Promise<RuntimeActionResult> {
  const { client, action } = params;
  const startedAt = Date.now();
  try {
    let result: unknown;
    switch (action.type) {
      case "send_text":
        result = await client.sendText(
          action.conversationId,
          action.text,
          action.contextToken,
        );
        break;
      case "send_media":
        result = await client.sendMedia(
          action.conversationId,
          action.filePath,
          action.caption,
          action.contextToken,
        );
        break;
      case "send_voice":
        result = await client.sendVoice(
          action.conversationId,
          action.filePath,
          {
            playtimeMs: action.playtimeMs,
          },
          action.contextToken,
        );
        break;
      case "typing": {
        const ticket = await client.getTypingTicket(
          action.conversationId,
          action.contextToken,
        );
        result = await client.sendTyping(
          action.conversationId,
          ticket,
          action.status,
        );
        break;
      }
      case "noop":
        result = action.reason;
        break;
    }
    return {
      action,
      ok: true,
      result,
      attempts: 1,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      action,
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      attempts: 1,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function executeRuntimeActionWithRetry(params: {
  client: WeChatClient;
  action: RuntimeAction;
  options?: RuntimeActionExecutorOptions;
}): Promise<RuntimeActionResult> {
  const { client, action, options = {} } = params;
  const maxAttempts = Math.max(1, action.maxAttempts ?? options.maxAttempts ?? 1);
  const retryDelayMs = Math.max(0, action.retryDelayMs ?? options.retryDelayMs ?? 0);
  const startedAt = Date.now();
  let lastResult: RuntimeActionResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await executeRuntimeAction({ client, action });
    lastResult = {
      ...result,
      attempts: attempt,
      durationMs: Date.now() - startedAt,
    };
    if (lastResult.ok) return lastResult;

    const retry = options.shouldRetry
      ? options.shouldRetry(lastResult, attempt)
      : attempt < maxAttempts;
    if (!retry || attempt >= maxAttempts) return lastResult;
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }

  return lastResult ?? {
    action,
    ok: false,
    attempts: 0,
    durationMs: Date.now() - startedAt,
    error: new Error("Runtime action was not executed."),
  };
}

export async function executeRuntimeActions(params: {
  client: WeChatClient;
  actions: RuntimeAction[];
  options?: RuntimeActionExecutorOptions;
}): Promise<RuntimeActionResult[]> {
  const { client, actions, options = {} } = params;
  const results: RuntimeActionResult[] = [];
  for (const action of actions) {
    const result = await executeRuntimeActionWithRetry({ client, action, options });
    results.push(result);
    if (!result.ok && !options.continueOnError) break;
  }
  return results;
}

export interface RuntimeActionQueueOptions extends RuntimeActionExecutorOptions {
  id?: string;
}

export class RuntimeActionQueue {
  readonly id: string;
  private options: RuntimeActionQueueOptions;
  private tail: Promise<void> = Promise.resolve();
  private recentActions = new Map<string, number>();

  constructor(options: RuntimeActionQueueOptions = {}) {
    this.id = options.id ?? "runtime-action-queue";
    this.options = options;
  }

  executeBatch(params: {
    client: WeChatClient;
    actions: RuntimeAction[];
    options?: RuntimeActionExecutorOptions;
  }): Promise<RuntimeActionResult[]> {
    const run = this.tail.then(
      () => this.runBatch(params),
      () => this.runBatch(params),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runBatch(params: {
    client: WeChatClient;
    actions: RuntimeAction[];
    options?: RuntimeActionExecutorOptions;
  }): Promise<RuntimeActionResult[]> {
    const options = { ...this.options, ...params.options };
    const results: RuntimeActionResult[] = [];
    for (const action of params.actions) {
      const dedupeKey = runtimeActionDedupeKey(action);
      if (this.isRecentDuplicate(dedupeKey, options.dedupeWindowMs)) {
        results.push({
          action,
          ok: true,
          attempts: 0,
          deduped: true,
          durationMs: 0,
          result: "deduped",
        });
        continue;
      }

      const result = await executeRuntimeActionWithRetry({
        client: params.client,
        action,
        options,
      });
      results.push(result);
      if (result.ok) {
        this.recentActions.set(dedupeKey, Date.now());
      }
      if (!result.ok && !options.continueOnError) break;
    }
    this.pruneRecentActions(options.dedupeWindowMs);
    return results;
  }

  private isRecentDuplicate(
    key: string,
    dedupeWindowMs = 0,
  ): boolean {
    if (dedupeWindowMs <= 0) return false;
    const seenAt = this.recentActions.get(key);
    return seenAt !== undefined && Date.now() - seenAt <= dedupeWindowMs;
  }

  private pruneRecentActions(dedupeWindowMs = 0): void {
    if (dedupeWindowMs <= 0) return;
    const minSeenAt = Date.now() - dedupeWindowMs;
    for (const [key, seenAt] of this.recentActions) {
      if (seenAt < minSeenAt) this.recentActions.delete(key);
    }
  }
}
