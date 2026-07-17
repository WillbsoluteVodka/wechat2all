import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { getMimeFromFilename } from "wechat2all";

import type {
  RuntimeAction,
  RuntimeConnector,
  RuntimeHandlerContext,
  RuntimeMessage,
} from "../types.js";
import type { RuntimeMediaCacheStats } from "../media/pipeline.js";
import { createCodexProcessingReminderPicker } from "./codex-processing-reminders.js";

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
  attachments?: CodexBridgePromptAttachment[];
  sourceMessageId: string;
  contextToken?: string;
  routeId?: string;
  replyMode?: CodexReplyMode;
}

export interface CodexBridgePromptAttachment {
  kind: "image" | "file";
  filePath: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
}

export interface CodexBridgeOutputFile {
  kind: "image" | "file";
  filePath: string;
  mimeType?: string;
  source?: string;
}

export interface CodexBridgeSendPromptResult {
  id: string;
  threadId?: string;
  turnId?: string;
  finalText?: string;
  replyParts?: string[];
  outputFiles?: CodexBridgeOutputFile[];
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
  imagePromptReminderMs?: number;
  imagePendingTtlMs?: number;
  imageMaxCount?: number;
  processingReminderMs?: number;
}

interface PendingImageState {
  attachments: CodexBridgePromptAttachment[];
  sourceMessageId: string;
  updatedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  timerVersion: number;
}

interface CodexActionTiming {
  attachmentDownloadMs?: number;
  attachmentWaitMs?: number;
  codexTurnMs?: number;
}

const DEFAULT_IMAGE_PROMPT_REMINDER_MS = 15_000;
const DEFAULT_IMAGE_PENDING_TTL_MS = 30 * 60_000;
const DEFAULT_IMAGE_MAX_COUNT = 9;
const DEFAULT_PROCESSING_REMINDER_MS = 2 * 60_000;
const ATTACHMENT_PROMPT_REMINDER_TEXT = "请问想对这些附件做什么操作？";

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

