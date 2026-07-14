import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { getMimeFromFilename, type MediaDownloadOptions, type WeChatClient } from "wechat2all";

import type { RuntimeAttachment, RuntimeMessage } from "../types.js";

export interface RuntimeCachedMedia {
  id: string;
  messageId: string;
  attachmentId?: string;
  kind: RuntimeAttachment["kind"];
  fileName?: string;
  mimeType?: string;
  size: number;
  data: Buffer;
  filePath?: string;
}

export interface RuntimeMediaPipelineOptions {
  cacheDir?: string;
  download?: MediaDownloadOptions;
  downloadConcurrency?: number;
  cacheTtlMs?: number;
  maxCacheBytes?: number;
  pruneIntervalMs?: number;
}

interface CachedFileEntry {
  filePath: string;
  size: number;
  mtimeMs: number;
}

export interface RuntimeMediaCacheStats {
  cacheDir?: string;
  profileId?: string;
  fileCount: number;
  totalBytes: number;
  oldestMtimeMs?: number;
  newestMtimeMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
const DEFAULT_DOWNLOAD_CONCURRENCY = 3;

function extensionForAttachment(attachment: RuntimeAttachment): string {
  if (attachment.fileName && path.extname(attachment.fileName)) {
    return path.extname(attachment.fileName);
  }
  switch (attachment.kind) {
    case "image":
      return ".jpg";
    case "voice":
      return ".silk";
    case "video":
      return ".mp4";
    case "file":
      return ".bin";
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "media";
}

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
  return `${safe === "media" ? "profile" : safe}-${digest}`;
}

function cacheProfileDir(cacheDir: string, profileId: string): string {
  return path.join(cacheDir, safeProfileDirName(profileId));
}

function cachedFileName(params: {
  downloadedFileName?: string;
  attachment: RuntimeAttachment;
  filePath?: string;
}): string | undefined {
  return params.downloadedFileName ??
    params.attachment.fileName ??
    (params.filePath ? path.basename(params.filePath) : undefined);
}

function cachedMimeType(params: {
  fileName?: string;
  filePath?: string;
  attachment: RuntimeAttachment;
}): string | undefined {
  if (params.attachment.mimeType) return params.attachment.mimeType;
  if (params.fileName) return getMimeFromFilename(params.fileName);
  if (params.filePath) return getMimeFromFilename(params.filePath);
  return getMimeFromFilename(`media${extensionForAttachment(params.attachment)}`);
}

async function writeCachedMedia(params: {
  cacheDir: string;
  profileId: string;
  mediaId: string;
  attachment: RuntimeAttachment;
  data: Buffer;
}): Promise<string> {
  const dir = cacheProfileDir(params.cacheDir, params.profileId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const originalName = safeFileName(
    params.attachment.fileName ??
      `${params.mediaId}${extensionForAttachment(params.attachment)}`,
  );
  const base = `${params.mediaId}-${originalName}`;
  const filePath = path.join(dir, base);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tmpPath, params.data, { mode: 0o600 });
    await fs.rename(tmpPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
  return filePath;
}

export class RuntimeMediaPipeline {
  private cacheDir?: string;
  private download?: MediaDownloadOptions;
  private downloadConcurrency: number;
  private cacheTtlMs: number;
  private maxCacheBytes: number;
  private pruneIntervalMs: number;
  private nextPruneAt = 0;
  private prunePromise?: Promise<void>;

  constructor(opts: RuntimeMediaPipelineOptions = {}) {
    this.cacheDir = opts.cacheDir;
    this.download = opts.download;
    this.downloadConcurrency = Math.max(
      1,
      Math.floor(opts.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY),
    );
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheBytes = opts.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  }

  async downloadAttachment(params: {
    client: WeChatClient;
    message: RuntimeMessage;
    attachment: RuntimeAttachment;
  }): Promise<RuntimeCachedMedia | null> {
    const downloaded = await params.client.downloadMedia(
      params.attachment.raw,
      this.download,
    );
    if (!downloaded) return null;

    const mediaHash = crypto.createHash("sha256");
    mediaHash.update([
      params.message.id,
      params.attachment.id ?? "",
      params.attachment.kind,
      params.attachment.fileName ?? downloaded.fileName ?? "",
    ].join("\u0000"));
    mediaHash.update("\u0000");
    mediaHash.update(downloaded.data);
    const mediaId = mediaHash.digest("hex").slice(0, 16);
    const filePath = this.cacheDir
      ? await writeCachedMedia({
          cacheDir: this.cacheDir,
          profileId: params.message.profileId,
          mediaId,
          attachment: params.attachment,
          data: downloaded.data,
        })
      : undefined;
    if (this.cacheDir) await this.pruneCacheIfNeeded();
    const fileName = cachedFileName({
      downloadedFileName: downloaded.fileName,
      attachment: params.attachment,
      filePath,
    });

    return {
      id: mediaId,
      messageId: params.message.id,
      attachmentId: params.attachment.id,
      kind: params.attachment.kind,
      fileName,
      mimeType: cachedMimeType({
        fileName,
        filePath,
        attachment: params.attachment,
      }),
      size: downloaded.data.length,
      data: downloaded.data,
      filePath,
    };
  }

  async downloadMessageMedia(params: {
    client: WeChatClient;
    message: RuntimeMessage;
  }): Promise<RuntimeCachedMedia[]> {
    const attachments = params.message.attachments;
    if (!attachments.length) return [];

    const results = new Array<RuntimeCachedMedia | null>(attachments.length);
    const failures: Array<{ index: number; error: Error }> = [];
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < attachments.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await this.downloadAttachment({
            client: params.client,
            message: params.message,
            attachment: attachments[index],
          });
        } catch (error) {
          failures.push({
            index,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    };
    const workerCount = Math.min(this.downloadConcurrency, attachments.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failures.length) {
      failures.sort((a, b) => a.index - b.index);
      const detail = failures
        .map(({ index, error }) => `#${index + 1}: ${error.message}`)
        .join("; ");
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Failed to download ${failures.length} of ${attachments.length} attachment(s): ${detail}`,
      );
    }
    return results.filter((item): item is RuntimeCachedMedia => item !== null);
  }

  async pruneCache(): Promise<void> {
    if (!this.cacheDir) return;
    const cacheDir = this.cacheDir;
    const entries = await collectCachedFiles(cacheDir);
    const now = Date.now();
    const keep: CachedFileEntry[] = [];

    for (const entry of entries) {
      if (this.cacheTtlMs > 0 && now - entry.mtimeMs > this.cacheTtlMs) {
        await removeCacheFile(entry.filePath);
        continue;
      }
      keep.push(entry);
    }

    if (this.maxCacheBytes > 0) {
      let total = keep.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of keep.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total <= this.maxCacheBytes) break;
        await removeCacheFile(entry.filePath);
        total -= entry.size;
      }
    }

    await removeEmptyDirectories(cacheDir, cacheDir);
  }

  async getCacheStats(profileId?: string): Promise<RuntimeMediaCacheStats> {
    if (!this.cacheDir) {
      return {
        profileId,
        fileCount: 0,
        totalBytes: 0,
      };
    }
    const cacheDir = profileId ? cacheProfileDir(this.cacheDir, profileId) : this.cacheDir;
    const entries = await collectCachedFiles(cacheDir);
    return cacheStatsFromEntries({
      cacheDir,
      profileId,
      entries,
    });
  }

  async clearCache(profileId?: string): Promise<RuntimeMediaCacheStats> {
    if (!this.cacheDir) {
      return {
        profileId,
        fileCount: 0,
        totalBytes: 0,
      };
    }
    const cacheDir = profileId ? cacheProfileDir(this.cacheDir, profileId) : this.cacheDir;
    const entries = await collectCachedFiles(cacheDir);
    const stats = cacheStatsFromEntries({
      cacheDir,
      profileId,
      entries,
    });
    for (const entry of entries) {
      await removeCacheFile(entry.filePath);
    }
    await removeEmptyDirectories(cacheDir, cacheDir);
    return stats;
  }

  private async pruneCacheIfNeeded(): Promise<void> {
    if (!this.cacheDir) return;
    const now = Date.now();
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + Math.max(0, this.pruneIntervalMs);
    this.prunePromise ??= this.pruneCache().finally(() => {
      this.prunePromise = undefined;
    });
    await this.prunePromise;
  }
}

function cacheStatsFromEntries(params: {
  cacheDir: string;
  profileId?: string;
  entries: CachedFileEntry[];
}): RuntimeMediaCacheStats {
  const mtimes = params.entries.map((entry) => entry.mtimeMs);
  return {
    cacheDir: params.cacheDir,
    profileId: params.profileId,
    fileCount: params.entries.length,
    totalBytes: params.entries.reduce((sum, entry) => sum + entry.size, 0),
    oldestMtimeMs: mtimes.length ? Math.min(...mtimes) : undefined,
    newestMtimeMs: mtimes.length ? Math.max(...mtimes) : undefined,
  };
}

async function collectCachedFiles(dir: string): Promise<CachedFileEntry[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: CachedFileEntry[] = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectCachedFiles(filePath));
      continue;
    }
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(filePath);
      files.push({
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // File disappeared between readdir and stat.
    }
  }
  return files;
}

async function removeCacheFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cache pruning.
  }
}

async function removeEmptyDirectories(root: string, dir: string): Promise<boolean> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  let hasContent = false;
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childEmpty = await removeEmptyDirectories(root, child);
      if (!childEmpty) hasContent = true;
      continue;
    }
    hasContent = true;
  }

  if (dir !== root && !hasContent) {
    try {
      await fs.rmdir(dir);
      return true;
    } catch {
      return false;
    }
  }
  return !hasContent;
}
