import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  RuntimeAction,
  RuntimeCachedMedia,
  RuntimeConnector,
  RuntimeHandlerContext,
  RuntimeMessage,
} from "@wechat2all/runtime";

import { runOfficeAgent } from "./agent.js";
import type { OfficeRouteConfig } from "./types.js";

export interface OfficeRouteConnectorOptions {
  id: string;
  config: OfficeRouteConfig;
  onError?: (error: Error, context: { message: RuntimeMessage; operation: string }) => void;
}

function textAction(message: RuntimeMessage, text: string): RuntimeAction[] {
  return [{ type: "send_text", conversationId: message.conversationId, text }];
}

function block(title: string, lines: string[]): string {
  return [
    `\`\`\`${title.replace(/`/g, "'")}`,
    ...lines.map((line) => line.replace(/```/g, "'''")),
    "```",
  ].join("\n");
}

function panel(title: string, lines: string[]): string {
  const labels: Record<string, string> = {
    "已退出": "Office-Returned",
    "帮助": "Office/Help",
    "状态": "Office-Status",
    "文件": "Office-Files",
    "新会话": "Office-New",
    "尚未配置": "Office-Not-Configured",
    "处理中": "Office-Working",
    "完成": "Office-Done",
    "处理失败": "Office-Error",
  };
  return block(labels[title] ?? `Office-${title.replace(/\s+/g, "-")}`, lines);
}

function sessionKey(message: RuntimeMessage): string {
  return [message.profileId, message.conversationId, message.senderId].join("\0");
}

function workspacePath(storageDir: string, message: RuntimeMessage): string {
  const digest = createHash("sha256").update(sessionKey(message)).digest("hex").slice(0, 24);
  return path.join(storageDir, "workspaces", digest);
}

function safeFileName(value: string): string {
  const parsed = path.parse(value);
  const stem = parsed.name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/g, "") || "attachment";
  const extension = parsed.ext.replace(/[^a-zA-Z0-9.]+/g, "").slice(0, 16);
  return `${stem.slice(0, 80)}${extension}`;
}

async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function supportedMedia(item: RuntimeCachedMedia): boolean {
  return item.kind === "file" || item.kind === "image";
}

async function stageAttachments(params: {
  message: RuntimeMessage;
  context: RuntimeHandlerContext;
  workspace: string;
  maxBytes: number;
}): Promise<string[]> {
  const selected = params.message.attachments.filter((item) =>
    item.kind === "file" || item.kind === "image"
  );
  if (selected.length === 0) return [];
  const declaredTooLarge = selected.find((item) =>
    item.size !== undefined && item.size > params.maxBytes
  );
  if (declaredTooLarge) {
    throw new Error(`${declaredTooLarge.fileName ?? "附件"} 超过 Office route 文件大小限制。`);
  }
  if (!params.context.media) throw new Error("WeConnect media pipeline 未配置。");
  const downloaded = await params.context.media.downloadMessageMedia({
    client: params.context.client,
    message: { ...params.message, attachments: selected },
  });
  if (downloaded.length !== selected.length || downloaded.some((item) => !supportedMedia(item))) {
    throw new Error("一个或多个微信附件下载失败。");
  }
  const incomingDir = path.join(params.workspace, "incoming");
  await fs.mkdir(incomingDir, { recursive: true, mode: 0o700 });
  const staged: string[] = [];
  for (const item of downloaded) {
    if (item.size > params.maxBytes) throw new Error("下载后的附件超过 Office route 文件大小限制。");
    const original = item.fileName ?? path.basename(item.filePath ?? "attachment.bin");
    const relative = path.join("incoming", `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileName(original)}`);
    await atomicWrite(path.join(params.workspace, relative), item.data);
    staged.push(relative);
  }
  return staged;
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 3) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile()) output.push(path.relative(root, absolute));
      if (output.length >= 200) return;
    }
  }
  await visit(root, 0);
  return output.sort();
}