function parseCacheCommand(text: string): "show" | "clear" | "invalid" | null {
  const match = text.trim().match(/^\/cache(?:\s+(.+))?$/i);
  if (!match) return null;
  const raw = match[1]?.trim().toLowerCase();
  if (!raw || ["status", "info", "ls", "show"].includes(raw)) return "show";
  if (["clear", "clean", "purge", "rm", "reset", "清理", "清空"].includes(raw)) return "clear";
  return "invalid";
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

function pendingImageKey(message: RuntimeMessage): string {
  return `${message.profileId}\u0000${message.conversationId}\u0000${message.senderId}`;
}

function clearPendingImageState(
  pendingImages: Map<string, PendingImageState>,
  key: string,
): void {
  const state = pendingImages.get(key);
  if (state?.timer) clearTimeout(state.timer);
  pendingImages.delete(key);
}

function clearPendingImageStatesForProfile(
  pendingImages: Map<string, PendingImageState>,
  profileId: string,
): void {
  const prefix = `${profileId}\u0000`;
  for (const key of pendingImages.keys()) {
    if (key.startsWith(prefix)) clearPendingImageState(pendingImages, key);
  }
}

function freshPendingImageState(
  pendingImages: Map<string, PendingImageState>,
  key: string,
  ttlMs: number,
): PendingImageState | undefined {
  const state = pendingImages.get(key);
  if (!state) return undefined;
  if (Date.now() - state.updatedAt <= ttlMs) return state;
  clearPendingImageState(pendingImages, key);
  return undefined;
}

function schedulePendingImageReminder(params: {
  pendingImages: Map<string, PendingImageState>;
  key: string;
  message: RuntimeMessage;
  context: RuntimeHandlerContext;
  delayMs: number;
}): void {
  const state = params.pendingImages.get(params.key);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timerVersion += 1;
  const timerVersion = state.timerVersion;
  state.timer = setTimeout(() => {
    const latest = params.pendingImages.get(params.key);
    if (!latest || latest.timerVersion !== timerVersion) return;
    latest.timer = undefined;
    const dispatched = params.context.dispatchActions?.(textAction(
      params.message,
      ATTACHMENT_PROMPT_REMINDER_TEXT,
    ));
    void dispatched?.catch(() => undefined);
  }, params.delayMs);
  state.timer.unref?.();
}

function suspendPendingImageReminder(state: PendingImageState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.timerVersion += 1;
}

function startProcessingReminder(params: {
  message: RuntimeMessage;
  context: RuntimeHandlerContext;
  intervalMs: number;
}): () => void {
  const dispatchActions = params.context.dispatchActions;
  if (!dispatchActions || params.intervalMs <= 0) return () => undefined;

  const nextReminderText = createCodexProcessingReminderPicker();
  let dispatching = false;
  const timer = setInterval(() => {
    if (dispatching) return;
    dispatching = true;
    void dispatchActions(
      textAction(params.message, nextReminderText()),
    ).catch(() => undefined).finally(() => {
      dispatching = false;
    });
  }, params.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
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

function existingPromptAttachments(
  attachments: CodexBridgePromptAttachment[],
): CodexBridgePromptAttachment[] {
  return attachments.filter((attachment) => isRegularFile(attachment.filePath));
}

function retainPendingAttachmentsAfterFailure(params: {
  pendingImages: Map<string, PendingImageState>;
  key: string;
  attachments: CodexBridgePromptAttachment[];
  sourceMessageId: string;
}): void {
  const attachments = existingPromptAttachments(params.attachments);
  if (!attachments.length) return;
  const previous = params.pendingImages.get(params.key);
  if (previous) suspendPendingImageReminder(previous);
  params.pendingImages.set(params.key, {
    attachments,
    sourceMessageId: params.sourceMessageId,
    updatedAt: Date.now(),
    timerVersion: (previous?.timerVersion ?? 0) + 1,
  });
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
    "/cache",
    "  查看本地附件 cache 的路径、文件数和大小",
    "",
    "/cache clear",
    "  清理当前 profile 的附件 cache",
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

function withCodexTiming(
  actions: RuntimeAction[],
  timing: CodexActionTiming,
): RuntimeAction[] {
  const hasTiming = Object.values(timing).some((value) => typeof value === "number");
  if (!hasTiming) return actions;
  return actions.map((action) => ({
    ...action,
    metadata: {
      ...action.metadata,
      performance: timing,
    },
  }));
}

function mediaActions(
  message: RuntimeMessage,
  outputFiles: CodexBridgeOutputFile[] | undefined,
): RuntimeAction[] {
  return (outputFiles ?? [])
    .filter((file) => isSendableOutputFile(file))
    .map((file) => outputFileAction(message, file));
}

function isSendableOutputFile(file: CodexBridgeOutputFile): boolean {
  return (file.kind === "image" || file.kind === "file") &&
    file.filePath.trim().length > 0 &&
    isRegularFile(file.filePath);
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function outputFileMimeType(file: CodexBridgeOutputFile): string {
  return file.mimeType ?? getMimeFromFilename(file.filePath);
}

function isVoiceOutputFile(file: CodexBridgeOutputFile): boolean {
  const mimeType = outputFileMimeType(file);
  if (!mimeType.startsWith("audio/")) return false;
  return /\.(?:silk|amr|mp3|ogg|spx|wav|pcm)$/i.test(file.filePath);
}

function outputFileAction(
  message: RuntimeMessage,
  file: CodexBridgeOutputFile,
): RuntimeAction {
  if (isVoiceOutputFile(file)) {
    return {
      type: "send_voice",
      conversationId: message.conversationId,
      filePath: file.filePath,
    };
  }
  return {
    type: "send_media",
    conversationId: message.conversationId,
    filePath: file.filePath,
  };
}

function missingOutputFiles(
  outputFiles: CodexBridgeOutputFile[] | undefined,
): CodexBridgeOutputFile[] {
  return (outputFiles ?? []).filter((file) =>
    (file.kind === "image" || file.kind === "file") &&
    file.filePath.trim().length > 0 &&
    !isRegularFile(file.filePath),
  );
}

const MARKDOWN_FILE_REFERENCE_PATTERN = /!?\[[^\]]*]\(([^)\]]+)\)/g;
const FILE_URL_REFERENCE_PATTERN = /file:\/\/[^\s)\]]+/g;

