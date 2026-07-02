import path from "node:path";
import { randomUUID } from "node:crypto";

import { CodexAppServerRpc, resolveCodexExecutable } from "./app-server-rpc.js";
import { injectPromptIntoCodexGui } from "./gui-automation.js";
import type {
  CodexAppServerTransport,
  CodexGuiBinding,
  CodexGuiBridgeOptions,
  CodexGuiDeliveryMode,
  CodexGuiPromptInjector,
  CodexGuiBridgeTokenUsage,
  CodexGuiBridgeTokenWindow,
  CodexGuiChat,
  CodexGuiPrompt,
  CodexGuiPromptResult,
} from "./types.js";

interface RawThreadStatus {
  type?: string;
  activeFlags?: unknown[];
}

interface RawThread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  status?: RawThreadStatus;
  updatedAt?: number;
  recencyAt?: number | null;
  createdAt?: number;
  modelProvider?: string;
  model?: string;
  archived?: boolean;
  turns?: RawTurn[];
}

interface RawTurn {
  id: string;
  status?: TurnStatus;
  error?: TurnError | null;
  items?: ThreadItem[];
  startedAt?: number | null;
  completedAt?: number | null;
}

interface ThreadListResponse {
  data?: RawThread[];
}

interface ThreadReadResponse {
  thread: RawThread;
}

interface ThreadResumeResponse {
  thread: RawThread;
}

interface TurnStartResponse {
  turn?: {
    id?: string;
    status?: TurnStatus;
    items?: ThreadItem[];
    error?: TurnError | null;
  };
}

type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

interface TurnError {
  message?: string;
  detail?: string;
  [key: string]: unknown;
}

interface ThreadItem {
  type?: string;
  text?: string;
  phase?: string | null;
}

interface TurnCompletedNotification {
  threadId?: string;
  turn?: {
    id?: string;
    status?: TurnStatus;
    error?: TurnError | null;
    items?: ThreadItem[];
  };
}

interface ItemCompletedNotification {
  threadId?: string;
  turnId?: string;
  item?: ThreadItem;
}

interface AppServerRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface AppServerRateLimits {
  primary?: AppServerRateLimitWindow | null;
  secondary?: AppServerRateLimitWindow | null;
}

interface AppServerRateLimitResetCredits {
  availableCount?: number | string;
}

interface AppServerRateLimitsResponse {
  rateLimits?: AppServerRateLimits | null;
  rateLimitResetCredits?: AppServerRateLimitResetCredits | null;
}

export interface CodexGuiBridgeEnvOptions {
  env?: NodeJS.ProcessEnv;
}

