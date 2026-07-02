import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { MediaDownloadOptions, WeChatClient } from "wechat2all";

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
}

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

async function writeCachedMedia(params: {
  cacheDir: string;
  profileId: string;
  mediaId: string;
  attachment: RuntimeAttachment;
  data: Buffer;
}): Promise<string> {
  const dir = path.join(params.cacheDir, params.profileId);
  await fs.mkdir(dir, { recursive: true });
  const base = safeFileName(
    params.attachment.fileName ??
      `${params.mediaId}${extensionForAttachment(params.attachment)}`,
  );
  const filePath = path.join(dir, base);
  await fs.writeFile(filePath, params.data);
  return filePath;
}

export class RuntimeMediaPipeline {
  private cacheDir?: string;
  private download?: MediaDownloadOptions;

  constructor(opts: RuntimeMediaPipelineOptions = {}) {
    this.cacheDir = opts.cacheDir;
    this.download = opts.download;
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

    const mediaId = crypto
      .createHash("sha256")
      .update(`${params.message.id}:${params.attachment.id ?? ""}:${downloaded.data.length}`)
      .digest("hex")
      .slice(0, 16);
    const filePath = this.cacheDir
      ? await writeCachedMedia({
          cacheDir: this.cacheDir,
          profileId: params.message.profileId,
          mediaId,
          attachment: params.attachment,
          data: downloaded.data,
        })
      : undefined;

    return {
      id: mediaId,
      messageId: params.message.id,
      attachmentId: params.attachment.id,
      kind: params.attachment.kind,
      fileName: downloaded.fileName ?? params.attachment.fileName,
      mimeType: params.attachment.mimeType,
      size: downloaded.data.length,
      data: downloaded.data,
      filePath,
    };
  }

  async downloadMessageMedia(params: {
    client: WeChatClient;
    message: RuntimeMessage;
  }): Promise<RuntimeCachedMedia[]> {
    const media: RuntimeCachedMedia[] = [];
    for (const attachment of params.message.attachments) {
      const downloaded = await this.downloadAttachment({
        client: params.client,
        message: params.message,
        attachment,
      });
      if (downloaded) media.push(downloaded);
    }
    return media;
  }
}
