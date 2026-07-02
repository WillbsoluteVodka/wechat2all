import { randomUUID } from "node:crypto";

import type {
  RuntimeAction,
  RuntimeConnector,
  RuntimeHandlerContext,
  RuntimeMessage,
} from "../types.js";

export type CodexBridgeStatusState =
  | "idle"
  | "working"
  | "completed"
  | "blocked"
  | "unknown";

export interface CodexBridgeStatus {
  state: CodexBridgeStatusState;
  summary?: string;
  currentThreadId?: string;
  currentProject?: string;
  updatedAt?: number;
}

export interface CodexBridgeThread {
  id: string;
  title?: string;
  project?: string;
  projectPath?: string;
  status?: string;
  updatedAt?: number;
  preview?: string;
}

export interface CodexBridgeBinding {
  threadId: string;
  title?: string;
  project?: string;
  boundAt?: number;
}

export interface CodexBridgeTarget {
  profileId: string;
  conversationId: string;
  senderId?: string;
  contextToken?: string;
  updatedAt: number;
}

export interface CodexBridgePrompt {
  id: string;
  createdAt: number;
  profileId: string;
  conversationId: string;
  senderId: string;
  text: string;
  sourceMessageId: string;
  contextToken?: string;
  routeId?: string;
  replyMode?: CodexReplyMode;
}

export interface CodexBridgeSendPromptResult {
  id: string;
  threadId?: string;
  turnId?: string;
  finalText?: string;
  replyParts?: string[];
  replyMode?: CodexReplyMode;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  error?: string;
}

export type CodexReplyMode = "final" | "silent" | "stream";

export interface CodexAutoOpenState {
  enabled: boolean;
  updatedAt?: number;
}

export interface CodexAlarmState {
  enabled: boolean;
  timeText?: string;
  nextFireAt?: number;
  updatedAt?: number;
  lastFiredAt?: number;
  lastError?: string;
}

export interface CodexBridgeClient {
  getStatus(): Promise<CodexBridgeStatus>;
  listThreads?(): Promise<CodexBridgeThread[]>;
  listChats?(): Promise<CodexBridgeThread[]>;
  bindThread?(threadId: string): Promise<CodexBridgeBinding>;
  getCurrentBinding?(): Promise<CodexBridgeBinding | null>;
  getTokenUsage?(): Promise<CodexTokenUsage>;
  getAutoOpen?(): Promise<CodexAutoOpenState>;
  setAutoOpen?(enabled: boolean): Promise<CodexAutoOpenState>;
  getAlarm?(): Promise<CodexAlarmState>;
  setAlarm?(timeText: string): Promise<CodexAlarmState>;
  clearAlarm?(): Promise<CodexAlarmState>;
  sendPrompt?(prompt: CodexBridgePrompt): Promise<CodexBridgeSendPromptResult>;
  setDefaultTarget?(target: CodexBridgeTarget): Promise<void>;
  getDefaultTarget?(): Promise<CodexBridgeTarget | null>;
}

export interface CodexTokenWindow {
  label: string;
  remainingText: string | null;
  resetText: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexTokenUsage {
  windows: CodexTokenWindow[];
  resetCreditsText: string | null;
}

export type CodexTokenUsageReader = () => Promise<CodexTokenUsage>;

const CODEX_HEADER_PREFIX = "◆ Codex";

export interface CodexConnectorOptions {
  id: string;
  name?: string;
  client: CodexBridgeClient;
  commandPrefixes?: string[];
  tokenUsageReader?: CodexTokenUsageReader;
  replyMode?: CodexReplyMode;
}

function messageText(message: RuntimeMessage): string {
  return message.text?.trim() ?? "";
}

function stripPrefix(text: string, prefixes: string[]): string {
  const normalized = text.trim();
  for (const prefix of prefixes) {
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      return normalized.slice(prefix.length).trim();
    }
  }
  return normalized;
}

function isStatusCommand(text: string): boolean {
  return text.trim() === "/status";
}

function isThreadListCommand(text: string): boolean {
  return /^(ls|chats?|threads?|projects?|list|列表|会话|项目)$/i.test(text);
}