function stripEnvQuotes(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = stripEnvQuotes(env[name]);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function projectName(projectPath: string | undefined): string | undefined {
  if (!projectPath) return undefined;
  return path.basename(projectPath) || projectPath;
}

function threadStatusText(status: RawThreadStatus | undefined): string | undefined {
  if (!status?.type) return undefined;
  if (status.type !== "active") return status.type;
  const flags = Array.isArray(status.activeFlags) && status.activeFlags.length > 0
    ? `:${status.activeFlags.length}`
    : "";
  return `active${flags}`;
}

function msFromSeconds(seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? seconds * 1000
    : undefined;
}

function chatFromThread(thread: RawThread): CodexGuiChat {
  const projectPath = thread.cwd;
  return {
    id: thread.id,
    title: thread.name ?? thread.preview ?? thread.id,
    project: projectName(projectPath),
    projectPath,
    status: threadStatusText(thread.status),
    updatedAt: msFromSeconds(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt),
    preview: thread.preview,
    modelProvider: thread.modelProvider,
    model: thread.model,
    archived: thread.archived,
  };
}

function bindingFromThread(thread: RawThread): CodexGuiBinding {
  const chat = chatFromThread(thread);
  return {
    threadId: thread.id,
    title: chat.title,
    project: chat.project ?? chat.projectPath,
    boundAt: Date.now(),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function labelForMinutes(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "Weekly";
  if (minutes == null) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatResetText(ms: number, windowDurationMins: number | null): string {
  const reset = new Date(ms);
  if ((windowDurationMins ?? 0) >= 1440) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(reset);
  }
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(reset);
}

function formatResetCredits(
  resetCredits: AppServerRateLimitResetCredits | null | undefined,
): string | null {
  const count = typeof resetCredits?.availableCount === "string"
    ? Number(resetCredits.availableCount)
    : resetCredits?.availableCount;
  if (!Number.isFinite(count) || count == null) return null;
  return count === 1 ? "1 reset available" : `${count} resets available`;
}

function formatTokenWindow(
  window: AppServerRateLimitWindow | null | undefined,
  fallbackLabel: string,
): CodexGuiBridgeTokenWindow | null {
  if (!window) return null;
  const usedPercent = finiteNumber(window.usedPercent);
  const remainingPercent = usedPercent == null ? null : Math.max(0, 100 - usedPercent);
  const windowDurationMins = finiteNumber(window.windowDurationMins);
  const resetsAt = finiteNumber(window.resetsAt);

  return {
    label: labelForMinutes(windowDurationMins, fallbackLabel),
    remainingText: remainingPercent == null ? null : `${Math.round(remainingPercent)}%`,
    resetText: resetsAt == null ? null : formatResetText(resetsAt * 1000, windowDurationMins),
    usedPercent,
    remainingPercent,
    windowDurationMins,
    resetsAt: resetsAt == null ? null : new Date(resetsAt * 1000).toISOString(),
  };
}

export class CodexGuiAppServerBridge {
  private readonly transport: CodexAppServerTransport;
  private readonly timeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly guiPollIntervalMs: number;
  private readonly guiThreadOpenDelayMs: number;
  private readonly listLimit: number;
  private readonly clientName: string;
  private readonly clientTitle: string;
  private readonly clientVersion: string;
  private readonly deliveryMode: CodexGuiDeliveryMode;
  private readonly guiPromptInjector: CodexGuiPromptInjector;
  private initialized?: Promise<void>;
  private binding: CodexGuiBinding | null;

  constructor(opts: CodexGuiBridgeOptions = {}) {
    this.transport = opts.transport ?? new CodexAppServerRpc({
      command: opts.codexCommand ?? resolveCodexExecutable(),
      socketPath: opts.socketPath,
      timeoutMs: opts.timeoutMs,
    });
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 180_000;
    this.guiPollIntervalMs = opts.guiPollIntervalMs ?? 1_000;
    this.guiThreadOpenDelayMs = opts.guiThreadOpenDelayMs ?? 900;
    this.listLimit = opts.listLimit ?? 20;
    this.clientName = opts.clientName ?? "wechat2all-codex-gui-bridge";
    this.clientTitle = opts.clientTitle ?? "wechat2all Codex GUI Bridge";
    this.clientVersion = opts.clientVersion ?? "0.1.0";
    this.deliveryMode = opts.deliveryMode ?? "app-server";
    this.guiPromptInjector = opts.guiPromptInjector ?? injectPromptIntoCodexGui;
    this.binding = opts.defaultThreadId
      ? {
          threadId: opts.defaultThreadId,
          boundAt: Date.now(),
        }
      : null;
  }

  close(): void {
    this.transport.close?.();
  }

  async listChats(limit = this.listLimit): Promise<CodexGuiChat[]> {
    await this.ensureInitialized();
    const response = await this.transport.request<ThreadListResponse>(
      "thread/list",
      {
        limit,
        sortKey: "recency_at",
        sortDirection: "desc",
        archived: false,
      },
      this.timeoutMs,
    );
    return (response.data ?? []).map(chatFromThread);
  }

  async listThreads(limit = this.listLimit): Promise<CodexGuiChat[]> {
    return this.listChats(limit);
  }

  async bindThread(threadId: string): Promise<CodexGuiBinding> {
    const normalized = threadId.trim();
    if (!normalized) throw new Error("/bind requires a thread id.");
    const thread = await this.readThread(normalized);
    this.binding = bindingFromThread(thread);
    return this.binding;
  }

  async getCurrentBinding(): Promise<CodexGuiBinding | null> {
    if (!this.binding) return null;
    if (this.binding.title || this.binding.project) return this.binding;
    try {
      const thread = await this.readThread(this.binding.threadId);
      this.binding = {
        ...bindingFromThread(thread),
        boundAt: this.binding.boundAt,
      };
    } catch {
      // Keep the explicit thread id even if the app-server is temporarily down.
    }
    return this.binding;
  }

  async getStatus(): Promise<{
    state: "idle" | "working" | "completed" | "blocked" | "unknown";
    summary?: string;
    currentThreadId?: string;
    currentProject?: string;
    updatedAt?: number;
  }> {
    const binding = await this.getCurrentBinding();
    if (!binding) {
      return {
        state: "unknown",
        summary:
          "Codex GUI bridge is not bound. Send /ls, then /bind <threadId>.",
        updatedAt: Date.now(),
      };
    }

    try {
      const thread = await this.readThread(binding.threadId);
      const status = threadStatusText(thread.status);
      return {
        state: status === "active" || status?.startsWith("active:")
          ? "working"
          : "idle",
        summary: status ? `Codex thread status: ${status}` : "Codex thread is reachable.",
        currentThreadId: thread.id,
        currentProject: chatFromThread(thread).project ?? thread.cwd,
        updatedAt: Date.now(),
      };
    } catch (error) {
      return {
        state: "unknown",
        summary: error instanceof Error ? error.message : String(error),
        currentThreadId: binding.threadId,
        currentProject: binding.project,
        updatedAt: Date.now(),
      };
    }
  }

  async sendPrompt(prompt: CodexGuiPrompt): Promise<CodexGuiPromptResult> {
    const text = prompt.text.trim();
    if (!text) throw new Error("Cannot send an empty Codex prompt.");
    const threadId = prompt.threadId?.trim() || this.binding?.threadId;
    if (!threadId) {
      throw new Error("Codex GUI bridge is not bound. Send /ls, then /bind <threadId>.");
    }

    if (this.deliveryMode === "gui-automation") {
      return this.sendPromptViaGuiAutomation({
        id: prompt.id ?? randomUUID(),
        threadId,
        text,
      });
    }

    await this.ensureInitialized();
    await this.transport.request<ThreadResumeResponse>(
      "thread/resume",
      { threadId },
      this.timeoutMs,
    );
    const id = prompt.id ?? randomUUID();
    const response = await this.transport.request<TurnStartResponse>(
      "turn/start",
      {
        threadId,
        clientUserMessageId: id,
        input: [
          {
            type: "text",
            text,
            text_elements: [],
          },
        ],
      },
      this.timeoutMs,
    );
    const turnId = response.turn?.id;
    const startedTurnResult = resultFromTurn(response.turn, threadId, turnId);
    if (startedTurnResult?.finalText || isTerminalStatus(startedTurnResult?.status)) {
      return {
        id,
        threadId,
        turnId,
        ...startedTurnResult,
      };
    }

    const completed = turnId && this.transport.onNotification
      ? await this.waitForTurnCompletion(threadId, turnId)
      : null;

    return {
      id,
      threadId,
      turnId,
      ...completed,
    };
  }

  async getTokenUsage(): Promise<CodexGuiBridgeTokenUsage> {
    await this.ensureInitialized();
    const response = await this.transport.request<AppServerRateLimitsResponse>(
      "account/rateLimits/read",
      undefined,
      this.timeoutMs,
    );
    const rateLimits = response.rateLimits;
    return {
      windows: [
        formatTokenWindow(rateLimits?.primary, "5h"),
        formatTokenWindow(rateLimits?.secondary, "Weekly"),
      ].filter((window): window is CodexGuiBridgeTokenWindow => window != null),
      resetCreditsText: formatResetCredits(response.rateLimitResetCredits),
    };
  }

  private async readThread(threadId: string): Promise<RawThread> {
    await this.ensureInitialized();
    const response = await this.transport.request<ThreadReadResponse>(
      "thread/read",
      {
        threadId,
        includeTurns: false,
      },
      this.timeoutMs,
    );
    return response.thread;
  }

  private async readThreadWithTurns(threadId: string): Promise<RawThread> {
    await this.ensureInitialized();
    const response = await this.transport.request<ThreadReadResponse>(
      "thread/read",
      {
        threadId,
        includeTurns: true,
      },
      this.timeoutMs,
    );
    return response.thread;
  }

  private async sendPromptViaGuiAutomation(args: {
    id: string;
    threadId: string;
    text: string;
  }): Promise<CodexGuiPromptResult> {
    const before = await this.readThreadWithTurns(args.threadId);
    const previousTurnIds = new Set((before.turns ?? []).map((turn) => turn.id));

    await this.guiPromptInjector(args.text, {
      threadId: args.threadId,
      threadTitle: this.binding?.threadId === args.threadId
        ? this.binding.title
        : undefined,
      threadOpenDelayMs: this.guiThreadOpenDelayMs,
    });
    const completed = await this.waitForNextThreadTurn(args.threadId, previousTurnIds);

    return {
      id: args.id,
      threadId: args.threadId,
      turnId: completed.turnId,
      status: completed.status,
      finalText: completed.finalText,
      error: completed.error,
    };
  }

  private async waitForNextThreadTurn(
    threadId: string,
    previousTurnIds: Set<string>,
  ): Promise<{
    turnId?: string;
    status?: TurnStatus;
    finalText?: string;
    error?: string;
  }> {
    const deadline = Date.now() + this.turnTimeoutMs;
    let latestNewTurn: RawTurn | undefined;

    while (Date.now() < deadline) {
      const thread = await this.readThreadWithTurns(threadId);
      const newTurns = (thread.turns ?? []).filter((turn) => !previousTurnIds.has(turn.id));
      latestNewTurn = newTurns.at(-1) ?? latestNewTurn;

      if (latestNewTurn && isCompletedTurnForGuiPolling(latestNewTurn)) {
        return {
          turnId: latestNewTurn.id,
          ...resultFromTurn(latestNewTurn, threadId, latestNewTurn.id),
        };
      }

      await sleep(this.guiPollIntervalMs);
    }

    if (latestNewTurn) {
      return {
        turnId: latestNewTurn.id,
        status: latestNewTurn.status ?? "inProgress",
        finalText: finalTextFromItems(latestNewTurn.items ?? []),
        error: errorText(latestNewTurn.error),
      };
    }

    throw new Error(
      "Timed out waiting for a new Codex GUI turn. Make sure the Codex app is open, " +
        "the bound chat is visible, and the app running wechat2all has Accessibility permission.",
    );
  }

  private waitForTurnCompletion(
    threadId: string,
    turnId: string,
  ): Promise<{
    status?: TurnStatus;
    finalText?: string;
    error?: string;
  }> {
    const completedItems: ThreadItem[] = [];

    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsubscribe?.();
        const partial = finalTextFromItems(completedItems);
        if (partial) {
          resolve({
            status: "inProgress",
            finalText: partial,
          });
          return;
        }
        reject(new Error(`Timed out waiting for Codex turn ${turnId} to complete.`));
      }, this.turnTimeoutMs);

      const finish = (result: {
        status?: TurnStatus;
        finalText?: string;
        error?: string;
      }) => {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(result);
      };

      unsubscribe = this.transport.onNotification?.((method, params) => {
        if (method === "item/completed") {
          const notification = params as ItemCompletedNotification;
          if (notification.threadId !== threadId || notification.turnId !== turnId) return;
          if (notification.item) completedItems.push(notification.item);
          return;
        }

        if (method === "turn/completed") {
          const notification = params as TurnCompletedNotification;
          if (notification.threadId !== threadId || notification.turn?.id !== turnId) return;
          finish({
            ...resultFromTurn(notification.turn, threadId, turnId),
            finalText: finalTextFromItems(notification.turn.items ?? completedItems),
          });
        }
      });

      if (!unsubscribe) {
        clearTimeout(timer);
        resolve({});
      }
    });
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.transport.request(
          "initialize",
          {
            clientInfo: {
              name: this.clientName,
              title: this.clientTitle,
              version: this.clientVersion,
            },
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
              optOutNotificationMethods: [],
            },
          },
          this.timeoutMs,
        );
        this.transport.notify?.("initialized", {});
      })();
    }
    return this.initialized;
  }
}