async function verifiedDeliverables(workspace: string, files: string[]): Promise<string[]> {
  const root = await fs.realpath(workspace);
  const output: string[] = [];
  for (const file of [...new Set(files)]) {
    const candidate = path.resolve(workspace, file);
    if (!/\.(docx|xlsx|pptx)$/i.test(candidate)) {
      throw new Error(`不支持返回这个文件类型：${file}`);
    }
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Office 输出文件不存在：${file}`);
    const realCandidate = await fs.realpath(candidate);
    if (realCandidate !== root && !realCandidate.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Office 输出文件越过了工作区：${file}`);
    }
    output.push(realCandidate);
  }
  return output;
}

function command(text: string | undefined): string {
  return text?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

export function createOfficeRouteConnector(opts: OfficeRouteConnectorOptions): RuntimeConnector {
  const queues = new Map<string, Promise<void>>();

  function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = queues.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(task);
    const settled = current.then(() => undefined, () => undefined);
    queues.set(key, settled);
    void settled.finally(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return current;
  }

  return {
    id: opts.id,
    name: "Office Route",
    async handleMessage(message, context) {
      const first = command(message.text);
      if (first === "/cd" && message.text?.trim() === "/cd ..") {
        context.routes.clearConversationRoute(message.profileId, message.conversationId);
        return textAction(message, panel("已退出", ["已回到大助手。"]));
      }
      const workspace = workspacePath(opts.config.storageDir, message);
      await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
      if (first === "/help" || first === "/帮助") {
        return textAction(message, [
          block("Office/Help", ["可用命令"]),
          block("Input", ["发送自然语言要求以及 Word、Excel、PPT、CSV 或图片附件"]),
          block("/status", ["查看 LLM 与 OfficeCLI 状态"]),
          block("/files", ["查看当前会话文件"]),
          block("/new", ["清空当前会话工作区"]),
          block("/cd", ["/cd ..：回到大助手"]),
        ].join("\n"));
      }
      if (first === "/status" || first === "/状态") {
        const version = await opts.config.cli.version?.().catch((error: unknown) => ({
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        }));
        return textAction(message, panel("状态", [
          `LLM：${opts.config.llmConfigured ? `已继承 WeConnect (${opts.config.llm.id})` : "未配置 WECHAT2ALL_LLM_API_KEY / MODEL"}`,
          `OfficeCLI：${version?.exitCode === 0 ? version.stdout || "可用" : `不可用 (${version?.stderr || "未检测"})`}`,
          `工作区文件：${(await listFiles(workspace)).length}`,
        ]));
      }
      if (first === "/files" || first === "/文件") {
        const files = await listFiles(workspace);
        return textAction(message, panel("文件", files.length ? files.map((file) => `- ${file}`) : ["暂无文件。"]));
      }
      if (first === "/new" || first === "/reset" || first === "/新会话") {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
        return textAction(message, panel("新会话", ["当前 Office 工作区已清空。"]));
      }
      if (!opts.config.llmConfigured) {
        return textAction(message, panel("尚未配置", [
          "Office route 复用 WeConnect 的 LLM 配置。",
          "请设置 WECHAT2ALL_LLM_API_KEY、WECHAT2ALL_LLM_MODEL，并使用 openai-compatible provider。",
        ]));
      }

      return enqueue(sessionKey(message), async () => {
        try {
          const staged = await stageAttachments({
            message,
            context,
            workspace,
            maxBytes: opts.config.maxMediaBytes,
          });
          const available = await listFiles(workspace);
          const result = await runOfficeAgent({
            userText: message.text?.trim() ?? "",
            workspace,
            availableFiles: available,
            config: opts.config,
            onProgress: async (progress) => {
              await context.dispatchActions?.(textAction(message, panel("处理中", [progress])));
            },
          });
          const deliverables = await verifiedDeliverables(workspace, result.files);
          const actions: RuntimeAction[] = textAction(message, panel("完成", [
            result.message,
            staged.length ? `本次接收附件：${staged.length} 个` : "",
            deliverables.length ? `返回文件：${deliverables.length} 个` : "",
          ].filter(Boolean)));
          actions.push(...deliverables.map((filePath) => ({
            type: "send_media" as const,
            conversationId: message.conversationId,
            filePath,
          })));
          return actions;
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error));
          opts.onError?.(wrapped, { message, operation: "office-agent" });
          return textAction(message, panel("处理失败", [wrapped.message]));
        }
      });
    },
  };
}