function isHelpCommand(text: string): boolean {
  return /^(help|帮助|commands|命令)$/i.test(text);
}

function isTokenCommand(text: string): boolean {
  return /^\/?token$/i.test(text);
}

function commandText(text: string): string {
  return text.trim().replace(/^\/+/, "").trim();
}

export function parseCodexReplyMode(value: string | undefined): CodexReplyMode | undefined {
  const mode = value?.trim().toLowerCase();
  if (mode === "final" || mode === "silent" || mode === "stream") return mode;
  return undefined;
}

function parseModeCommand(text: string): CodexReplyMode | "show" | null {
  const match = text.trim().match(/^\/mode(?:\s+(.+))?$/i);
  if (!match) return null;
  const rawMode = match[1]?.trim();
  if (!rawMode) return "show";
  return parseCodexReplyMode(rawMode) ?? null;
}

function parseAutoOpenCommand(text: string): boolean | "show" | null {
  const match = text.trim().match(/^\/autoopen(?:\s+(.+))?$/i);
  if (!match) return null;
  const raw = match[1]?.trim().toLowerCase();
  if (!raw) return "show";
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  return null;
}

function parseAlarmCommand(text: string): string | "show" | "off" | null {
  const match = text.trim().match(/^\/alarm(?:\s+(.+))?$/i);
  if (!match) return null;
  const raw = match[1]?.trim();
  if (!raw) return "show";
  if (["0", "off", "disable", "disabled", "关闭"].includes(raw.toLowerCase())) return "off";
  return raw;
}

function isCurrentCommand(text: string): boolean {
  return /^(current|pwd|binding|where|当前|绑定)$/i.test(text);
}

function parseBindThreadId(text: string): string | null {
  const match = text.match(/^bind(?:\s+|=)(.+)$/i);
  const threadId = match?.[1]?.trim();
  return threadId || null;
}

function isBindIndex(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

function bindCacheKey(message: RuntimeMessage): string {
  return `${message.profileId}\u0000${message.conversationId}`;
}

function conversationQueueKey(message: RuntimeMessage): string {
  return `${message.profileId}\u0000${message.conversationId}`;
}

function enqueueConversationTask<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.finally(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return current;
}

function visibleBindableThreads(threads: CodexBridgeThread[]): CodexBridgeThread[] {
  return threads.slice(0, 12);
}

async function readBindableThreads(client: CodexBridgeClient): Promise<CodexBridgeThread[]> {
  if (client.listChats) return client.listChats();
  if (client.listThreads) return client.listThreads();
  return [];
}

function formatTime(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "unknown";
}

function projectLabel(thread: CodexBridgeThread): string {
  const project = thread.project ?? thread.projectPath;
  if (!project) return "未归档项目";
  const parts = project.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? project;
}

function compactTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized.length > 32 ? `${normalized.slice(0, 31)}...` : normalized;
}

function statusSummaryText(summary: string): string {
  const normalized = summary.trim();
  if (/not bound/i.test(normalized) && /\/bind/i.test(normalized)) {
    return "还没有绑定 Codex chat。";
  }
  return normalized;
}

function formatStatus(status: CodexBridgeStatus): string {
  const label: Record<CodexBridgeStatusState, string> = {
    idle: "空闲",
    working: "正在工作",
    completed: "已完成",
    blocked: "被阻塞",
    unknown: "未知 / 未连接",
  };
  const hasBinding = Boolean(status.currentThreadId || status.currentProject);
  const summary = status.summary ? statusSummaryText(status.summary) : undefined;
  const isUnbound = !hasBinding && summary === "还没有绑定 Codex chat。";

  if (isUnbound) {
    return codexPanel([
      "codex / status",
      "",
      "- 当前没有绑定 Codex chat",
      "- /ls 查看可绑定的 chat",
      "- /bind <序号> 绑定一个 chat",
    ]);
  }

  const headline = status.state === "working"
    ? "Codex 正在处理任务"
    : `Codex ${label[status.state] ?? status.state}`;

  return codexPanel([
    "codex / status",
    "",
    `- ${headline}`,
    status.currentThreadId ? `- 当前 chat: ${status.currentThreadId}` : undefined,
    status.currentProject ? `- 项目: ${status.currentProject}` : undefined,
    summary ? `- 说明: ${summary}` : undefined,
    `- 更新时间: ${formatTime(status.updatedAt)}`,
  ]);
}

