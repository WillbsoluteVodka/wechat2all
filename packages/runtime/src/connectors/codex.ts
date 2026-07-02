import fs from "node:fs/promises";
import path from "node:path";
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
}

export interface CodexBridgeOutboxMessage {
  id: string;
  createdAt: number;
  text: string;
  level?: "info" | "success" | "warn" | "error";
  threadId?: string;
  projectId?: string;
  target?: Partial<CodexBridgeTarget>;
  deliveredAt?: number;
}

export interface CodexBridgeSendPromptResult {
  id: string;
  threadId?: string;
  turnId?: string;
  finalText?: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  error?: string;
}

export interface CodexBridgeClient {
  getStatus(): Promise<CodexBridgeStatus>;
  listThreads?(): Promise<CodexBridgeThread[]>;
  listChats?(): Promise<CodexBridgeThread[]>;
  bindThread?(threadId: string): Promise<CodexBridgeBinding>;
  getCurrentBinding?(): Promise<CodexBridgeBinding | null>;
  getTokenUsage?(): Promise<CodexTokenUsage>;
  sendPrompt?(prompt: CodexBridgePrompt): Promise<CodexBridgeSendPromptResult>;
  setDefaultTarget?(target: CodexBridgeTarget): Promise<void>;
  getDefaultTarget?(): Promise<CodexBridgeTarget | null>;
  pullOutbox?(): Promise<CodexBridgeOutboxMessage[]>;
  markOutboxDelivered?(id: string): Promise<void>;
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

export interface FileCodexBridgeClientOptions {
  baseDir: string;
}

interface StatusFile {
  status?: CodexBridgeStatus;
}

interface ThreadsFile {
  threads?: CodexBridgeThread[];
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

function isUndelivered(message: CodexBridgeOutboxMessage): boolean {
  return !message.deliveredAt && Boolean(message.text?.trim());
}

export function createFileCodexBridgeClient(
  opts: FileCodexBridgeClientOptions,
): CodexBridgeClient {
  const statusPath = path.join(opts.baseDir, "status.json");
  const threadsPath = path.join(opts.baseDir, "threads.json");
  const inboxPath = path.join(opts.baseDir, "inbox.jsonl");
  const outboxPath = path.join(opts.baseDir, "outbox.jsonl");
  const targetPath = path.join(opts.baseDir, "target.json");

  return {
    async getStatus() {
      const data = await readJson<StatusFile>(statusPath);
      return data?.status ?? {
        state: "unknown",
        summary:
          "Codex bridge is waiting for a Codex-side MCP/bridge process to publish status.",
      };
    },
    async listThreads() {
      const data = await readJson<ThreadsFile>(threadsPath);
      return data?.threads ?? [];
    },
    async sendPrompt(prompt) {
      await appendJsonl(inboxPath, prompt);
      return { id: prompt.id };
    },
    async setDefaultTarget(target) {
      await writeJson(targetPath, target);
    },
    async getDefaultTarget() {
      return readJson<CodexBridgeTarget>(targetPath);
    },
    async pullOutbox() {
      return (await readJsonl<CodexBridgeOutboxMessage>(outboxPath))
        .filter(isUndelivered);
    },
    async markOutboxDelivered(id) {
      const messages = await readJsonl<CodexBridgeOutboxMessage>(outboxPath);
      await ensureDir(path.dirname(outboxPath));
      await fs.writeFile(
        outboxPath,
        messages.map((message) =>
          JSON.stringify(message.id === id
            ? { ...message, deliveredAt: Date.now() }
            : message),
        ).join("\n") + (messages.length ? "\n" : ""),
        "utf-8",
      );
    },
  };
}

export interface CodexConnectorOptions {
  id: string;
  name?: string;
  client: CodexBridgeClient;
  commandPrefixes?: string[];
  tokenUsageReader?: CodexTokenUsageReader;
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
  return !text || /^(status|progress|进度|状态|在干嘛|busy|idle)$/i.test(text);
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

function isCurrentCommand(text: string): boolean {
  return /^(current|pwd|binding|where|当前|绑定)$/i.test(text);
}

function parseBindThreadId(text: string): string | null {
  const match = text.match(/^bind(?:\s+|=)(.+)$/i);
  const threadId = match?.[1]?.trim();
  return threadId || null;
}

function formatTime(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "unknown";
}

function formatStatus(status: CodexBridgeStatus): string {
  const label: Record<CodexBridgeStatusState, string> = {
    idle: "空闲",
    working: "正在工作",
    completed: "已完成",
    blocked: "被阻塞",
    unknown: "未知 / 未连接",
  };
  return [
    `Codex 状态：${label[status.state] ?? status.state}`,
    status.summary ? `说明：${status.summary}` : undefined,
    status.currentProject ? `Project：${status.currentProject}` : undefined,
    status.currentThreadId ? `Chat：${status.currentThreadId}` : undefined,
    `更新时间：${formatTime(status.updatedAt)}`,
  ].filter(Boolean).join("\n");
}

function formatThreads(threads: CodexBridgeThread[]): string {
  if (!threads.length) {
    return "Codex GUI bridge 没有找到可绑定的 chat。";
  }
  return [
    "Codex chats:",
    ...threads.slice(0, 12).map((thread, index) => {
      const title = thread.title ?? thread.id;
      const project = thread.project ?? thread.projectPath;
      const status = thread.status ? ` · ${thread.status}` : "";
      return [
        `${index + 1}. ${title}${status}`,
        `   id: ${thread.id}`,
        project ? `   project: ${project}` : undefined,
      ].filter(Boolean).join("\n");
    }),
    "",
    "用 /bind <id> 绑定其中一个 chat。",
  ].join("\n");
}

function formatBinding(binding: CodexBridgeBinding | null): string {
  if (!binding) {
    return "Codex GUI bridge 还没有绑定 chat。先发送 /ls，再发送 /bind <threadId>。";
  }
  return [
    "当前 Codex 绑定：",
    binding.title ? `Chat：${binding.title}` : undefined,
    binding.project ? `Project：${binding.project}` : undefined,
    `Thread ID：${binding.threadId}`,
    binding.boundAt ? `绑定时间：${formatTime(binding.boundAt)}` : undefined,
  ].filter(Boolean).join("\n");
}

function helpText(): string {
  return [
    "Codex route 当前可用输入：",
    "status - 查询 Codex 当前状态",
    "/token - 查询 Codex usage 剩余额度",
    "/ls - 查看可绑定的 Codex chats",
    "/bind <threadId> - 绑定一个 Codex chat",
    "/current - 查看当前绑定",
    "任意普通文本 - 发送到已绑定的 Codex chat",
    "/cd .. - 回到大助手",
    "",
    "默认不使用 GUI 自动化，也不会偷偷 fallback 到 CLI watcher。",
  ].join("\n");
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

function formatTokenUsageForWechat(usage: CodexTokenUsage): string {
  const primary = usage.windows.find((window) => window.label === "5h") ??
    usage.windows[0] ?? null;
  const secondary = usage.windows.find((window) => window.label === "Weekly") ??
    usage.windows[1] ?? null;

  return [
    `- ${primary?.label ?? "5h"}: ${primary?.remainingText ?? "unknown"} ${primary?.resetText ?? "unknown"}`,
    `- ${secondary?.label ?? "Weekly"}: ${secondary?.remainingText ?? "unknown"} ${secondary?.resetText ?? "unknown"}`,
    `- ${usage.resetCreditsText ?? "reset credits unavailable"}`,
  ].join("\n");
}

export function createCodexConnector(opts: CodexConnectorOptions): RuntimeConnector {
  const prefixes = opts.commandPrefixes ?? [];
  const tokenUsageReader = opts.tokenUsageReader ??
    opts.client.getTokenUsage?.bind(opts.client);
  return {
    id: opts.id,
    name: opts.name ?? "Codex Bridge",
    async handleMessage(message, context: RuntimeHandlerContext) {
      if (message.text?.trim() === "/cd ..") {
        context.routes.clearConversationRoute(message.profileId, message.conversationId);
        return textAction(
          message,
          "已退回大助手。你现在可以继续普通聊天，或发送 /ls 查看 routes。",
        );
      }

      await rememberTarget(opts.client, message);
      const text = stripPrefix(messageText(message), prefixes);
      const command = commandText(text);

      if (isTokenCommand(command)) {
        if (!tokenUsageReader) {
          return textAction(
            message,
            "当前 Codex backend 不支持 /token。请使用 gui-app-server backend，或给 Codex connector 传入 tokenUsageReader。",
          );
        }
        try {
          return textAction(message, formatTokenUsageForWechat(await tokenUsageReader()));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return textAction(message, `Codex token usage 暂时读取失败：${detail}`);
        }
      }

      if (isHelpCommand(command)) {
        return textAction(message, helpText());
      }

      if (isStatusCommand(command)) {
        return textAction(message, formatStatus(await opts.client.getStatus()));
      }

      if (isThreadListCommand(command)) {
        const threads = opts.client.listChats
          ? await opts.client.listChats()
          : opts.client.listThreads
            ? await opts.client.listThreads()
            : [];
        return textAction(message, formatThreads(threads));
      }

      if (isCurrentCommand(command)) {
        const binding = opts.client.getCurrentBinding
          ? await opts.client.getCurrentBinding()
          : null;
        return textAction(message, formatBinding(binding));
      }

      const bindThreadId = parseBindThreadId(command);
      if (bindThreadId) {
        if (!opts.client.bindThread) {
          return textAction(
            message,
            "当前 Codex backend 不支持 /bind。请设置 WECHAT2ALL_CODEX_BACKEND=gui-app-server 后重启 router-daemon。",
          );
        }
        try {
          return textAction(
            message,
            formatBinding(await opts.client.bindThread(bindThreadId)),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return textAction(message, `Codex 绑定失败：${detail}`);
        }
      }

      if (text.startsWith("/")) {
        return [{ type: "noop", reason: `unknown codex route command: ${text}` }];
      }

      if (!opts.client.sendPrompt) {
        return textAction(
          message,
          "Codex bridge 还没有接入 sendPrompt。",
        );
      }

      if (opts.client.getCurrentBinding && !(await opts.client.getCurrentBinding())) {
        return textAction(
          message,
          "Codex GUI bridge 还没有绑定 chat。先发送 /ls，再发送 /bind <threadId>。",
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
      };
      let result: CodexBridgeSendPromptResult;
      try {
        result = await opts.client.sendPrompt(prompt);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return textAction(
          message,
          `Codex GUI chat 处理失败：${detail}`,
        );
      }
      if (result.finalText) return textAction(message, result.finalText);
      if (result.error) {
        return textAction(
          message,
          [
            "Codex GUI chat 处理失败。",
            result.threadId ? `Thread ID: ${result.threadId}` : undefined,
            result.turnId ? `Turn ID: ${result.turnId}` : undefined,
            `Error: ${result.error}`,
          ].filter(Boolean).join("\n"),
        );
      }
      if (result.threadId) {
        return textAction(
          message,
          [
            result.status === "inProgress"
              ? "Codex GUI chat 仍在处理，暂时只拿到部分/无最终回复。"
              : "已发送到 Codex GUI chat，但没有拿到最终文本回复。",
            `Thread ID: ${result.threadId}`,
            result.turnId ? `Turn ID: ${result.turnId}` : undefined,
          ].filter(Boolean).join("\n"),
        );
      }
      return textAction(
        message,
        `已发送给 Codex bridge inbox。\nPrompt ID: ${result.id}`,
      );
    },
  };
}
