import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  status?: string;
  updatedAt?: number;
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

interface StatusFile {
  status?: CodexBridgeStatus;
}

interface ThreadsFile {
  threads?: CodexBridgeThread[];
}

interface HandledPromptRecord {
  id: string;
  handledAt: number;
}

interface HandledPromptsFile {
  prompts?: HandledPromptRecord[];
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function codexBridgeDirFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.WECHAT2ALL_CODEX_BRIDGE_DIR;
  if (explicit?.trim()) return path.resolve(stripEnvQuotes(explicit.trim()));

  const baseDir = path.resolve(stripEnvQuotes(
    env.WECHAT2ALL_STATE_DIR?.trim() ||
      path.join(os.homedir(), ".wechat2all-runtime-bot"),
  ));
  const profileId = stripEnvQuotes(env.WECHAT_RUNTIME_PROFILE?.trim() || "default");
  const profileDir = profileId === "default"
    ? baseDir
    : path.join(baseDir, "profiles", profileId);
  return path.join(profileDir, "codex-bridge");
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

function latest<T>(items: T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

export class CodexBridgeStore {
  readonly baseDir: string;
  private statusPath: string;
  private threadsPath: string;
  private inboxPath: string;
  private outboxPath: string;
  private targetPath: string;
  private handledPromptsPath: string;

  constructor(baseDir = codexBridgeDirFromEnv()) {
    this.baseDir = baseDir;
    this.statusPath = path.join(baseDir, "status.json");
    this.threadsPath = path.join(baseDir, "threads.json");
    this.inboxPath = path.join(baseDir, "inbox.jsonl");
    this.outboxPath = path.join(baseDir, "outbox.jsonl");
    this.targetPath = path.join(baseDir, "target.json");
    this.handledPromptsPath = path.join(baseDir, "handled-prompts.json");
  }

  async updateStatus(status: Omit<CodexBridgeStatus, "updatedAt"> & {
    updatedAt?: number;
  }): Promise<CodexBridgeStatus> {
    const next: CodexBridgeStatus = {
      ...status,
      updatedAt: status.updatedAt ?? Date.now(),
    };
    await writeJson(this.statusPath, { status: next });
    return next;
  }

  async getStatus(): Promise<CodexBridgeStatus | null> {
    return (await readJson<StatusFile>(this.statusPath))?.status ?? null;
  }

  async syncThreads(threads: CodexBridgeThread[]): Promise<CodexBridgeThread[]> {
    const normalized = threads.map((thread) => ({
      ...thread,
      updatedAt: thread.updatedAt ?? Date.now(),
    }));
    await writeJson(this.threadsPath, { threads: normalized });
    return normalized;
  }

  async listThreads(limit = 20): Promise<CodexBridgeThread[]> {
    const threads = (await readJson<ThreadsFile>(this.threadsPath))?.threads ?? [];
    return latest(threads, limit);
  }

  async sendWechatMessage(params: {
    text: string;
    level?: CodexBridgeOutboxMessage["level"];
    threadId?: string;
    projectId?: string;
    target?: Partial<CodexBridgeTarget>;
  }): Promise<CodexBridgeOutboxMessage> {
    const message: CodexBridgeOutboxMessage = {
      id: randomUUID(),
      createdAt: Date.now(),
      text: params.text,
      level: params.level,
      threadId: params.threadId,
      projectId: params.projectId,
      target: params.target,
    };
    await appendJsonl(this.outboxPath, message);
    return message;
  }

  async listWechatPrompts(params: {
    limit?: number;
    includeHandled?: boolean;
  } = {}): Promise<CodexBridgePrompt[]> {
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const prompts = await readJsonl<CodexBridgePrompt>(this.inboxPath);
    if (params.includeHandled) return latest(prompts, limit);

    const handled = await this.handledPromptIds();
    return latest(prompts.filter((prompt) => !handled.has(prompt.id)), limit);
  }

  async markWechatPromptHandled(id: string): Promise<HandledPromptRecord> {
    const existing = (await readJson<HandledPromptsFile>(
      this.handledPromptsPath,
    ))?.prompts ?? [];
    const withoutExisting = existing.filter((record) => record.id !== id);
    const record = { id, handledAt: Date.now() };
    const next = latest([...withoutExisting, record], 5000);
    await writeJson(this.handledPromptsPath, { prompts: next });
    return record;
  }

  async getTarget(): Promise<CodexBridgeTarget | null> {
    return readJson<CodexBridgeTarget>(this.targetPath);
  }

  async getBridgeState(): Promise<{
    baseDir: string;
    status: CodexBridgeStatus | null;
    target: CodexBridgeTarget | null;
    pendingPromptCount: number;
    undeliveredOutboxCount: number;
    threadCount: number;
  }> {
    const [status, target, pendingPrompts, outbox, threads] = await Promise.all([
      this.getStatus(),
      this.getTarget(),
      this.listWechatPrompts({ limit: 100 }),
      readJsonl<CodexBridgeOutboxMessage>(this.outboxPath),
      this.listThreads(100),
    ]);
    return {
      baseDir: this.baseDir,
      status,
      target,
      pendingPromptCount: pendingPrompts.length,
      undeliveredOutboxCount: outbox.filter((message) =>
        !message.deliveredAt && Boolean(message.text?.trim())
      ).length,
      threadCount: threads.length,
    };
  }

  private async handledPromptIds(): Promise<Set<string>> {
    const records = (await readJson<HandledPromptsFile>(
      this.handledPromptsPath,
    ))?.prompts ?? [];
    return new Set(records.map((record) => record.id));
  }
}