function formatThreads(threads: CodexBridgeThread[]): string {
  if (!threads.length) {
    return codexPanel([
      "codex / chats",
      "",
      "Codex GUI bridge 没有找到可绑定的 chat。",
    ]);
  }
  const visibleThreads = visibleBindableThreads(threads);
  const groupedThreads = new Map<string, Array<{ thread: CodexBridgeThread; index: number }>>();
  visibleThreads.forEach((thread, index) => {
    const label = projectLabel(thread);
    const group = groupedThreads.get(label) ?? [];
    group.push({ thread, index });
    groupedThreads.set(label, group);
  });

  const projectLines = Array.from(groupedThreads.entries()).flatMap(([project, items]) => [
    `- ${project}`,
    ...items.flatMap(({ thread, index }) => [
      `  ${index + 1}. ${compactTitle(thread.title ?? thread.id)}`,
      "",
    ]),
  ]);
  if (projectLines.at(-1) === "") projectLines.pop();

  return codexPanel([
    "chats",
    "",
    `最近 ${visibleThreads.length} 个可绑定 chat`,
    "",
    ...projectLines,
  ]);
}

function formatBinding(binding: CodexBridgeBinding | null): string {
  if (!binding) {
    return codexPanel([
      "codex / binding",
      "",
      "- 当前没有绑定 Codex chat",
      "- /ls 查看可绑定的 chat",
      "- /bind <序号> 绑定一个 chat",
    ]);
  }
  return codexPanel([
    "codex / binding",
    "",
    "- 当前已绑定 Codex chat",
    binding.title ? `- chat: ${binding.title}` : undefined,
    binding.project ? `- 项目: ${binding.project}` : undefined,
    `- id: ${binding.threadId}`,
    binding.boundAt ? `- 绑定时间: ${formatTime(binding.boundAt)}` : undefined,
  ]);
}

function formatReplyMode(mode: CodexReplyMode): string {
  const description: Record<CodexReplyMode, string> = {
    final: "只返回 Codex 最终回复，忽略 thinking / commentary。",
    silent: "等待任务完成后只通知完成，不返回正文。",
    stream: "返回这个 turn 里的所有 Codex 文本片段。",
  };
  return codexPanel([
    "codex / mode",
    "",
    `- 当前模式: ${mode}`,
    `- 说明: ${description[mode]}`,
    "- 可选模式: final / silent / stream",
  ]);
}

function formatAutoOpen(state: CodexAutoOpenState): string {
  return codexPanel([
    "codex / autoopen",
    "",
    `- 当前状态: ${state.enabled ? "1 / enabled" : "0 / disabled"}`,
    state.updatedAt ? `- 更新时间: ${formatTime(state.updatedAt)}` : undefined,
    "",
    "/autoopen 1",
    "  启动 wechat2all 时自动打开 Codex GUI",
    "",
    "/autoopen 0",
    "  启动 wechat2all 时不自动打开 Codex GUI",
  ]);
}

function formatAlarm(state: CodexAlarmState): string {
  if (!state.enabled) {
    return codexPanel([
      "codex / alarm",
      "",
      "- 当前状态: disabled",
      "",
      "/alarm 09:30",
      "  设置 24 小时制时间，到点向当前绑定的 Codex chat 发送 dummy 你好",
      "",
      "/alarm off",
      "  关闭这个定时触发",
    ]);
  }
  return codexPanel([
    "codex / alarm",
    "",
    "- 当前状态: enabled",
    state.timeText ? `- 每日时间: ${state.timeText}` : undefined,
    state.nextFireAt ? `- 下次触发: ${formatTime(state.nextFireAt)}` : undefined,
    state.lastFiredAt ? `- 上次触发: ${formatTime(state.lastFiredAt)}` : undefined,
    state.lastError ? `- 上次错误: ${state.lastError}` : undefined,
    "",
    "触发内容:",
    "  你好",
  ]);
}

