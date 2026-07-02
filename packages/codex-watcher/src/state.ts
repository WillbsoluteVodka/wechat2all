import fs from "node:fs/promises";
import path from "node:path";

export type WatcherPromptStatus =
  | "processing"
  | "completed"
  | "failed"
  | "terminal-failed";

export interface WatcherPromptState {
  id: string;
  status: WatcherPromptStatus;
  attempts: number;
  firstSeenAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  completedAt?: number;
  lastError?: string;
}

interface WatcherStateFile {
  prompts?: WatcherPromptState[];
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

function latest<T>(items: T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

export class WatcherStateStore {
  readonly filePath: string;
  private maxRecords: number;

  constructor(filePath: string, opts: { maxRecords?: number } = {}) {
    this.filePath = filePath;
    this.maxRecords = opts.maxRecords ?? 5000;
  }

  async getPrompt(id: string): Promise<WatcherPromptState | undefined> {
    return (await this.listPrompts()).find((prompt) => prompt.id === id);
  }

  async listPrompts(): Promise<WatcherPromptState[]> {
    return (await readJson<WatcherStateFile>(this.filePath))?.prompts ?? [];
  }

  async upsertPrompt(
    next: WatcherPromptState,
  ): Promise<WatcherPromptState> {
    const prompts = await this.listPrompts();
    const withoutExisting = prompts.filter((prompt) => prompt.id !== next.id);
    const records = latest([...withoutExisting, next], this.maxRecords);
    await writeJson(this.filePath, { prompts: records });
    return next;
  }
}
