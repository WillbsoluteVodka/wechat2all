import fs from "node:fs/promises";
import path from "node:path";

import type { RuntimeRoute } from "../types.js";
import type {
  RuntimeProcessedMessageRecord,
  RuntimeSavedCredentials,
  RuntimeStateStore,
} from "./types.js";

export interface FileRuntimeStateStoreOptions {
  baseDir: string;
  maxProcessedMessages?: number;
  processedMessageTtlMs?: number;
}

interface SyncBufFile {
  buf?: string;
}

interface RoutesFile {
  routes?: RuntimeRoute[];
}

interface ProcessedMessagesFile {
  records?: RuntimeProcessedMessageRecord[];
}

const DEFAULT_MAX_PROCESSED_MESSAGES = 5_000;
const DEFAULT_PROCESSED_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Missing files are fine for a local state store.
  }
}

export class FileRuntimeStateStore implements RuntimeStateStore {
  readonly baseDir: string;
  private maxProcessedMessages: number;
  private processedMessageTtlMs: number;

  constructor(opts: FileRuntimeStateStoreOptions) {
    this.baseDir = opts.baseDir;
    this.maxProcessedMessages =
      opts.maxProcessedMessages ?? DEFAULT_MAX_PROCESSED_MESSAGES;
    this.processedMessageTtlMs =
      opts.processedMessageTtlMs ?? DEFAULT_PROCESSED_MESSAGE_TTL_MS;
  }

  profileDir(profileId: string): string {
    return profileId === "default"
      ? this.baseDir
      : path.join(this.baseDir, "profiles", profileId);
  }

  credentialsPath(profileId: string): string {
    return path.join(this.profileDir(profileId), "credentials.json");
  }

  syncBufPath(profileId: string): string {
    return path.join(this.profileDir(profileId), "sync-buf.json");
  }

  routesPath(profileId: string): string {
    return path.join(this.profileDir(profileId), "routes.json");
  }

  processedMessagesPath(profileId: string): string {
    return path.join(this.profileDir(profileId), "processed-messages.json");
  }

  memoryDir(profileId: string): string {
    return path.join(this.profileDir(profileId), "memory");
  }

  mediaDir(profileId: string): string {
    return path.join(this.profileDir(profileId), "media");
  }

  async loadCredentials(profileId: string): Promise<RuntimeSavedCredentials | null> {
    return readJson<RuntimeSavedCredentials>(this.credentialsPath(profileId));
  }

  async saveCredentials(
    profileId: string,
    credentials: RuntimeSavedCredentials,
  ): Promise<void> {
    const filePath = this.credentialsPath(profileId);
    await writeJson(filePath, credentials);
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Best-effort only; some filesystems ignore chmod.
    }
  }

  async clearCredentials(profileId: string): Promise<void> {
    await removeFile(this.credentialsPath(profileId));
  }

  async loadSyncBuf(profileId: string): Promise<string | undefined> {
    const data = await readJson<SyncBufFile>(this.syncBufPath(profileId));
    return data?.buf;
  }

  async saveSyncBuf(profileId: string, buf: string): Promise<void> {
    await writeJson(this.syncBufPath(profileId), { buf });
  }

  async loadRoutes(profileId: string): Promise<RuntimeRoute[]> {
    const data = await readJson<RoutesFile>(this.routesPath(profileId));
    return data?.routes ?? [];
  }

  async saveRoutes(profileId: string, routes: RuntimeRoute[]): Promise<void> {
    await writeJson(this.routesPath(profileId), { routes });
  }

  async hasProcessedMessage(profileId: string, key: string): Promise<boolean> {
    const records = await this.loadProcessedMessages(profileId);
    return records.some((record) => record.key === key);
  }

  async markProcessedMessage(record: RuntimeProcessedMessageRecord): Promise<void> {
    const records = await this.loadProcessedMessages(record.profileId);
    const withoutExisting = records.filter((item) => item.key !== record.key);
    withoutExisting.push(record);
    await this.saveProcessedMessages(record.profileId, withoutExisting);
  }

  private async loadProcessedMessages(
    profileId: string,
  ): Promise<RuntimeProcessedMessageRecord[]> {
    const data = await readJson<ProcessedMessagesFile>(
      this.processedMessagesPath(profileId),
    );
    return this.pruneProcessedMessages(data?.records ?? []);
  }

  private async saveProcessedMessages(
    profileId: string,
    records: RuntimeProcessedMessageRecord[],
  ): Promise<void> {
    await writeJson(this.processedMessagesPath(profileId), {
      records: this.pruneProcessedMessages(records),
    });
  }

  private pruneProcessedMessages(
    records: RuntimeProcessedMessageRecord[],
  ): RuntimeProcessedMessageRecord[] {
    const minProcessedAt = Date.now() - this.processedMessageTtlMs;
    return records
      .filter((record) => record.processedAt >= minProcessedAt)
      .sort((a, b) => a.processedAt - b.processedAt)
      .slice(-this.maxProcessedMessages);
  }
}