function isTerminalStatus(status: TurnStatus | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function isCompletedTurnForGuiPolling(turn: RawTurn): boolean {
  if (turn.status === "completed" || turn.status === "failed") return true;
  if (turn.status !== "interrupted") return false;
  return Boolean(finalTextFromItems(turn.items ?? []) || errorText(turn.error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finalTextFromItems(items: ThreadItem[]): string | undefined {
  const agentMessages = items
    .filter((item) => item.type === "agentMessage" && typeof item.text === "string")
    .map((item) => ({
      phase: item.phase,
      text: item.text?.trim() ?? "",
    }))
    .filter((item) => item.text.length > 0);

  const final = [...agentMessages].reverse().find((item) => item.phase === "final_answer");
  return final?.text ?? [...agentMessages].reverse()[0]?.text;
}

function errorText(error: TurnError | null | undefined): string | undefined {
  if (!error) return undefined;
  if (typeof error.message === "string") return error.message;
  if (typeof error.detail === "string") return error.detail;
  return JSON.stringify(error);
}

function resultFromTurn(
  turn: TurnStartResponse["turn"] | TurnCompletedNotification["turn"] | RawTurn | undefined,
  _threadId: string,
  _turnId: string | undefined,
): {
  status?: TurnStatus;
  finalText?: string;
  error?: string;
} | null {
  if (!turn) return null;
  return {
    status: turn.status,
    finalText: finalTextFromItems(turn.items ?? []),
    error: errorText(turn.error),
  };
}

export function createCodexGuiBridgeClient(
  opts: CodexGuiBridgeOptions = {},
): CodexGuiAppServerBridge {
  return new CodexGuiAppServerBridge(opts);
}

export function createCodexGuiBridgeClientFromEnv(
  opts: CodexGuiBridgeEnvOptions = {},
): CodexGuiAppServerBridge {
  const env = opts.env ?? process.env;
  return createCodexGuiBridgeClient({
    codexCommand: stripEnvQuotes(env.CODEX_CLI_PATH) ??
      stripEnvQuotes(env.WECHAT2ALL_CODEX_BIN),
    socketPath: stripEnvQuotes(env.WECHAT2ALL_CODEX_APP_SERVER_SOCKET),
    defaultThreadId: stripEnvQuotes(env.WECHAT2ALL_CODEX_THREAD_ID),
    deliveryMode: parseDeliveryMode(env.WECHAT2ALL_CODEX_DELIVERY),
    timeoutMs: envNumber(env, "WECHAT2ALL_CODEX_APP_SERVER_TIMEOUT_MS"),
    turnTimeoutMs: envNumber(env, "WECHAT2ALL_CODEX_TURN_TIMEOUT_MS"),
    guiPollIntervalMs: envNumber(env, "WECHAT2ALL_CODEX_GUI_POLL_INTERVAL_MS"),
    guiThreadOpenDelayMs: envNumber(env, "WECHAT2ALL_CODEX_GUI_THREAD_OPEN_DELAY_MS"),
    listLimit: envNumber(env, "WECHAT2ALL_CODEX_LIST_LIMIT"),
  });
}

function parseDeliveryMode(
  value: string | undefined,
): CodexGuiDeliveryMode | undefined {
  const mode = stripEnvQuotes(value);
  if (mode === "app-server" || mode === "gui-automation") return mode;
  return undefined;
}
