import path from "node:path";

import {
  CodexBridgeStore,
  type CodexBridgePrompt,
} from "@wechat2all/codex-mcp/bridge";

import type { CodexPromptExecutor } from "./executor.js";
import { WatcherStateStore, type WatcherPromptState } from "./state.js";

export interface CodexWatcherOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  processingStaleMs?: number;
  processExisting?: boolean;
  ignoreBeforeMs?: number;
  sendAck?: boolean;
  sendResult?: boolean;
  sendErrors?: boolean;
  maxWechatMessageChars?: number;
  currentProject?: string;
  currentThreadId?: string;
}

export interface CodexWatcherLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface CodexWatcherCycleResult {
  seen: number;
  processed: number;
  skipped: number;
  failed: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function truncateWechatText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32))}\n...[truncated]`;
}

function promptLabel(prompt: CodexBridgePrompt): string {
  return `${prompt.id} from ${prompt.senderId}`;
}

function defaultLogger(): CodexWatcherLogger {
  return {
    info(message) {
      process.stderr.write(`[wechat2all-codex-watcher] info ${message}\n`);
    },
    warn(message) {
      process.stderr.write(`[wechat2all-codex-watcher] warn ${message}\n`);
    },
    error(message) {
      process.stderr.write(`[wechat2all-codex-watcher] error ${message}\n`);
    },
  };
}

export class CodexPromptWatcher {
  private store: CodexBridgeStore;
  private state: WatcherStateStore;
  private executor: CodexPromptExecutor;
  private opts: Required<CodexWatcherOptions>;
  private logger: CodexWatcherLogger;

  constructor(params: {
    store: CodexBridgeStore;
    executor: CodexPromptExecutor;
    state?: WatcherStateStore;
    options?: CodexWatcherOptions;
    logger?: CodexWatcherLogger;
  }) {
    this.store = params.store;
    this.executor = params.executor;
    this.state = params.state ?? new WatcherStateStore(
      path.join(params.store.baseDir, "watcher-state.json"),
    );
    this.opts = {
      pollIntervalMs: params.options?.pollIntervalMs ?? 1500,
      batchSize: params.options?.batchSize ?? 1,
      maxAttempts: params.options?.maxAttempts ?? 3,
      retryDelayMs: params.options?.retryDelayMs ?? 30_000,
      processingStaleMs: params.options?.processingStaleMs ?? 30 * 60 * 1000,
      processExisting: params.options?.processExisting ?? false,
      ignoreBeforeMs: params.options?.ignoreBeforeMs ?? Date.now(),
      sendAck: params.options?.sendAck ?? true,
      sendResult: params.options?.sendResult ?? true,
      sendErrors: params.options?.sendErrors ?? true,
      maxWechatMessageChars: params.options?.maxWechatMessageChars ?? 3500,
      currentProject: params.options?.currentProject ?? "wechat2all",
      currentThreadId: params.options?.currentThreadId ?? "codex-watcher",
    };
    this.logger = params.logger ?? defaultLogger();
  }

  async processOnce(): Promise<CodexWatcherCycleResult> {
    const prompts = this.filterHistoricalPrompts(await this.store.listWechatPrompts({
      limit: this.opts.batchSize,
    })).sort((a, b) => a.createdAt - b.createdAt);
    const result: CodexWatcherCycleResult = {
      seen: prompts.length,
      processed: 0,
      skipped: 0,
      failed: 0,
    };

    for (const prompt of prompts) {
      const action = await this.shouldProcess(prompt);
      if (!action.process) {
        result.skipped += 1;
        continue;
      }
      try {
        await this.processPrompt(prompt, action.previous);
        result.processed += 1;
      } catch {
        result.failed += 1;
      }
    }

    if (result.processed === 0 && result.failed === 0) {
      await this.store.updateStatus({
        state: "idle",
        summary: "Codex watcher is idle.",
        currentProject: this.opts.currentProject,
        currentThreadId: this.opts.currentThreadId,
      });
    }
    return result;
  }

  async run(signal?: AbortSignal): Promise<void> {
    this.logger.info(
      `watching bridge ${this.store.baseDir}` +
        (this.opts.processExisting
          ? " including existing prompts"
          : ` from ${new Date(this.opts.ignoreBeforeMs).toISOString()}`),
    );
    await this.store.updateStatus({
      state: "idle",
      summary: "Codex watcher started.",
      currentProject: this.opts.currentProject,
      currentThreadId: this.opts.currentThreadId,
    });

    while (!signal?.aborted) {
      await this.processOnce();
      if (signal?.aborted) break;
      await sleep(this.opts.pollIntervalMs);
    }
    await this.store.updateStatus({
      state: "idle",
      summary: "Codex watcher stopped.",
      currentProject: this.opts.currentProject,
      currentThreadId: this.opts.currentThreadId,
    });
  }

  private filterHistoricalPrompts(prompts: CodexBridgePrompt[]): CodexBridgePrompt[] {
    if (this.opts.processExisting) return prompts;
    return prompts.filter((prompt) => prompt.createdAt >= this.opts.ignoreBeforeMs);
  }

  private async shouldProcess(prompt: CodexBridgePrompt): Promise<{
    process: boolean;
    previous?: WatcherPromptState;
  }> {
    const previous = await this.state.getPrompt(prompt.id);
    if (!previous) return { process: true };
    if (previous.status === "completed" || previous.status === "terminal-failed") {
      return { process: false, previous };
    }
    const now = Date.now();
    if (
      previous.status === "processing" &&
      now - previous.updatedAt < this.opts.processingStaleMs
    ) {
      return { process: false, previous };
    }
    if (
      previous.status === "failed" &&
      previous.nextAttemptAt !== undefined &&
      previous.nextAttemptAt > now
    ) {
      return { process: false, previous };
    }
    return { process: true, previous };
  }

  private async processPrompt(
    prompt: CodexBridgePrompt,
    previous?: WatcherPromptState,
  ): Promise<void> {
    const attempts = (previous?.attempts ?? 0) + 1;
    const now = Date.now();
    await this.state.upsertPrompt({
      id: prompt.id,
      status: "processing",
      attempts,
      firstSeenAt: previous?.firstSeenAt ?? now,
      updatedAt: now,
    });
    await this.store.updateStatus({
      state: "working",
      summary: `Handling WeChat prompt ${promptLabel(prompt)}.`,
      currentProject: this.opts.currentProject,
      currentThreadId: this.opts.currentThreadId,
    });
    this.logger.info(`processing ${promptLabel(prompt)} attempt ${attempts}`);

    if (this.opts.sendAck && attempts === 1) {
      await this.store.sendWechatMessage({
        text: `收到，正在交给 Codex 处理。\nPrompt ID: ${prompt.id}`,
        level: "info",
      });
    }

    try {
      const execution = await this.executor.run(prompt);
      await this.store.markWechatPromptHandled(prompt.id);
      await this.state.upsertPrompt({
        id: prompt.id,
        status: "completed",
        attempts,
        firstSeenAt: previous?.firstSeenAt ?? now,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
      await this.store.updateStatus({
        state: "completed",
        summary: `Completed WeChat prompt ${prompt.id}.`,
        currentProject: this.opts.currentProject,
        currentThreadId: this.opts.currentThreadId,
      });
      if (this.opts.sendResult) {
        const finalText = execution.finalText.trim() ||
          "Codex 已完成处理，但没有返回最终文本。";
        await this.store.sendWechatMessage({
          text: truncateWechatText(finalText, this.opts.maxWechatMessageChars),
          level: "success",
        });
      }
      this.logger.info(`completed ${promptLabel(prompt)}`);
    } catch (err) {
      await this.handlePromptError(prompt, previous, attempts, toError(err));
      throw err;
    }
  }

  private async handlePromptError(
    prompt: CodexBridgePrompt,
    previous: WatcherPromptState | undefined,
    attempts: number,
    error: Error,
  ): Promise<void> {
    const now = Date.now();
    const terminal = attempts >= this.opts.maxAttempts;
    await this.state.upsertPrompt({
      id: prompt.id,
      status: terminal ? "terminal-failed" : "failed",
      attempts,
      firstSeenAt: previous?.firstSeenAt ?? now,
      updatedAt: now,
      nextAttemptAt: terminal ? undefined : now + this.opts.retryDelayMs * attempts,
      lastError: error.message,
    });
    await this.store.updateStatus({
      state: "blocked",
      summary: `Failed WeChat prompt ${prompt.id}: ${error.message}`,
      currentProject: this.opts.currentProject,
      currentThreadId: this.opts.currentThreadId,
    });
    this.logger.error(`failed ${promptLabel(prompt)}: ${error.message}`);

    if (!terminal) return;
    await this.store.markWechatPromptHandled(prompt.id);
    if (this.opts.sendErrors) {
      await this.store.sendWechatMessage({
        text: [
          "Codex watcher 处理这条消息失败，已停止重试。",
          `Prompt ID: ${prompt.id}`,
          `Error: ${error.message}`,
        ].join("\n"),
        level: "error",
      });
    }
  }
}
