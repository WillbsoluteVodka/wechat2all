import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { CodexAppServerRpc, resolveCodexExecutable } from "./app-server-rpc.js";
import { CodexDesktopIpcRpc } from "./desktop-ipc.js";
import {
  disabledCodexGuiAlarmState,
  readCodexGuiAlarm,
  scheduledCodexGuiAlarmState,
  type CodexGuiAlarmState,
  writeCodexGuiAlarm,
} from "./alarm.js";
import {
  readCodexGuiAutoOpen,
  type CodexGuiAutoOpenState,
  writeCodexGuiAutoOpen,
} from "./auto-open.js";
import {
  codexGuiBindingConfigPath,
  readCodexGuiBinding,
  writeCodexGuiBinding,
} from "./binding.js";
import { injectPromptIntoCodexGui } from "./gui-automation.js";
import { openCodexGuiThread } from "./gui-app.js";
import type {
  CodexAppServerTransport,
  CodexDesktopIpcTransport,
  CodexGuiBinding,
  CodexGuiBridgeOptions,
  CodexGuiDeliveryMode,
  CodexGuiPromptInjector,
  CodexGuiThreadOpener,
  CodexGuiBridgeTokenUsage,
  CodexGuiBridgeTokenWindow,
  CodexGuiChat,
  CodexGuiOutputFile,
  CodexGuiPrompt,
  CodexGuiPromptAttachment,
  CodexGuiPromptResult,
  CodexGuiReplyMode,
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

interface DesktopIpcStartTurnResponse {
  result?: TurnStartResponse;
}

interface TurnSteerResponse {
  turnId?: string;
}

type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

interface TurnError {
  message?: string;
  detail?: string;
  [key: string]: unknown;
}

interface ThreadItem {
  id?: string;
  type?: string;
  text?: string;
  phase?: string | null;
  content?: unknown;
  image_url?: string;
  imageUrl?: string;
  filePath?: string;
  file_path?: string;
  imagePath?: string;
  image_path?: string;
  localPath?: string;
  local_path?: string;
  outputPath?: string;
  output_path?: string;
  path?: string;
  savedPath?: string;
  saved_path?: string;
  url?: string;
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

interface PromptDeliveryArgs {
  id: string;
  threadId: string;
  text: string;
  attachments: CodexGuiPromptAttachment[];
  replyMode: CodexGuiReplyMode;
}

type ActualDeliveryMode =
  | "app-server"
  | "desktop-ipc"
  | "gui-automation"
  | "app-server-fallback";

export interface CodexGuiBridgeEnvOptions {
  env?: NodeJS.ProcessEnv;
  enableAlarmScheduler?: boolean;
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
  private readonly desktopIpcTransport: CodexDesktopIpcTransport;
  private readonly timeoutMs: number;
  private readonly desktopIpcTimeoutMs: number;
  private readonly desktopIpcThreadOpenDelayMs: number;
  private readonly turnTimeoutMs: number;
  private readonly guiPollIntervalMs: number;
  private readonly guiThreadOpenDelayMs: number;
  private readonly guiFallbackReconcileMs: number;
  private readonly listLimit: number;
  private readonly clientName: string;
  private readonly clientTitle: string;
  private readonly clientVersion: string;
  private readonly deliveryMode: CodexGuiDeliveryMode;
  private readonly replyMode: CodexGuiReplyMode;
  private readonly guiPromptInjector: CodexGuiPromptInjector;
  private readonly guiThreadOpener: CodexGuiThreadOpener;
  private readonly bindingConfigPath?: string;
  private readonly autoOpenConfigPath?: string;
  private readonly alarmConfigPath?: string;
  private readonly enableAlarmScheduler: boolean;
  private initialized?: Promise<void>;
  private binding: CodexGuiBinding | null;
  private bindingLoaded: boolean;
  private alarmTimer?: ReturnType<typeof setTimeout>;
  private readonly activePromptCounts = new Map<string, number>();
  private lastDelivery?: {
    mode: ActualDeliveryMode;
    threadId: string;
  };

  constructor(opts: CodexGuiBridgeOptions = {}) {
    this.transport = opts.transport ?? new CodexAppServerRpc({
      command: opts.codexCommand ?? resolveCodexExecutable(),
      socketPath: opts.socketPath,
      timeoutMs: opts.timeoutMs,
    });
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.desktopIpcTimeoutMs = opts.desktopIpcTimeoutMs ?? 30_000;
    this.desktopIpcThreadOpenDelayMs = opts.desktopIpcThreadOpenDelayMs ?? 1_200;
    this.desktopIpcTransport = opts.desktopIpcTransport ?? new CodexDesktopIpcRpc({
      socketPath: opts.desktopIpcSocketPath,
      timeoutMs: this.desktopIpcTimeoutMs,
      clientType: opts.clientName ?? "wechat2all-codex-gui-bridge",
    });
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 180_000;
    this.guiPollIntervalMs = opts.guiPollIntervalMs ?? 1_000;
    this.guiThreadOpenDelayMs = opts.guiThreadOpenDelayMs ?? 900;
    this.guiFallbackReconcileMs = opts.guiFallbackReconcileMs ?? 1_500;
    this.listLimit = opts.listLimit ?? 20;
    this.clientName = opts.clientName ?? "wechat2all-codex-gui-bridge";
    this.clientTitle = opts.clientTitle ?? "wechat2all Codex GUI Bridge";
    this.clientVersion = opts.clientVersion ?? "0.1.0";
    this.deliveryMode = opts.deliveryMode ?? "app-server";
    this.replyMode = opts.replyMode ?? "final";
    this.guiPromptInjector = opts.guiPromptInjector ?? injectPromptIntoCodexGui;
    this.guiThreadOpener = opts.guiThreadOpener ?? openCodexGuiThread;
    this.bindingConfigPath = opts.bindingConfigPath;
    this.autoOpenConfigPath = opts.autoOpenConfigPath;
    this.alarmConfigPath = opts.alarmConfigPath;
    this.enableAlarmScheduler = opts.enableAlarmScheduler === true;
    this.binding = opts.defaultThreadId
      ? {
          threadId: opts.defaultThreadId,
          boundAt: Date.now(),
        }
      : null;
    this.bindingLoaded = Boolean(opts.defaultThreadId);
    if (this.enableAlarmScheduler) {
      void this.startAlarmScheduler();
    }
  }

  close(): void {
    if (this.alarmTimer) {
      clearTimeout(this.alarmTimer);
      this.alarmTimer = undefined;
    }
    this.transport.close?.();
    this.desktopIpcTransport.close?.();
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
    await this.ensureBindingLoaded();
    const normalized = threadId.trim();
    if (!normalized) throw new Error("/bind requires a thread id.");
    const thread = await this.readThread(normalized);
    this.binding = bindingFromThread(thread);
    if (this.bindingConfigPath) {
      await writeCodexGuiBinding(this.binding, {
        configPath: this.bindingConfigPath,
      });
    }
    return this.binding;
  }

  async getCurrentBinding(): Promise<CodexGuiBinding | null> {
    await this.ensureBindingLoaded();
    if (!this.binding) return null;
    if (this.binding.title || this.binding.project) return this.binding;
    try {
      const thread = await this.readThread(this.binding.threadId);
      this.binding = {
        ...bindingFromThread(thread),
        boundAt: this.binding.boundAt,
      };
      if (this.bindingConfigPath) {
        await writeCodexGuiBinding(this.binding, {
          configPath: this.bindingConfigPath,
        }).catch(() => undefined);
      }
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
          "Codex GUI bridge is not bound. Send /ls, then /bind <序号>.",
        updatedAt: Date.now(),
      };
    }

    if ((this.activePromptCounts.get(binding.threadId) ?? 0) > 0) {
      return {
        state: "working",
        summary: this.statusSummary(
          "Codex bridge is waiting for the current turn to finish.",
          binding.threadId,
        ),
        currentThreadId: binding.threadId,
        currentProject: binding.project,
        updatedAt: Date.now(),
      };
    }

    const readDesktopSnapshot = this.desktopIpcTransport.readThreadSnapshot?.bind(
      this.desktopIpcTransport,
    );
    let desktopSnapshotError: string | undefined;
    if (readDesktopSnapshot) {
      try {
        const snapshot = await readDesktopSnapshot(
          binding.threadId,
          Math.min(this.desktopIpcTimeoutMs, 5_000),
        );
        const runtimeType = snapshot.runtimeStatus?.type;
        const latestTurnStatus = snapshot.latestTurnStatus;
        const state = runtimeType === "active" || latestTurnStatus === "inProgress"
          ? "working"
          : runtimeType === "error" || runtimeType === "systemError" ||
              latestTurnStatus === "failed"
            ? "blocked"
            : latestTurnStatus === "completed"
              ? "completed"
              : runtimeType === "idle"
                ? "idle"
                : "unknown";
        const summary = state === "working"
          ? "Codex Desktop reports this chat is active."
          : state === "completed"
            ? "Codex Desktop reports the latest turn completed."
            : runtimeType
              ? `Codex Desktop live status: ${runtimeType}.`
              : "Codex Desktop returned a snapshot without a runtime status.";
        return {
          state,
          summary: this.statusSummary(summary, binding.threadId),
          currentThreadId: snapshot.threadId,
          currentProject: projectName(snapshot.projectPath) ?? binding.project,
          updatedAt: snapshot.updatedAt ?? Date.now(),
        };
      } catch (error) {
        desktopSnapshotError = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      const thread = await this.readThreadWithTurns(binding.threadId);
      const status = threadStatusText(thread.status);
      const latestTurn = thread.turns?.at(-1);
      const turnIsWorking = latestTurn?.status === "inProgress" &&
        !hasFinalAnswerItem(latestTurn.items ?? []) &&
        !resultFromItems(latestTurn.items ?? [], "silent").outputFiles?.length;
      const isWorking = status === "active" || status?.startsWith("active:") || turnIsWorking;
      if (readDesktopSnapshot && !isWorking) {
        const summary = desktopSnapshotError
          ? `Cannot read Codex Desktop live status: ${desktopSnapshotError}`
          : "Codex Desktop live status is unavailable.";
        return {
          state: "unknown",
          summary: this.statusSummary(summary, binding.threadId),
          currentThreadId: thread.id,
          currentProject: chatFromThread(thread).project ?? thread.cwd,
          updatedAt: Date.now(),
        };
      }
      const summary = turnIsWorking
        ? `Codex turn ${latestTurn.id} is in progress.`
        : status
          ? `Codex thread status: ${status}`
          : "Codex thread is reachable.";
      return {
        state: isWorking ? "working" : "idle",
        summary: this.statusSummary(summary, binding.threadId),
        currentThreadId: thread.id,
        currentProject: chatFromThread(thread).project ?? thread.cwd,
        updatedAt: Date.now(),
      };
    } catch (error) {
      return {
        state: "unknown",
        summary: this.statusSummary(errorDetail(error), binding.threadId),
        currentThreadId: binding.threadId,
        currentProject: binding.project,
        updatedAt: Date.now(),
      };
    }
  }

  async sendPrompt(prompt: CodexGuiPrompt): Promise<CodexGuiPromptResult> {
    const text = prompt.text.trim();
    const attachments = prompt.attachments?.filter(isUsablePromptAttachment) ?? [];
    if (!text && attachments.length === 0) {
      throw new Error("Cannot send an empty Codex prompt.");
    }
    await this.ensureBindingLoaded();
    const threadId = prompt.threadId?.trim() || this.binding?.threadId;
    if (!threadId) {
      throw new Error("Codex GUI bridge is not bound. Send /ls, then /bind <序号>.");
    }
    const replyMode = prompt.replyMode ?? this.replyMode;
    const args: PromptDeliveryArgs = {
      id: prompt.id ?? randomUUID(),
      threadId,
      text,
      attachments,
      replyMode,
    };

    if (this.deliveryMode === "desktop-ipc") {
      const result = await this.sendPromptViaDesktopIpc(args);
      this.recordDelivery("desktop-ipc", threadId);
      return result;
    }

    const shouldUseGuiAutomation = this.deliveryMode === "gui-automation" &&
      attachments.every((attachment) => attachment.kind === "file");
    if (shouldUseGuiAutomation) {
      return this.sendPromptViaGuiAutomation(args);
    }

    return this.deliverViaAppServer(args, "app-server");
  }

  private async sendPromptViaAppServer(
    args: PromptDeliveryArgs,
  ): Promise<CodexGuiPromptResult> {
    await this.ensureInitialized();
    const threadMetadata = args.attachments.length > 0
      ? await this.readThread(args.threadId)
      : undefined;
    const runtimeWorkspaceRoots = threadMetadata
      ? promptWorkspaceRoots(threadMetadata, args.attachments)
      : [];
    const resumed = await this.transport.request<ThreadResumeResponse>(
      "thread/resume",
      {
        threadId: args.threadId,
        ...(runtimeWorkspaceRoots.length ? { runtimeWorkspaceRoots } : {}),
      },
      this.timeoutMs,
    );
    const input = promptInputItems(args.text, args.attachments);
    const activeTurn = await this.activeTurnForThread(resumed.thread);
    if (activeTurn) {
      const steered = await this.transport.request<TurnSteerResponse>(
        "turn/steer",
        {
          threadId: args.threadId,
          clientUserMessageId: args.id,
          input,
          expectedTurnId: activeTurn.id,
        },
        this.timeoutMs,
      );
      const turnId = steered.turnId ?? activeTurn.id;
      const completed = await this.waitForTurnCompletion(
        args.threadId,
        turnId,
        args.replyMode,
      );
      return {
        id: args.id,
        threadId: args.threadId,
        turnId,
        replyMode: args.replyMode,
        ...completed,
      };
    }

    const response = await this.transport.request<TurnStartResponse>(
      "turn/start",
      {
        threadId: args.threadId,
        clientUserMessageId: args.id,
        input,
        ...(runtimeWorkspaceRoots.length ? { runtimeWorkspaceRoots } : {}),
      },
      this.timeoutMs,
    );
    const turnId = response.turn?.id;
    const startedTurnResult = resultFromTurn(
      response.turn,
      args.threadId,
      turnId,
      args.replyMode,
    );
    if (startedTurnResult?.finalText || isTerminalStatus(startedTurnResult?.status)) {
      return {
        id: args.id,
        threadId: args.threadId,
        turnId,
        replyMode: args.replyMode,
        ...startedTurnResult,
      };
    }

    const completed = turnId && this.transport.onNotification
      ? await this.waitForTurnCompletion(args.threadId, turnId, args.replyMode)
      : null;

    return {
      id: args.id,
      threadId: args.threadId,
      turnId,
      replyMode: args.replyMode,
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

  async getAutoOpen(): Promise<CodexGuiAutoOpenState> {
    return readCodexGuiAutoOpen({
      configPath: this.autoOpenConfigPath,
    });
  }

  async setAutoOpen(enabled: boolean): Promise<CodexGuiAutoOpenState> {
    return writeCodexGuiAutoOpen(enabled, {
      configPath: this.autoOpenConfigPath,
    });
  }

  async getAlarm(): Promise<CodexGuiAlarmState> {
    return readCodexGuiAlarm({
      configPath: this.alarmConfigPath,
    });
  }

  async setAlarm(timeText: string): Promise<CodexGuiAlarmState> {
    const state = scheduledCodexGuiAlarmState({ timeText });
    await writeCodexGuiAlarm(state, {
      configPath: this.alarmConfigPath,
    });
    this.scheduleAlarm(state);
    return state;
  }

  async clearAlarm(): Promise<CodexGuiAlarmState> {
    const state = disabledCodexGuiAlarmState();
    await writeCodexGuiAlarm(state, {
      configPath: this.alarmConfigPath,
    });
    this.clearAlarmTimer();
    return state;
  }

  async startAlarmScheduler(): Promise<void> {
    this.scheduleAlarm(await this.getAlarm());
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

  private clearAlarmTimer(): void {
    if (!this.alarmTimer) return;
    clearTimeout(this.alarmTimer);
    this.alarmTimer = undefined;
  }

  private scheduleAlarm(state: CodexGuiAlarmState): void {
    this.clearAlarmTimer();
    if (!state.enabled || !state.timeText || !state.nextFireAt) return;
    const delayMs = Math.max(0, state.nextFireAt - Date.now());
    this.alarmTimer = setTimeout(() => {
      void this.fireAlarm(state.nextFireAt);
    }, delayMs);
    this.alarmTimer.unref?.();
  }

  private async fireAlarm(expectedNextFireAt: number | undefined): Promise<void> {
    const state = await this.getAlarm();
    if (
      !state.enabled ||
      !state.timeText ||
      !state.nextFireAt ||
      state.nextFireAt !== expectedNextFireAt
    ) {
      return;
    }

    const firedAt = Date.now();
    let lastError: string | undefined;
    try {
      await this.sendPrompt({
        text: "你好",
        replyMode: "silent",
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const nextState = scheduledCodexGuiAlarmState({
      timeText: state.timeText,
      now: firedAt,
      lastFiredAt: firedAt,
      lastError,
    });
    await writeCodexGuiAlarm(nextState, {
      configPath: this.alarmConfigPath,
    });
    this.scheduleAlarm(nextState);
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

  private async deliverViaAppServer(
    args: PromptDeliveryArgs,
    mode: "app-server" | "app-server-fallback",
    guiError?: unknown,
  ): Promise<CodexGuiPromptResult> {
    try {
      const result = await this.sendPromptViaAppServer(args);
      this.recordDelivery(mode, args.threadId);
      return result;
    } catch (fallbackError) {
      if (mode !== "app-server-fallback") throw fallbackError;
      throw new Error(
        `Codex GUI automation failed: ${errorDetail(guiError)}. ` +
          `App-server fallback also failed: ${errorDetail(fallbackError)}.`,
      );
    }
  }

  private recordDelivery(
    mode: ActualDeliveryMode,
    threadId: string,
    detail?: string,
  ): void {
    this.lastDelivery = { mode, threadId };
    const suffix = detail ? ` detail=${JSON.stringify(detail)}` : "";
    console.info(`[codex-gui-bridge] delivery=${mode} thread=${threadId}${suffix}`);
  }

  private statusSummary(summary: string, threadId: string): string {
    if (!this.lastDelivery || this.lastDelivery.threadId !== threadId) return summary;
    return `${summary} Last delivery: ${this.lastDelivery.mode}.`;
  }

  private async sendPromptViaDesktopIpc(args: {
    id: string;
    threadId: string;
    text: string;
    attachments: CodexGuiPromptAttachment[];
    replyMode: CodexGuiReplyMode;
  }): Promise<CodexGuiPromptResult> {
    const thread = await this.readThreadWithTurns(args.threadId);
    const input = promptInputItems(args.text, args.attachments);
    const runtimeWorkspaceRoots = promptWorkspaceRoots(thread, args.attachments);
    const activeTurn = await this.activeTurnForThread(thread);

    if (activeTurn) {
      const steered = await this.transport.request<TurnSteerResponse>(
        "turn/steer",
        {
          threadId: args.threadId,
          clientUserMessageId: args.id,
          input,
          expectedTurnId: activeTurn.id,
        },
        this.timeoutMs,
      );
      const turnId = steered.turnId ?? activeTurn.id;
      return {
        id: args.id,
        threadId: args.threadId,
        turnId,
        replyMode: args.replyMode,
        ...await this.waitForTurnCompletion(args.threadId, turnId, args.replyMode),
      };
    }

    const startParams = {
      conversationId: args.threadId,
      turnStartParams: {
        input,
        attachments: [],
        clientUserMessageId: args.id,
        ...(runtimeWorkspaceRoots.length ? { runtimeWorkspaceRoots } : {}),
      },
    };
    let response: DesktopIpcStartTurnResponse;
    try {
      response = await this.desktopIpcTransport.request<DesktopIpcStartTurnResponse>(
        "thread-follower-start-turn",
        startParams,
        this.desktopIpcTimeoutMs,
      );
    } catch (error) {
      if (!isDesktopIpcNoClientFound(error)) throw error;
      await this.guiThreadOpener(args.threadId);
      await sleep(this.desktopIpcThreadOpenDelayMs);
      response = await this.desktopIpcTransport.request<DesktopIpcStartTurnResponse>(
        "thread-follower-start-turn",
        startParams,
        this.desktopIpcTimeoutMs,
      );
    }
    const turn = response.result?.turn;
    const turnId = turn?.id;
    if (!turnId) {
      throw new Error(
        "Codex Desktop IPC accepted the request but did not return a turn id.",
      );
    }
    const started = resultFromTurn(turn, args.threadId, turnId, args.replyMode);
    if (started?.finalText || isTerminalStatus(started?.status)) {
      return {
        id: args.id,
        threadId: args.threadId,
        turnId,
        replyMode: args.replyMode,
        ...started,
      };
    }

    return {
      id: args.id,
      threadId: args.threadId,
      turnId,
      replyMode: args.replyMode,
      ...await this.waitForTurnCompletion(args.threadId, turnId, args.replyMode),
    };
  }

  private async activeTurnForThread(thread: RawThread): Promise<RawTurn | undefined> {
    if (thread.status?.type !== "active") return undefined;
    const withTurns = thread.turns?.length ? thread : await this.readThreadWithTurns(thread.id);
    const activeTurn = [...(withTurns.turns ?? [])]
      .reverse()
      .find((turn) => turn.status === "inProgress");
    if (!activeTurn) {
      throw new Error(
        `Codex thread ${thread.id} is active, but its active turn id is unavailable. ` +
          "Wait for the current operation to settle, then retry.",
      );
    }
    return activeTurn;
  }

  private async sendPromptViaGuiAutomation(
    args: PromptDeliveryArgs,
  ): Promise<CodexGuiPromptResult> {
    return this.trackActivePrompt(args.threadId, async () => {
      const before = await this.readThreadWithTurns(args.threadId);
      const previousTurnIds = new Set((before.turns ?? []).map((turn) => turn.id));

      try {
        await this.guiPromptInjector(
          textWithAttachmentReferences(args.text, args.attachments),
          {
            threadId: args.threadId,
            threadTitle: this.binding?.threadId === args.threadId
              ? this.binding.title
              : undefined,
            threadOpenDelayMs: this.guiThreadOpenDelayMs,
          },
        );
        this.recordDelivery("gui-automation", args.threadId);
      } catch (guiError) {
        const submitted = await this.guiTurnStartedAfterInjectionError(
          args.threadId,
          previousTurnIds,
        );
        if (submitted) {
          this.recordDelivery(
            "gui-automation",
            args.threadId,
            "turn detected after GUI injector reported an error; fallback suppressed",
          );
        } else {
          console.warn(
            `[codex-gui-bridge] GUI automation unavailable for thread=${args.threadId}; ` +
              `using app-server fallback: ${errorDetail(guiError)}`,
          );
          return this.deliverViaAppServer(
            args,
            "app-server-fallback",
            guiError,
          );
        }
      }
      const completed = await this.waitForNextThreadTurn(
        args.threadId,
        previousTurnIds,
        args.replyMode,
      );

      return {
        id: args.id,
        threadId: args.threadId,
        turnId: completed.turnId,
        status: completed.status,
        finalText: completed.finalText,
        replyParts: completed.replyParts,
        ...(completed.outputFiles?.length ? { outputFiles: completed.outputFiles } : {}),
        replyMode: args.replyMode,
        error: completed.error,
      };
    });
  }

  private async guiTurnStartedAfterInjectionError(
    threadId: string,
    previousTurnIds: Set<string>,
  ): Promise<boolean> {
    const deadline = Date.now() + this.guiFallbackReconcileMs;
    while (true) {
      try {
        const thread = await this.readThreadWithTurns(threadId);
        if ((thread.turns ?? []).some((turn) => !previousTurnIds.has(turn.id))) {
          return true;
        }
      } catch (error) {
        console.warn(
          `[codex-gui-bridge] could not reconcile GUI injection for thread=${threadId}: ` +
            errorDetail(error),
        );
        return false;
      }

      if (Date.now() >= deadline) return false;
      await sleep(Math.min(this.guiPollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  private async trackActivePrompt<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    this.activePromptCounts.set(threadId, (this.activePromptCounts.get(threadId) ?? 0) + 1);
    try {
      return await task();
    } finally {
      const remaining = (this.activePromptCounts.get(threadId) ?? 1) - 1;
      if (remaining > 0) this.activePromptCounts.set(threadId, remaining);
      else this.activePromptCounts.delete(threadId);
    }
  }

  private async waitForNextThreadTurn(
    threadId: string,
    previousTurnIds: Set<string>,
    replyMode: CodexGuiReplyMode,
  ): Promise<{
    turnId?: string;
    status?: TurnStatus;
    finalText?: string;
    replyParts?: string[];
    outputFiles?: CodexGuiOutputFile[];
    error?: string;
  }> {
    const observationDeadline = Date.now() + this.turnTimeoutMs;
    let latestNewTurn: RawTurn | undefined;

    while (true) {
      const thread = await this.readThreadWithTurns(threadId);
      const newTurns = (thread.turns ?? []).filter((turn) => !previousTurnIds.has(turn.id));
      latestNewTurn = newTurns.at(-1) ?? latestNewTurn;

      if (latestNewTurn && isCompletedTurnForGuiPolling(latestNewTurn)) {
        return {
          turnId: latestNewTurn.id,
          ...resultFromTurn(latestNewTurn, threadId, latestNewTurn.id, replyMode),
        };
      }

      if (!latestNewTurn && Date.now() >= observationDeadline) {
        throw new Error(
          "Timed out waiting for a new Codex GUI turn. Make sure the Codex app is open, " +
            "the bound chat is visible, and the app running wechat2all has Accessibility permission.",
        );
      }

      await sleep(this.guiPollIntervalMs);
    }
  }

  private waitForTurnCompletion(
    threadId: string,
    turnId: string,
    replyMode: CodexGuiReplyMode,
  ): Promise<{
    status?: TurnStatus;
    finalText?: string;
    replyParts?: string[];
    outputFiles?: CodexGuiOutputFile[];
    error?: string;
  }> {
    const completedItems: ThreadItem[] = [];

    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let turnObserved = false;

      const handleObservationTimeout = () => {
        if (settled || turnObserved) return;
        settled = true;
        if (pollTimer) clearTimeout(pollTimer);
        unsubscribe?.();
        reject(new Error(
          `Codex turn ${turnId} was not observable within ${this.turnTimeoutMs}ms. ` +
            "The target thread may be busy in another Codex process.",
        ));
      };
      timeoutTimer = setTimeout(handleObservationTimeout, this.turnTimeoutMs);
      timeoutTimer.unref?.();

      const markTurnObserved = () => {
        if (turnObserved) return;
        turnObserved = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
      };

      const finish = (result: {
        status?: TurnStatus;
        finalText?: string;
        replyParts?: string[];
        outputFiles?: CodexGuiOutputFile[];
        error?: string;
      }) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (pollTimer) clearTimeout(pollTimer);
        unsubscribe?.();
        resolve(result);
      };

      const poll = async (): Promise<void> => {
        if (settled) return;
        try {
          const thread = await this.readThreadWithTurns(threadId);
          const observed = (thread.turns ?? []).find((turn) => turn.id === turnId);
          if (observed) {
            markTurnObserved();
            const items = mergeThreadItems(
              completedItems,
              observed.items ?? [],
            );
            const parsed = resultFromItems(items, replyMode);
            if (hasFinalAnswerItem(items) || parsed.outputFiles?.length) {
              finish({
                status: observed.status,
                ...parsed,
                error: errorText(observed.error),
              });
              return;
            }
            if (isTerminalStatus(observed.status)) {
              finish({
                status: observed.status,
                ...resultFromItems(
                  items,
                  replyMode,
                ),
                error: errorText(observed.error),
              });
              return;
            }
          }
        } catch {
          // Notifications remain authoritative while transient polling fails.
        }
        if (!settled) {
          pollTimer = setTimeout(poll, this.guiPollIntervalMs);
          pollTimer.unref?.();
        }
      };

      unsubscribe = this.transport.onNotification?.((method, params) => {
        if (method === "item/completed") {
          const notification = params as ItemCompletedNotification;
          if (notification.threadId !== threadId || notification.turnId !== turnId) return;
          markTurnObserved();
          if (notification.item) {
            completedItems.push(notification.item);
            const parsed = resultFromItems(completedItems, replyMode);
            if (hasFinalAnswerItem(completedItems) || parsed.outputFiles?.length) {
              finish({
                status: "inProgress",
                ...parsed,
              });
            }
          }
          return;
        }

        if (method === "turn/completed") {
          const notification = params as TurnCompletedNotification;
          if (notification.threadId !== threadId || notification.turn?.id !== turnId) return;
          markTurnObserved();
          const items = mergeThreadItems(completedItems, notification.turn.items ?? []);
          finish({
            status: notification.turn.status,
            ...resultFromItems(items, replyMode),
            error: errorText(notification.turn.error),
          });
        }
      });

      void poll();
    });
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      const attempt = (async () => {
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
      this.initialized = attempt;
      void attempt.catch(() => {
        if (this.initialized === attempt) this.initialized = undefined;
      });
    }
    return this.initialized;
  }

  private async ensureBindingLoaded(): Promise<void> {
    if (this.bindingLoaded) return;
    this.bindingLoaded = true;
    if (!this.bindingConfigPath) return;
    this.binding = await readCodexGuiBinding({
      configPath: this.bindingConfigPath,
    });
  }
}

function isTerminalStatus(status: TurnStatus | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function hasFinalAnswerItem(items: ThreadItem[]): boolean {
  return items.some((item) =>
    item.type === "agentMessage" &&
    item.phase === "final_answer" &&
    typeof item.text === "string" &&
    item.text.trim().length > 0
  );
}

function isDesktopIpcNoClientFound(error: unknown): boolean {
  return error instanceof Error && /\bno-client-found\b/i.test(error.message);
}

function isCompletedTurnForGuiPolling(turn: RawTurn): boolean {
  if (hasFinalAnswerItem(turn.items ?? [])) return true;
  if (resultFromItems(turn.items ?? [], "silent").outputFiles?.length) return true;
  if (turn.status === "completed" || turn.status === "failed") return true;
  if (turn.status !== "interrupted") return false;
  return Boolean(errorText(turn.error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUsablePromptAttachment(
  attachment: CodexGuiPromptAttachment,
): boolean {
  return (attachment.kind === "image" || attachment.kind === "file") &&
    attachment.filePath.trim().length > 0;
}

function promptInputItems(
  text: string,
  attachments: CodexGuiPromptAttachment[],
): unknown[] {
  const input: unknown[] = [];
  const textWithAttachments = textWithAttachmentReferences(text, attachments);
  if (textWithAttachments) {
    input.push({
      type: "text",
      text: textWithAttachments,
      text_elements: [],
    });
  }
  for (const attachment of attachments) {
    if (attachment.kind !== "image") continue;
    input.push({
      type: "localImage",
      path: attachment.filePath,
    });
  }
  return input;
}

function promptWorkspaceRoots(
  thread: RawThread,
  attachments: CodexGuiPromptAttachment[],
): string[] {
  const roots = [
    thread.cwd,
    ...attachments.map((attachment) => path.dirname(path.resolve(attachment.filePath))),
  ].filter((value): value is string => Boolean(value && path.isAbsolute(value)));
  return [...new Set(roots)];
}

function textWithAttachmentReferences(
  text: string,
  attachments: CodexGuiPromptAttachment[],
): string {
  const fileAttachments = attachments.filter((attachment) => attachment.kind === "file");
  if (!fileAttachments.length) return text;
  const lines = fileAttachments.map((attachment, index) => {
    const label = attachment.fileName ? `${attachment.fileName}: ` : "";
    const size = typeof attachment.size === "number" ? ` (${attachment.size} bytes)` : "";
    const mime = attachment.mimeType ? ` [${attachment.mimeType}]` : "";
    return `- file ${index + 1}: ${label}${attachment.filePath}${mime}${size}`;
  });
  return [
    ...(text ? [text, ""] : []),
    "WeChat attachments for this request are cached on this computer.",
    "Use these local paths directly when answering:",
    ...lines,
  ].join("\n");
}

const IMAGE_EXTENSIONS = "png|jpe?g|gif|webp|bmp|tiff?";
const FILE_EXTENSIONS =
  "pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|rtf|epub|json|jsonl|ya?ml|toml|ini|log|xml|html?|css|scss|less|sql|db|sqlite3?|py|js|mjs|cjs|jsx|ts|tsx|sh|zsh|fish|rs|go|java|kt|swift|c|cc|cpp|h|hpp|rb|php|tex|ics|vcf|parquet|zip|rar|7z|tar|gz|dmg|pkg|mp3|m4a|aac|amr|opus|silk|spx|wav|ogg|flac|aiff?|caf|mp4|m4v|mov|webm|mkv|avi";
const IMAGE_EXTENSION_PATTERN = new RegExp(
  `\\.(?:${IMAGE_EXTENSIONS})(?:[#?][^\\s)\\]]*)?$`,
  "i",
);
const FILE_EXTENSION_PATTERN =
  new RegExp(`\\.(?:${FILE_EXTENSIONS})(?:[#?][^\\s)\\]]*)?$`, "i");
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\(([^)\]]+)\)/g;
const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*]\(([^)\]]+)\)/g;
const FILE_URL_PATTERN = /file:\/\/[^\s)\]]+/g;
const ABSOLUTE_IMAGE_PATH_PATTERN = new RegExp(
  `\\/[^\\n\\r]+?\\.(?:${IMAGE_EXTENSIONS})(?:[#?][^\\s)\\]]*)?`,
  "gi",
);
const ABSOLUTE_FILE_PATH_PATTERN =
  new RegExp(`\\/[^\\n\\r]+?\\.(?:${FILE_EXTENSIONS})(?:[#?][^\\s)\\]]*)?`, "gi");
const FILE_PATH_KEYS = [
  "image_url",
  "imageUrl",
  "filePath",
  "file_path",
  "imagePath",
  "image_path",
  "localPath",
  "local_path",
  "outputPath",
  "output_path",
  "path",
  "savedPath",
  "saved_path",
  "url",
] as const;

function stripUrlFragment(value: string): string {
  return value.replace(/[?#].*$/, "");
}

function stripPathWrappers(value: string): string {
  return value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^["'“‘]|["'”’]$/g, "")
    .replace(/[.,;:!?，。；：！？）)]$/g, "");
}

function decodeLocalPath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function localFilePath(value: unknown, requireImageExtension = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripPathWrappers(value);
  if (!cleaned) return undefined;
  try {
    if (cleaned.startsWith("file://")) {
      const filePath = fileURLToPath(cleaned);
      if (requireImageExtension && !IMAGE_EXTENSION_PATTERN.test(filePath)) return undefined;
      return filePath;
    }
  } catch {
    return undefined;
  }
  const withoutFragment = decodeLocalPath(stripUrlFragment(cleaned));
  if (!path.isAbsolute(withoutFragment)) return undefined;
  if (requireImageExtension && !IMAGE_EXTENSION_PATTERN.test(withoutFragment)) return undefined;
  return withoutFragment;
}

function existingLocalFilePath(value: unknown, requireImageExtension = false): string | undefined {
  const filePath = localFilePath(value, requireImageExtension);
  if (!filePath || !isRegularFile(filePath)) return undefined;
  return filePath;
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function outputFileKind(filePath: string): CodexGuiOutputFile["kind"] {
  return IMAGE_EXTENSION_PATTERN.test(filePath) ? "image" : "file";
}

function outputFileFromPath(
  filePath: string | undefined,
  source: string,
): CodexGuiOutputFile | undefined {
  if (!filePath) return undefined;
  return {
    kind: outputFileKind(filePath),
    filePath,
    source,
  };
}

function outputFilesFromText(text: string, source: string): CodexGuiOutputFile[] {
  const files: CodexGuiOutputFile[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const filePath = existingLocalFilePath(match[1], true) ??
      existingLocalFilePath(match[1], false);
    const file = outputFileFromPath(filePath, "markdown");
    if (file) files.push(file);
  }
  for (const match of text.matchAll(FILE_URL_PATTERN)) {
    const filePath = existingLocalFilePath(match[0], false);
    const file = outputFileFromPath(filePath, source);
    if (file) files.push(file);
  }
  const textWithoutUrls = text
    .replace(MARKDOWN_IMAGE_PATTERN, " ")
    .replace(MARKDOWN_LINK_PATTERN, " ")
    .replace(FILE_URL_PATTERN, " ");
  for (const match of textWithoutUrls.matchAll(ABSOLUTE_IMAGE_PATH_PATTERN)) {
    const filePath = existingLocalFilePath(match[0], true);
    const file = outputFileFromPath(filePath, source);
    if (file) files.push(file);
  }
  for (const match of textWithoutUrls.matchAll(ABSOLUTE_FILE_PATH_PATTERN)) {
    const filePath = existingLocalFilePath(match[0], false);
    if (filePath && FILE_EXTENSION_PATTERN.test(filePath)) {
      const file = outputFileFromPath(filePath, source);
      if (file) files.push(file);
    }
  }
  return dedupeOutputFiles(files);
}

function imageBufferFromBase64(value: unknown): { buffer: Buffer; extension: string } | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(trimmed);
  const raw = dataUrlMatch ? dataUrlMatch[2] : trimmed;
  if (!/^[a-z0-9+/=\s]+$/i.test(raw)) return undefined;

  try {
    const buffer = Buffer.from(raw.replace(/\s+/g, ""), "base64");
    if (buffer.length < 8) return undefined;
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { buffer, extension: ".png" };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { buffer, extension: ".jpg" };
    }
    if (buffer.subarray(0, 4).toString("ascii") === "GIF8") {
      return { buffer, extension: ".gif" };
    }
    if (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return { buffer, extension: ".webp" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sanitizedImageBaseName(value: unknown): string {
  return (typeof value === "string" && value.trim() ? value.trim() : `image-${randomUUID()}`)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || `image-${randomUUID()}`;
}

function imageGenerationOutputPath(record: Record<string, unknown>, extension: string): string {
  const candidates = FILE_PATH_KEYS
    .map((key) => localFilePath(record[key], false))
    .filter((value): value is string => Boolean(value));
  const preferred = candidates.find((candidate) => isRegularFile(candidate));
  if (preferred) return preferred;

  const declared = candidates.find((candidate) => IMAGE_EXTENSION_PATTERN.test(candidate));
  if (declared && !path.basename(declared).includes("_image_id_")) return declared;

  const directory = declared
    ? path.dirname(declared)
    : path.join(os.tmpdir(), "wechat2all-codex-generated-images");
  return path.join(directory, `${sanitizedImageBaseName(record.id)}${extension}`);
}

function materializedImageGenerationFiles(
  record: Record<string, unknown>,
  source: string,
): CodexGuiOutputFile[] {
  if (record.type !== "imageGeneration") return [];
  const image = imageBufferFromBase64(record.result);
  if (!image) return [];

  const filePath = imageGenerationOutputPath(record, image.extension);
  try {
    if (existsSync(filePath) && !isRegularFile(filePath)) return [];
    if (!existsSync(filePath)) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, image.buffer);
    }
    if (!isRegularFile(filePath)) return [];
  } catch {
    return [];
  }
  return [{ kind: "image", filePath, source }];
}

function outputFilesFromUnknown(
  value: unknown,
  source: string,
  depth = 0,
): CodexGuiOutputFile[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return outputFilesFromText(value, source);
  if (Array.isArray(value)) {
    return dedupeOutputFiles(
      value.flatMap((item) => outputFilesFromUnknown(item, source, depth + 1)),
    );
  }
  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const files: CodexGuiOutputFile[] = materializedImageGenerationFiles(record, source);
  for (const key of FILE_PATH_KEYS) {
    const filePath = existingLocalFilePath(record[key], false);
    const file = outputFileFromPath(filePath, source);
    if (file) files.push(file);
  }
  if (typeof record.text === "string") {
    files.push(...outputFilesFromText(record.text, source));
  }
  if ("content" in record) {
    files.push(...outputFilesFromUnknown(record.content, source, depth + 1));
  }
  for (const key of ["items", "parts", "output", "outputs", "attachments"]) {
    if (key in record) {
      files.push(...outputFilesFromUnknown(record[key], source, depth + 1));
    }
  }
  return dedupeOutputFiles(files);
}

function outputFilesFromItems(items: ThreadItem[]): CodexGuiOutputFile[] {
  return dedupeOutputFiles(
    items
      .filter((item) => !isUserInputItem(item))
      .flatMap((item) => outputFilesFromUnknown(item, item.type ?? "item")),
  );
}

function isUserInputItem(item: ThreadItem): boolean {
  return typeof item.type === "string" && /^user/i.test(item.type);
}

function dedupeOutputFiles(files: CodexGuiOutputFile[]): CodexGuiOutputFile[] {
  const seen = new Set<string>();
  const deduped: CodexGuiOutputFile[] = [];
  for (const file of files) {
    if (seen.has(file.filePath)) continue;
    seen.add(file.filePath);
    deduped.push(file);
  }
  return deduped;
}

function agentTextPartsFromItems(items: ThreadItem[]): Array<{
  id?: string;
  phase?: string | null;
  text: string;
}> {
  const seen = new Set<string>();
  const parts: Array<{ id?: string; phase?: string | null; text: string }> = [];
  for (const item of items) {
    if (item.type !== "agentMessage" || typeof item.text !== "string") continue;
    const text = item.text.trim();
    if (!text) continue;
    const key = item.id ?? `${item.phase ?? ""}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push({ id: item.id, phase: item.phase, text });
  }
  return parts;
}

function resultFromItems(
  items: ThreadItem[],
  replyMode: CodexGuiReplyMode,
): {
  finalText?: string;
  replyParts?: string[];
  outputFiles?: CodexGuiOutputFile[];
} {
  const outputFiles = outputFilesFromItems(items);
  const mediaResult = outputFiles.length ? { outputFiles } : {};
  if (replyMode === "silent") return mediaResult;
  const agentMessages = agentTextPartsFromItems(items);
  if (replyMode === "stream") {
    const replyParts = agentMessages.map((item) => item.text);
    return {
      finalText: replyParts.length ? replyParts.join("\n\n") : undefined,
      replyParts: replyParts.length ? replyParts : undefined,
      ...mediaResult,
    };
  }

  const final = [...agentMessages].reverse().find((item) => item.phase === "final_answer");
  return final ? { finalText: final.text, ...mediaResult } : mediaResult;
}

function mergeThreadItems(first: ThreadItem[], second: ThreadItem[]): ThreadItem[] {
  const seen = new Set<string>();
  const merged: ThreadItem[] = [];
  for (const item of [...first, ...second]) {
    const key = item.id ?? `${item.type ?? ""}:${item.phase ?? ""}:${item.text ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
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
  replyMode: CodexGuiReplyMode,
): {
  status?: TurnStatus;
  finalText?: string;
  replyParts?: string[];
  outputFiles?: CodexGuiOutputFile[];
  error?: string;
} | null {
  if (!turn) return null;
  return {
    status: turn.status,
    ...resultFromItems(turn.items ?? [], replyMode),
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
    desktopIpcSocketPath: stripEnvQuotes(env.WECHAT2ALL_CODEX_DESKTOP_IPC_SOCKET),
    desktopIpcTimeoutMs: envNumber(env, "WECHAT2ALL_CODEX_DESKTOP_IPC_TIMEOUT_MS"),
    desktopIpcThreadOpenDelayMs: envNumber(
      env,
      "WECHAT2ALL_CODEX_DESKTOP_IPC_THREAD_OPEN_DELAY_MS",
    ),
    bindingConfigPath: codexGuiBindingConfigPath({
      env,
      configPath: stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_BINDING_FILE),
    }),
    autoOpenConfigPath: stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_AUTOOPEN_FILE),
    alarmConfigPath: stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_ALARM_FILE),
    enableAlarmScheduler: opts.enableAlarmScheduler,
    defaultThreadId: stripEnvQuotes(env.WECHAT2ALL_CODEX_THREAD_ID),
    deliveryMode: parseDeliveryMode(env.WECHAT2ALL_CODEX_DELIVERY),
    replyMode: parseReplyMode(env.WECHAT2ALL_CODEX_REPLY_MODE),
    timeoutMs: envNumber(env, "WECHAT2ALL_CODEX_APP_SERVER_TIMEOUT_MS"),
    turnTimeoutMs: envNumber(env, "WECHAT2ALL_CODEX_TURN_TIMEOUT_MS"),
    inProgressGraceMs: envNumber(env, "WECHAT2ALL_CODEX_IN_PROGRESS_GRACE_MS"),
    compactionGraceMs: envNumber(env, "WECHAT2ALL_CODEX_COMPACTION_GRACE_MS"),
    guiPollIntervalMs: envNumber(env, "WECHAT2ALL_CODEX_GUI_POLL_INTERVAL_MS"),
    guiThreadOpenDelayMs: envNumber(env, "WECHAT2ALL_CODEX_GUI_THREAD_OPEN_DELAY_MS"),
    guiFallbackReconcileMs: envNumber(
      env,
      "WECHAT2ALL_CODEX_GUI_FALLBACK_RECONCILE_MS",
    ),
    listLimit: envNumber(env, "WECHAT2ALL_CODEX_LIST_LIMIT"),
  });
}

function parseDeliveryMode(
  value: string | undefined,
): CodexGuiDeliveryMode | undefined {
  const mode = stripEnvQuotes(value);
  if (
    mode === "app-server" ||
    mode === "desktop-ipc" ||
    mode === "gui-automation"
  ) return mode;
  return undefined;
}

export function parseReplyMode(
  value: string | undefined,
): CodexGuiReplyMode | undefined {
  const mode = stripEnvQuotes(value)?.toLowerCase();
  if (mode === "final" || mode === "silent" || mode === "stream") return mode;
  return undefined;
}