function fileUrlForPath(filePath: string): string {
  return pathToFileURL(filePath).href;
}

function stripCodexOutputFileReferences(
  text: string | undefined,
  outputFiles: CodexBridgeOutputFile[] | undefined,
): string | undefined {
  if (!text?.trim() || !outputFiles?.length) return text;
  const outputPaths = new Set(
    outputFiles
      .flatMap((file) => [file.filePath, fileUrlForPath(file.filePath)]),
  );
  const withoutMarkdownLinks = text.replace(
    MARKDOWN_FILE_REFERENCE_PATTERN,
    (match, rawUrl: string) => outputPaths.has(rawUrl.trim()) ? "" : match,
  );
  const withoutFileUrls = withoutMarkdownLinks.replace(
    FILE_URL_REFERENCE_PATTERN,
    (match) => outputPaths.has(match.trim()) ? "" : match,
  );
  const withoutRawPaths = [...outputPaths].reduce(
    (current, value) => value.startsWith("file://")
      ? current
      : current.split(value).join(""),
    withoutFileUrls,
  );
  const cleaned = withoutRawPaths
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || undefined;
}

function textAndMediaActions(
  message: RuntimeMessage,
  text: string | undefined,
  outputFiles: CodexBridgeOutputFile[] | undefined,
): RuntimeAction[] {
  const cleanedText = stripCodexOutputFileReferences(text, outputFiles);
  return [
    ...(cleanedText
      ? textAction(message, cleanedText)
      : []),
    ...mediaActions(message, outputFiles),
    ...missingOutputFileWarningActions(message, outputFiles),
  ];
}

function streamTextAndMediaActions(
  message: RuntimeMessage,
  replyParts: string[],
  outputFiles: CodexBridgeOutputFile[] | undefined,
): RuntimeAction[] {
  const textActions = replyParts
    .map((part) => stripCodexOutputFileReferences(part, outputFiles))
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => ({
      type: "send_text" as const,
      conversationId: message.conversationId,
      text: part,
    }));
  return [
    ...textActions,
    ...mediaActions(message, outputFiles),
    ...missingOutputFileWarningActions(message, outputFiles),
  ];
}

function missingOutputFileWarningActions(
  message: RuntimeMessage,
  outputFiles: CodexBridgeOutputFile[] | undefined,
): RuntimeAction[] {
  const missingFiles = missingOutputFiles(outputFiles);
  if (!missingFiles.length) return [];
  return textAction(message, codexError("output file missing", [
    "Codex 返回了本地文件路径，但文件不存在或不是普通文件，已跳过发送。",
    "可以让 Codex 重新生成文件，或检查生成路径是否仍然可访问。",
  ]));
}

async function promptAttachmentsForMessage(
  message: RuntimeMessage,
  context: RuntimeHandlerContext,
): Promise<CodexBridgePromptAttachment[]> {
  const hasMediaAttachment = message.attachments.some((attachment) =>
    attachment.kind === "image" ||
    attachment.kind === "file" ||
    attachment.kind === "video" ||
    attachment.kind === "voice"
  );
  if (!hasMediaAttachment) return [];
  if (!context.media) {
    throw new Error("Runtime media pipeline is not configured; cannot forward WeChat attachments.");
  }
  const media = await context.media.downloadMessageMedia({
    client: context.client,
    message,
  });
  const attachments = media
    .filter((item) => item.filePath)
    .map((item) => ({
      kind: item.kind === "image" ? "image" as const : "file" as const,
      filePath: item.filePath ?? "",
      fileName: item.fileName,
      mimeType: item.mimeType,
      size: item.size,
    }));
  if (!attachments.length) {
    throw new Error("WeChat attachment was received, but no local file could be cached.");
  }
  return attachments;
}

