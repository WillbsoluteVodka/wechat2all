import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  RuntimeAction,
  RuntimeCachedMedia,
  RuntimeConnector,
  RuntimeHandlerContext,
  RuntimeMessage,
} from "@wechat2all/runtime";

import { ClaudeAgentSdkRunner } from "./agent.js";
import { claudeRouteConfigFromEnv } from "./config.js";
import { loadClaudeSystemPrompt } from "./prompt.js";
import { FileClaudeSessionStore } from "./session-store.js";
import type {
  ClaudeAgentRunner,
  ClaudeRouteConfig,
  ClaudeRouteOutputFile,
  ClaudeSessionStore,
  ClaudeStoredSession,
} from "./types.js";

export interface ClaudeRouteConnectorOptions {
  id: string;
  name?: string;
  config: ClaudeRouteConfig;
  runner: ClaudeAgentRunner;
  sessions: ClaudeSessionStore;
  now?: () => number;
  onError?: (error: Error, context: { message: RuntimeMessage; operation: string }) => void;
}

export interface ClaudeRouteFromEnvOptions {
  id?: string;
  name?: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  onError?: ClaudeRouteConnectorOptions["onError"];
}

interface StagedAttachment {
  kind: "image" | "file";
  relativePath: string;
  fileName: string;
  size: number;
}

const STATUS_COMMANDS = new Set(["/status", "/settings", "/config", "/状态", "/设置", "/配置"]);
const RESET_COMMANDS = new Set(["/new", "/reset", "/新会话"]);
const HELP_COMMANDS = new Set(["/help", "/帮助"]);

function commandWord(text: string): string {
  return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function messageText(message: RuntimeMessage): string {
  return message.text?.trim() ?? "";
}

function routeSessionKey(message: RuntimeMessage): string {
  return [message.profileId, message.conversationId, message.senderId].join("\u0000");
}

function panel(title: string, lines: Array<string | undefined>): string {
  return [
    `◆ Claude - ${title}`,
    "",
    ...lines.filter((line): line is string => line !== undefined),
  ].join("\n");
}

function textAction(message: RuntimeMessage, text: string): RuntimeAction[] {
  return [{ type: "send_text", conversationId: message.conversationId, text }];
}

function errorAction(message: RuntimeMessage, title: string, detail: string): RuntimeAction[] {
  return textAction(message, panel(`Error: ${title}`, [detail]));
}

function helpText(): string {
  return panel("Help", [
    "/status",
    "  查看 Claude route 配置与当前 session",
    "",
    "/new",
    "  清除当前 session，下一条消息从零开始",
    "",
    "任意普通文本、链接、图片或文件",
    "  交给本地 Claude Agent SDK；附件会保存到 vault/Wechat_Saved",
    "",
    "/cd ..",
    "  回到主 Router",
  ]);
}

function formatDuration(ms: number): string {
  const minutes = Math.ceil(Math.max(0, ms) / 60_000);
  return `${minutes} min`;
}

function freshSession(
  session: ClaudeStoredSession | null,
  config: ClaudeRouteConfig,
  now: number,
): ClaudeStoredSession | null {
  if (!session || config.sessionWindowMs <= 0) return null;
  return now - session.updatedAt <= config.sessionWindowMs ? session : null;
}

function safeFileName(value: string): string {
  const parsed = path.parse(value);
  const stem = parsed.name
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "") || "attachment";
  const extension = parsed.ext.replace(/[^a-zA-Z0-9.]+/g, "").slice(0, 16);
  return `${stem.slice(0, 96)}${extension}`;
}

async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, data, { mode: 0o600, flag: "wx" });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function stagedKind(media: RuntimeCachedMedia): "image" | "file" | null {
  if (media.kind === "image") return "image";
  if (media.kind === "file") return "file";
  return null;
}