function helpText(replyMode: CodexReplyMode): string {
  return codexPanel([
    "codex / help",
    "",
    "/status",
    "  查询 Codex 当前状态",
    "",
    "/token",
    "  查询 Codex usage 剩余额度",
    "",
    "/ls",
    "  查看可绑定的 Codex chats",
    "",
    "/bind <序号>",
    "  绑定 /ls 里对应编号的 Codex chat",
    "  也支持完整 thread id",
    "",
    "/current",
    "  查看当前绑定",
    "",
    "/mode final|silent|stream",
    `  设置微信返回模式，当前：${replyMode}`,
    "",
    "/autoopen 1|0",
    "  设置启动 wechat2all 时是否自动打开 Codex GUI",
    "",
    "/alarm <HH:mm>",
    "  设置 24 小时制时间，到点向绑定的 Codex chat 发送 dummy 你好",
    "",
    "任意普通文本",
    "  发送到已绑定的 Codex chat",
    "",
    "/cd ..",
    "  回到主 Router",
  ]);
}

async function rememberTarget(
  client: CodexBridgeClient,
  message: RuntimeMessage,
): Promise<void> {
  if (!client.setDefaultTarget || !message.replyToken?.contextToken) return;
  await client.setDefaultTarget({
    profileId: message.profileId,
    conversationId: message.conversationId,
    senderId: message.senderId,
    contextToken: message.replyToken.contextToken,
    updatedAt: Date.now(),
  });
}

function textAction(message: RuntimeMessage, text: string): RuntimeAction[] {
  return [{
    type: "send_text",
    conversationId: message.conversationId,
    text,
  }];
}

function cleanCodexLine(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  return line.replace(/\s+$/g, "");
}