function promptTextForMessage(text: string): string {
  if (text) return text;
  return "";
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

function attachmentLimitError(maxCount: number): string {
  return codexError("attachment limit", [
    `当前最多缓存 ${maxCount} 个附件。`,
    `已保留前 ${maxCount} 个附件，请直接发送文字要求。`,
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

  return codexPanel([
    "codex / token",
    "",
    `- ${primary?.label ?? "5h"}: ${primary?.remainingText ?? "unknown"} ${primary?.resetText ?? "unknown"}`,
    `- ${usage.resetCreditsText ?? "reset credits unavailable"}`,
  ]);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = units[0];
  for (let index = 0; index < units.length - 1 && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index + 1];
  }
  const formatted = unit === "B" ? String(bytes) : value.toFixed(value >= 10 ? 1 : 2);
  return `${formatted} ${unit}`;
}

function formatCacheStats(stats: RuntimeMediaCacheStats): string {
  return codexPanel([
    "codex / cache",
    "",
    "- 本地附件 cache",
    stats.cacheDir ? `- 路径: ${stats.cacheDir}` : "- 路径: 未配置",
    stats.profileId ? `- profile: ${stats.profileId}` : undefined,
    `- 文件数: ${stats.fileCount}`,
    `- 大小: ${formatBytes(stats.totalBytes)}`,
    stats.oldestMtimeMs ? `- 最早文件: ${formatTime(stats.oldestMtimeMs)}` : undefined,
    stats.newestMtimeMs ? `- 最新文件: ${formatTime(stats.newestMtimeMs)}` : undefined,
    "",
    "/cache clear",
    "  清理当前 profile 的附件 cache",
  ]);
}

function formatCacheCleared(stats: RuntimeMediaCacheStats): string {
  return codexOk("cache cleared", [
    "已清理当前 profile 的附件 cache。",
    stats.cacheDir ? `路径: ${stats.cacheDir}` : undefined,
    `清理文件数: ${stats.fileCount}`,
    `释放空间: ${formatBytes(stats.totalBytes)}`,
  ]);
}

export function createCodexConnector(opts: CodexConnectorOptions): RuntimeConnector {
  const prefixes = opts.commandPrefixes ?? [];
  const tokenUsageReader = opts.tokenUsageReader ??
    opts.client.getTokenUsage?.bind(opts.client);
  let replyMode: CodexReplyMode = opts.replyMode ?? "final";
  const cachedBindableThreads = new Map<string, CodexBridgeThread[]>();
  const conversationQueues = new Map<string, Promise<void>>();
  const pendingImages = new Map<string, PendingImageState>();
  const imagePromptReminderMs = opts.imagePromptReminderMs ?? DEFAULT_IMAGE_PROMPT_REMINDER_MS;
  const imagePendingTtlMs = opts.imagePendingTtlMs ?? DEFAULT_IMAGE_PENDING_TTL_MS;
  const imageMaxCount = opts.imageMaxCount ?? DEFAULT_IMAGE_MAX_COUNT;
  const processingReminderMs = opts.processingReminderMs ?? DEFAULT_PROCESSING_REMINDER_MS;
  return {
    id: opts.id,
    name: opts.name ?? "Codex Bridge",
    async handleMessage(message, context: RuntimeHandlerContext) {
      if (message.text?.trim() === "/cd ..") {
        clearPendingImageState(pendingImages, pendingImageKey(message));
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

      const immediateText = stripPrefix(messageText(message), prefixes);
      if (isStatusCommand(immediateText)) {
        await rememberTarget(opts.client, message);
        return textAction(message, formatStatus(await opts.client.getStatus()));
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

      const cacheCommand = parseCacheCommand(text);
      if (cacheCommand !== null) {
        if (!context.media) {
          return textAction(
            message,
            codexError("cache unavailable", [
              "当前 runtime 没有配置 media cache。",
            ]),
          );
        }
        if (cacheCommand === "invalid") {
          return textAction(message, codexUsage("/cache [clear]", "查看或清理本地附件 cache。"));
        }
        try {
          if (cacheCommand === "clear") {
            clearPendingImageStatesForProfile(pendingImages, message.profileId);
            return textAction(message, formatCacheCleared(
              await context.media.clearCache(message.profileId),
            ));
          }
          return textAction(message, formatCacheStats(
            await context.media.getCacheStats(message.profileId),
          ));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return textAction(message, codexError("cache failed", [detail]));
        }
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

      const imageKey = pendingImageKey(message);
      const pendingForText = text
        ? freshPendingImageState(pendingImages, imageKey, imagePendingTtlMs)
        : undefined;
      const attachmentWaitMs = pendingForText
        ? Math.max(0, Date.now() - pendingForText.updatedAt)
        : undefined;
      if (pendingForText) suspendPendingImageReminder(pendingForText);

      let promptAttachments: CodexBridgePromptAttachment[];
      const attachmentDownloadStartedAt = Date.now();
      try {
        promptAttachments = await promptAttachmentsForMessage(message, context);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return withCodexTiming(
          textAction(message, codexError("media failed", [detail])),
          {
            attachmentDownloadMs: Date.now() - attachmentDownloadStartedAt,
            attachmentWaitMs,
          },
        );
      }
      const attachmentDownloadMs = message.attachments.length
        ? Date.now() - attachmentDownloadStartedAt
        : undefined;
      const currentPending = pendingForText ?? freshPendingImageState(
        pendingImages,
        imageKey,
        imagePendingTtlMs,
      );

      if (!text && promptAttachments.length > 0) {
        const state = currentPending ?? {
          attachments: [],
          sourceMessageId: message.id,
          updatedAt: Date.now(),
          timerVersion: 0,
        };
        const remainingSlots = imageMaxCount - state.attachments.length;
        const acceptedAttachments = promptAttachments.slice(0, Math.max(0, remainingSlots));
        if (acceptedAttachments.length > 0) {
          state.attachments.push(...acceptedAttachments);
          state.sourceMessageId = message.id;
          state.updatedAt = Date.now();
          pendingImages.set(imageKey, state);
          schedulePendingImageReminder({
            pendingImages,
            key: imageKey,
            message,
            context,
            delayMs: imagePromptReminderMs,
          });
        }
        if (acceptedAttachments.length < promptAttachments.length) {
          return withCodexTiming(
            textAction(message, attachmentLimitError(imageMaxCount)),
            { attachmentDownloadMs },
          );
        }
        return withCodexTiming(
          [{ type: "noop", reason: "codex attachment cached; waiting for text request" }],
          { attachmentDownloadMs },
        );
      }

      const pendingAttachments = pendingForText?.attachments
        ? existingPromptAttachments(pendingForText.attachments)
        : [];
      if (pendingForText && pendingAttachments.length !== pendingForText.attachments.length) {
        if (pendingAttachments.length) {
          pendingForText.attachments = pendingAttachments;
        } else {
          clearPendingImageState(pendingImages, imageKey);
        }
      }
      const mergedAttachments = [
        ...pendingAttachments,
        ...promptAttachments,
      ];
      if (mergedAttachments.length > imageMaxCount) {
        return withCodexTiming(
          textAction(message, attachmentLimitError(imageMaxCount)),
          { attachmentDownloadMs, attachmentWaitMs },
        );
      }

      const promptText = promptTextForMessage(text);
      if (!promptText && promptAttachments.length === 0) {
        return withCodexTiming(
          textAction(
            message,
            codexError("unsupported message", [
              "这条微信消息没有可转发给 Codex 的文本或附件。",
              "语音消息最好带转写文本；没有文本时会尝试作为本地附件转发。",
            ]),
          ),
          { attachmentDownloadMs, attachmentWaitMs },
        );
      }

      const prompt: CodexBridgePrompt = {
        id: randomUUID(),
        createdAt: Date.now(),
        profileId: message.profileId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        text: promptText,
        attachments: mergedAttachments.length ? mergedAttachments : undefined,
        sourceMessageId: message.id,
        contextToken: message.replyToken?.contextToken,
        routeId: context.route.id,
        replyMode,
      };
      let result: CodexBridgeSendPromptResult;
      const codexTurnStartedAt = Date.now();
      const stopProcessingReminder = startProcessingReminder({
        message,
        context,
        intervalMs: processingReminderMs,
      });
      try {
        result = await opts.client.sendPrompt(prompt);
      } catch (error) {
        retainPendingAttachmentsAfterFailure({
          pendingImages,
          key: imageKey,
          attachments: mergedAttachments,
          sourceMessageId: message.id,
        });
        const detail = error instanceof Error ? error.message : String(error);
        return withCodexTiming(
          textAction(
            message,
            codexError("codex gui failed", [detail]),
          ),
          {
            attachmentDownloadMs,
            attachmentWaitMs,
            codexTurnMs: Date.now() - codexTurnStartedAt,
          },
        );
      } finally {
        stopProcessingReminder();
      }
      const timing: CodexActionTiming = {
        attachmentDownloadMs,
        attachmentWaitMs,
        codexTurnMs: Date.now() - codexTurnStartedAt,
      };
      if (result.error) {
        retainPendingAttachmentsAfterFailure({
          pendingImages,
          key: imageKey,
          attachments: mergedAttachments,
          sourceMessageId: message.id,
        });
        return withCodexTiming(
          textAction(
            message,
            codexError("codex gui failed", [
              result.threadId ? `Thread ID: ${result.threadId}` : undefined,
              result.turnId ? `Turn ID: ${result.turnId}` : undefined,
              `Error: ${result.error}`,
            ]),
          ),
          timing,
        );
      }
      if (pendingForText) clearPendingImageState(pendingImages, imageKey);
      if (replyMode === "silent" && result.threadId) {
        return withCodexTiming(
          textAction(
            message,
            codexOk("codex / done", [
              "Codex 已完成这次任务。",
              `Thread ID: ${result.threadId}`,
              result.turnId ? `Turn ID: ${result.turnId}` : undefined,
            ]),
          ),
          timing,
        );
      }
      const replyParts = result.replyParts?.filter((part) => part.trim().length > 0) ?? [];
      if (replyMode === "stream" && replyParts.length) {
        return withCodexTiming(
          streamTextAndMediaActions(message, replyParts, result.outputFiles),
          timing,
        );
      }
      const finalActions = textAndMediaActions(message, result.finalText, result.outputFiles);
      if (finalActions.length) return withCodexTiming(finalActions, timing);
      if (result.threadId) {
        return withCodexTiming(
          textAction(
            message,
            codexError("no final reply", [
              "Codex 已结束这次任务，但没有返回可发送的文字、图片或文件。",
              result.status ? `Status: ${result.status}` : undefined,
              `Thread ID: ${result.threadId}`,
              result.turnId ? `Turn ID: ${result.turnId}` : undefined,
            ]),
          ),
          timing,
        );
      }
      return withCodexTiming(
        textAction(
          message,
          codexOk("codex inbox", [
            `Prompt ID: ${result.id}`,
          ]),
        ),
        timing,
      );
        },
      );
    },
  };
}