async function stageAttachments(params: {
  message: RuntimeMessage;
  context: RuntimeHandlerContext;
  config: ClaudeRouteConfig;
}): Promise<StagedAttachment[]> {
  const selected = params.message.attachments.filter((attachment) =>
    attachment.kind === "image" || attachment.kind === "file"
  );
  if (!selected.length) return [];
  const tooLarge = selected.find((attachment) =>
    attachment.size !== undefined && attachment.size > params.config.maxMediaBytes
  );
  if (tooLarge) {
    throw new Error(
      `${tooLarge.fileName ?? tooLarge.kind} exceeds the ${Math.round(params.config.maxMediaBytes / 1024 / 1024)} MB limit.`,
    );
  }
  if (!params.context.media) {
    throw new Error("Runtime media pipeline is not configured.");
  }
  const media = await params.context.media.downloadMessageMedia({
    client: params.context.client,
    message: { ...params.message, attachments: selected },
  });
  if (media.some((item) => item.size > params.config.maxMediaBytes)) {
    throw new Error(
      `Downloaded attachment exceeds the ${Math.round(params.config.maxMediaBytes / 1024 / 1024)} MB limit.`,
    );
  }
  const supported = media.filter((item) => stagedKind(item) !== null);
  if (supported.length !== selected.length) {
    throw new Error("One or more WeChat attachments could not be downloaded.");
  }

  const workdir = params.config.workdir as string;
  const saveDir = path.join(workdir, "Wechat_Saved");
  await fs.mkdir(saveDir, { recursive: true });
  const staged: StagedAttachment[] = [];
  for (const item of supported) {
    const originalName = item.fileName ?? path.basename(item.filePath ?? "attachment.bin");
    const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileName(originalName)}`;
    const filePath = path.join(saveDir, fileName);
    await atomicWrite(filePath, item.data);
    staged.push({
      kind: stagedKind(item) as "image" | "file",
      relativePath: path.relative(workdir, filePath),
      fileName,
      size: item.size,
    });
  }
  return staged;
}

function buildPrompt(message: RuntimeMessage, text: string, staged: StagedAttachment[]): string {
  const lines: string[] = [];
  if (text) {
    lines.push(message.kind === "voice" ? `(voice transcript) ${text}` : text);
  }
  if (staged.length) {
    if (lines.length) lines.push("");
    lines.push("WeChat attachments were saved inside the workspace. Inspect them directly:");
    staged.forEach((item, index) => {
      lines.push(`- ${item.kind} ${index + 1}: ${item.relativePath} (${item.size} bytes)`);
    });
  }
  return lines.join("\n").trim();
}

function outputActions(
  message: RuntimeMessage,
  outputs: ClaudeRouteOutputFile[],
): RuntimeAction[] {
  return outputs.map((output) => ({
    type: "send_media" as const,
    conversationId: message.conversationId,
    filePath: output.filePath,
    caption: output.caption,
  }));
}

function replyText(params: {
  text?: string;
  costUsd?: number;
  turns?: number;
}): string | undefined {
  const text = params.text?.trim();
  if (!text) return undefined;
  const stats = [
    params.costUsd !== undefined ? `$${params.costUsd.toFixed(3)}` : undefined,
    params.turns !== undefined ? `${params.turns} turns` : undefined,
  ].filter((item): item is string => Boolean(item));
  return stats.length ? `${text}\n\n[${stats.join(" · ")}]` : text;
}

function enqueue<T>(
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

export function createClaudeRouteConnector(
  opts: ClaudeRouteConnectorOptions,
): RuntimeConnector {
  const now = opts.now ?? Date.now;
  const queues = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, number>();

  async function statusText(message: RuntimeMessage): Promise<string> {
    const key = routeSessionKey(message);
    const timestamp = now();
    const stored = await opts.sessions.get(key);
    const session = freshSession(stored, opts.config, timestamp);
    if (stored && !session) await opts.sessions.clear(key);
    const availability = await opts.runner.availability?.();
    const activeSince = activeRuns.get(key);
    return panel("Status", [
      `state: ${activeSince ? `working (${formatDuration(timestamp - activeSince)})` : "idle"}`,
      `backend: Claude Agent SDK`,
      `workspace: ${opts.config.workdir ?? "not configured"}`,
      `model: ${opts.config.model ?? "default"}`,
      `language: ${opts.config.language}`,
      `auth: ${opts.config.apiKeyConfigured ? "ANTHROPIC_API_KEY" : opts.config.allowCliAuth ? "CLI auth (opt-in)" : "not configured"}`,
      `session: ${session ? `active, ${formatDuration(opts.config.sessionWindowMs - (timestamp - session.updatedAt))} left` : "none"}`,
      `session window: ${formatDuration(opts.config.sessionWindowMs)}`,
      `media cap: ${Math.round(opts.config.maxMediaBytes / 1024 / 1024)} MB`,
      `prompt: ${opts.config.promptFile}`,
      availability && !availability.available ? `unavailable: ${availability.reason}` : undefined,
    ]);
  }

  return {
    id: opts.id,
    name: opts.name ?? "Claude Agent",
    async handleMessage(message, context) {
      const text = messageText(message);
      const command = commandWord(text);
      const key = routeSessionKey(message);

      if (text === "/cd ..") {
        context.routes.clearConversationRoute(message.profileId, message.conversationId);
        return textAction(message, panel("Returned", [
          "已退回主 Router。",
          "Claude session 会在窗口期内保留。",
        ]));
      }
      if (STATUS_COMMANDS.has(command)) {
        return textAction(message, await statusText(message));
      }
      if (HELP_COMMANDS.has(command)) {
        return textAction(message, helpText());
      }
      if (RESET_COMMANDS.has(command)) {
        return enqueue(queues, key, async () => {
          await opts.sessions.clear(key);
          return textAction(message, panel("New Session", [
            "已清除当前 Claude session。",
            "下一条消息会从零开始。",
          ]));
        });
      }
      if (message.attachments.some((attachment) => attachment.kind === "video")) {
        return errorAction(message, "Unsupported Video", "Claude route 暂不处理视频；请发送截图或文件。");
      }
      if (
        message.attachments.some((attachment) => attachment.kind === "voice") &&
        !text
      ) {
        return errorAction(
          message,
          "Voice Transcript Missing",
          "这条语音没有微信转写文本；请使用微信语音转文字或直接发送文字。",
        );
      }
      if (!opts.config.workdir) {
        return errorAction(
          message,
          "Workspace Missing",
          "请先配置 WECHAT2ALL_CLAUDE_WORKDIR（或 WECHAT2ALL_CLAUDE_VAULT）并重启。",
        );
      }

      return enqueue(queues, key, async () => {
        const timestamp = now();
        const stored = await opts.sessions.get(key);
        const session = freshSession(stored, opts.config, timestamp);
        if (stored && !session) {
          await opts.sessions.clear(key);
        }
        try {
          const staged = await stageAttachments({ message, context, config: opts.config });
          const prompt = buildPrompt(message, text, staged);
          if (!prompt) {
            return errorAction(
              message,
              "Unsupported Message",
              "这条消息没有可交给 Claude 的文字、图片或文件。",
            );
          }
          activeRuns.set(key, now());
          const result = await opts.runner.run({
            prompt,
            systemPrompt: await loadClaudeSystemPrompt(opts.config),
            config: opts.config,
            resumeSessionId: session?.sessionId,
          });
          if (result.resetSessionRequested) {
            await opts.sessions.clear(key);
          } else if (result.sessionId) {
            await opts.sessions.set(key, { sessionId: result.sessionId, updatedAt: now() });
          }
          const finalText = replyText(result);
          const actions: RuntimeAction[] = [
            ...(finalText ? textAction(message, finalText) : []),
            ...outputActions(message, result.outputs),
          ];
          return actions.length
            ? actions
            : errorAction(
              message,
              "No Reply",
              "Claude run 已结束，但没有返回可发送的文字或文件。",
            );
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          opts.onError?.(normalized, { message, operation: "run" });
          return errorAction(message, "Run Failed", normalized.message);
        } finally {
          activeRuns.delete(key);
        }
      });
    },
  };
}

export function createClaudeRouteConnectorFromEnv(
  opts: ClaudeRouteFromEnvOptions,
): RuntimeConnector {
  const config = claudeRouteConfigFromEnv({ stateDir: opts.stateDir, env: opts.env });
  return createClaudeRouteConnector({
    id: opts.id ?? "claude-route",
    name: opts.name,
    config,
    runner: new ClaudeAgentSdkRunner(config),
    sessions: new FileClaudeSessionStore(path.join(opts.stateDir, "sessions.json")),
    onError: opts.onError,
  });
}