function titleCaseAscii(value: string): string {
  return value.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function codexHeader(title: string | undefined): string {
  const normalized = title?.trim();
  if (!normalized) return CODEX_HEADER_PREFIX;
  const okMatch = normalized.match(/^ok:\s*(.+)$/i);
  const errorMatch = normalized.match(/^error:\s*(.+)$/i);
  const rawLabel = okMatch?.[1] ?? errorMatch?.[1] ?? normalized;
  const label = rawLabel
    .replace(/^codex\s*\/\s*/i, "")
    .replace(/^codex\s+/i, "")
    .trim();
  const display = errorMatch
    ? `Error: ${label || rawLabel}`
    : label || rawLabel;
  return `${CODEX_HEADER_PREFIX} - ${titleCaseAscii(display)}`;
}

function codexPanel(lines: Array<string | undefined>): string {
  const body = lines
    .map(cleanCodexLine)
    .filter((line): line is string => line !== undefined);
  const [title, ...content] = body;
  const trimmedContent = content[0] === "" ? content.slice(1) : content;
  return [
    codexHeader(title),
    "",
    ...trimmedContent,
  ].join("\n");
}

function codexUsage(command: string, description?: string): string {
  return codexPanel([
    "usage",
    "",
    command,
    description ? `  ${description}` : undefined,
  ]);
}

function codexError(title: string, lines: Array<string | undefined>): string {
  return codexPanel([
    `error: ${title}`,
    "",
    ...lines,
  ]);
}

function codexOk(title: string, lines: Array<string | undefined>): string {
  return codexPanel([
    `ok: ${title}`,
    "",
    ...lines,
  ]);
}

async function resolveBindTarget(
  client: CodexBridgeClient,
  bindTarget: string,
  cachedThreads: Map<string, CodexBridgeThread[]>,
  cacheKey: string,
): Promise<{ threadId: string } | { error: string }> {
  if (!isBindIndex(bindTarget)) return { threadId: bindTarget };

  const index = Number.parseInt(bindTarget, 10);
  let threads = cachedThreads.get(cacheKey);
  if (!threads?.length) {
    threads = visibleBindableThreads(await readBindableThreads(client));
    if (threads.length) cachedThreads.set(cacheKey, threads);
  }

  if (!threads.length) {
    return {
      error: codexError("bind index unavailable", [
        `没有找到编号 ${bindTarget}。`,
        "先发送 /ls 查看可绑定的 chats，然后使用 /bind 1。",
      ]),
    };
  }

  const thread = threads[index - 1];
  if (!thread) {
    return {
      error: codexError("bind index unavailable", [
        `没有找到编号 ${bindTarget}。`,
        `当前可选范围：1-${threads.length}`,
        "发送 /ls 刷新列表，然后重新绑定。",
      ]),
    };
  }

  return { threadId: thread.id };
}

function formatTokenUsageForWechat(usage: CodexTokenUsage): string {
  const primary = usage.windows.find((window) => window.label === "5h") ??
    usage.windows[0] ?? null;
  const secondary = usage.windows.find((window) => window.label === "Weekly") ??
    usage.windows[1] ?? null;

  return codexPanel([
    "codex / token",
    "",
    `- ${primary?.label ?? "5h"}: ${primary?.remainingText ?? "unknown"} ${primary?.resetText ?? "unknown"}`,
    `- ${secondary?.label ?? "Weekly"}: ${secondary?.remainingText ?? "unknown"} ${secondary?.resetText ?? "unknown"}`,
    `- ${usage.resetCreditsText ?? "reset credits unavailable"}`,
  ]);
}

export function createCodexConnector(opts: CodexConnectorOptions): RuntimeConnector {
  const prefixes = opts.commandPrefixes ?? [];
  const tokenUsageReader = opts.tokenUsageReader ??
    opts.client.getTokenUsage?.bind(opts.client);
  let replyMode: CodexReplyMode = opts.replyMode ?? "final";
  const cachedBindableThreads = new Map<string, CodexBridgeThread[]>();
  const conversationQueues = new Map<string, Promise<void>>();
  return {
    id: opts.id,
    name: opts.name ?? "Codex Bridge",
    async handleMessage(message, context: RuntimeHandlerContext) {
      if (message.text?.trim() === "/cd ..") {
        context.routes.clearConversationRoute(message.profileId, message.conversationId);
        return textAction(
          message,
          codexOk("returned", [
            "已退回主 Router。",
            "",
            "next:",
            "  普通聊天",
            "  /ls",
          ]),
        );
      }

      return enqueueConversationTask(
        conversationQueues,
        conversationQueueKey(message),
        async () => {
      await rememberTarget(opts.client, message);
      const text = stripPrefix(messageText(message), prefixes);
      const command = commandText(text);

      if (isTokenCommand(command)) {
        if (!tokenUsageReader) {
          return textAction(
            message,
            codexError("token unavailable", [
              "当前 Codex backend 不支持 /token。",
              "请使用 gui-app-server backend，或给 Codex connector 传入 tokenUsageReader。",
            ]),
          );
        }
        try {
          return textAction(message, formatTokenUsageForWechat(await tokenUsageReader()));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return textAction(message, codexError("token read failed", [detail]));
        }
      }

      if (isHelpCommand(command)) {
        return textAction(message, helpText(replyMode));
      }

      if (isStatusCommand(text)) {
        return textAction(message, formatStatus(await opts.client.getStatus()));
      }

      const nextReplyMode = parseModeCommand(text);
      if (nextReplyMode) {
        if (nextReplyMode !== "show") replyMode = nextReplyMode;
        return textAction(message, formatReplyMode(replyMode));
      }

      const nextAutoOpen = parseAutoOpenCommand(text);
      if (nextAutoOpen !== null) {
        if (!opts.client.getAutoOpen || !opts.client.setAutoOpen) {
          return textAction(
            message,
            codexError("autoopen unavailable", [
              "当前 Codex backend 不支持 /autoopen。",
              "请检查 router-daemon 是否正在使用 codex-gui-bridge。",
            ]),
          );
        }
        try {
          const state = nextAutoOpen === "show"
            ? await opts.client.getAutoOpen()
            : await opts.client.setAutoOpen(nextAutoOpen);
          return textAction(message, formatAutoOpen(state));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return textAction(message, codexError("autoopen failed", [detail]));
        }
      }

      const nextAlarm = parseAlarmCommand(text);
      if (nextAlarm !== null) {
        if (!opts.client.getAlarm || !opts.client.setAlarm || !opts.client.clearAlarm) {
          return textAction(
            message,
            codexError("alarm unavailable", [
              "当前 Codex backend 不支持 /alarm。",
              "请检查 router-daemon 是否正在使用 codex-gui-bridge。",
            ]),
          );
        }
        try {
          const state = nextAlarm === "show"
            ? await opts.client.getAlarm()
            : nextAlarm === "off"
              ? await opts.client.clearAlarm()
              : await opts.client.setAlarm(nextAlarm);
          return textAction(message, formatAlarm(state));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return textAction(message, codexError("alarm failed", [detail]));
        }
      }

      if (isThreadListCommand(command)) {
        const threads = await readBindableThreads(opts.client);
        cachedBindableThreads.set(bindCacheKey(message), visibleBindableThreads(threads));
        return textAction(message, formatThreads(threads));
      }

      if (isCurrentCommand(command)) {
        const binding = opts.client.getCurrentBinding
          ? await opts.client.getCurrentBinding()
          : null;
        return textAction(message, formatBinding(binding));
      }

      const bindTarget = parseBindThreadId(command);
      if (bindTarget) {
        if (!opts.client.bindThread) {
          return textAction(
            message,
            codexError("bind unavailable", [
              "当前 Codex backend 不支持 /bind。",
              "请检查 router-daemon 是否正在使用 codex-gui-bridge。",
            ]),
          );
        }
        try {
          const resolved = await resolveBindTarget(
            opts.client,
            bindTarget,
            cachedBindableThreads,
            bindCacheKey(message),
          );
          if ("error" in resolved) return textAction(message, resolved.error);
          return textAction(
            message,
            formatBinding(await opts.client.bindThread(resolved.threadId)),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return textAction(message, codexError("bind failed", [detail]));
        }
      }

      if (text.startsWith("/")) {
        return [{ type: "noop", reason: `unknown codex route command: ${text}` }];
      }

      if (!opts.client.sendPrompt) {
        return textAction(
          message,
          codexError("send unavailable", [
            "Codex bridge 还没有接入 sendPrompt。",
          ]),
        );
      }

      if (opts.client.getCurrentBinding && !(await opts.client.getCurrentBinding())) {
        return textAction(
          message,
          codexUsage("/bind <序号>", "Codex GUI bridge 还没有绑定 chat。先 /ls 再绑定。"),
        );
      }

      const prompt: CodexBridgePrompt = {
        id: randomUUID(),
        createdAt: Date.now(),
        profileId: message.profileId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        text,
        sourceMessageId: message.id,
        contextToken: message.replyToken?.contextToken,
        routeId: context.route.id,
        replyMode,
      };
      let result: CodexBridgeSendPromptResult;
      try {
        result = await opts.client.sendPrompt(prompt);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return textAction(
          message,
          codexError("codex gui failed", [detail]),
        );
      }
      if (result.error) {
        return textAction(
          message,
          codexError("codex gui failed", [
            result.threadId ? `Thread ID: ${result.threadId}` : undefined,
            result.turnId ? `Turn ID: ${result.turnId}` : undefined,
            `Error: ${result.error}`,
          ]),
        );
      }
      if (replyMode === "silent" && result.threadId) {
        return textAction(
          message,
          codexOk("codex / done", [
            "Codex 已完成这次任务。",
            `Thread ID: ${result.threadId}`,
            result.turnId ? `Turn ID: ${result.turnId}` : undefined,
          ]),
        );
      }
      const replyParts = result.replyParts?.filter((part) => part.trim().length > 0) ?? [];
      if (replyMode === "stream" && replyParts.length) {
        return replyParts.map((part) => ({
          type: "send_text",
          conversationId: message.conversationId,
          text: part,
        }));
      }
      if (result.finalText) return textAction(message, result.finalText);
      if (result.threadId) {
        return textAction(
          message,
          codexPanel([
            "codex / sent",
            "",
            result.status === "inProgress"
              ? "Codex GUI chat 仍在处理，暂时只拿到部分/无最终回复。"
              : "已发送到 Codex GUI chat，但没有拿到最终文本回复。",
            `Thread ID: ${result.threadId}`,
            result.turnId ? `Turn ID: ${result.turnId}` : undefined,
          ]),
        );
      }
      return textAction(
        message,
        codexOk("codex inbox", [
          `Prompt ID: ${result.id}`,
        ]),
      );
        },
      );
    },
  };
}
