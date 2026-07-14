import crypto from "node:crypto";
import type { Dirent } from "node:fs";
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

function safeProfileDirName(profileId: string): string {
  const safe = profileId
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "") || "profile";
  if (safe === profileId) return safe;
  const digest = crypto
    .createHash("sha256")
    .update(profileId)
    .digest("hex")
    .slice(0, 8);
  return `${safe}-${digest}`;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
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
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Missing files are fine for a local state store.
  }
}

async function secureStateTree(dir: string): Promise<void> {
  await fs.chmod(dir, 0o700).catch(() => undefined);
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await secureStateTree(child);
    } else if (entry.isFile()) {
      await fs.chmod(child, 0o600).catch(() => undefined);
    }
  }
}

export class FileRuntimeStateStore implements RuntimeStateStore {
  readonly baseDir: string;
  private maxProcessedMessages: number;
  private processedMessageTtlMs: number;
  private processedMessageWrites = new Map<string, Promise<void>>();

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
      : path.join(this.baseDir, "profiles", safeProfileDirName(profileId));
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

  async securePermissions(): Promise<void> {
    await ensureDir(this.baseDir);
    await secureStateTree(this.baseDir);
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
    const previous = this.processedMessageWrites.get(record.profileId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const records = await this.loadProcessedMessages(record.profileId);
      const withoutExisting = records.filter((item) => item.key !== record.key);
      withoutExisting.push(record);
      await this.saveProcessedMessages(record.profileId, withoutExisting);
    });
    this.processedMessageWrites.set(record.profileId, current);
    try {
      await current;
    } finally {
      if (this.processedMessageWrites.get(record.profileId) === current) {
        this.processedMessageWrites.delete(record.profileId);
      }
    }
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
