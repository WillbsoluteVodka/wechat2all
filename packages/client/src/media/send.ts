/**
 * High-level message sending helpers.
 *
 * Builds SendMessageReq payloads for text, image, video, and file messages,
 * and dispatches them through the ApiClient.
 */
import path from "node:path";

import type { ApiClient } from "../api/client.js";
import type {
  MessageItem,
  SendMessageReq,
} from "../api/types.js";
import {
  MessageItemType,
  MessageState,
  MessageType,
  VoiceEncodeType,
} from "../api/types.js";
import { getMimeFromFilename } from "../util/mime.js";
import type { UploadedFileInfo } from "./upload.js";
import type { MediaUploadOptions } from "./upload.js";
import { uploadImage, uploadVideo, uploadFile, uploadVoice } from "./upload.js";
import { generateId } from "../util/random.js";

export interface VoiceMessageOptions {
  /** Voice duration in milliseconds. */
  playtimeMs?: number;
  /** WeChat voice encoding type. Defaults to SILK for .silk files, otherwise inferred where possible. */
  encodeType?: number;
  /** Audio sample rate in Hz. */
  sampleRate?: number;
  /** Bits per sample for PCM-like encodings. */
  bitsPerSample?: number;
}

export interface VoiceFileSendOptions extends VoiceMessageOptions {
  upload?: MediaUploadOptions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateClientId(): string {
  return generateId("wechat-ilink");
}

function assertNonEmpty(name: string, value: string): void {
  if (!value.trim()) {
    throw new Error(`${name} is required`);
  }
}

function assertUploaded(uploaded: UploadedFileInfo): void {
  if (!uploaded.downloadEncryptedQueryParam.trim()) {
    throw new Error("uploaded.downloadEncryptedQueryParam is required");
  }
  if (!uploaded.aeskey.trim()) {
    throw new Error("uploaded.aeskey is required");
  }
}

function buildReq(params: {
  to: string;
  contextToken?: string;
  items: MessageItem[];
}): SendMessageReq {
  assertNonEmpty("to", params.to);
  if (params.contextToken !== undefined) {
    assertNonEmpty("contextToken", params.contextToken);
  }
  return {
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: generateClientId(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: params.items.length ? params.items : undefined,
      context_token: params.contextToken ?? undefined,
    },
  };
}

function inferVoiceEncodeType(filePath: string): number | undefined {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".silk":
      return VoiceEncodeType.SILK;
    case ".amr":
      return VoiceEncodeType.AMR;
    case ".mp3":
      return VoiceEncodeType.MP3;
    case ".ogg":
    case ".spx":
      return VoiceEncodeType.OGG_SPEEX;
    case ".wav":
    case ".pcm":
      return VoiceEncodeType.PCM;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public send helpers
// ---------------------------------------------------------------------------

/**
 * Send a text message. contextToken is required (echoed from getUpdates).
 */
export async function sendText(
  api: ApiClient,
  to: string,
  text: string,
  contextToken: string,
): Promise<string> {
  assertNonEmpty("to", to);
  assertNonEmpty("contextToken", contextToken);
  const clientId = generateClientId();
  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text
        ? [{ type: MessageItemType.TEXT, text_item: { text } }]
        : undefined,
      context_token: contextToken,
    },
  };
  await api.sendMessage(req);
  return clientId;
}

/**
 * Send an image message with a previously uploaded file.
 */
export async function sendImage(
  api: ApiClient,
  to: string,
  uploaded: UploadedFileInfo,
  contextToken: string,
  caption?: string,
): Promise<string> {
  assertUploaded(uploaded);
  const items: MessageItem[] = [];
  if (caption) {
    items.push({
      type: MessageItemType.TEXT,
      text_item: { text: caption },
    });
  }
  items.push({
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  });

  // Send each item as its own request (text first, then image)
  let lastClientId = "";
  for (const item of items) {
    const req = buildReq({ to, contextToken, items: [item] });
    lastClientId = req.msg?.client_id ?? lastClientId;
    await api.sendMessage(req);
  }
  return lastClientId;
}

/**
 * Send a video message with a previously uploaded file.
 */
export async function sendVideo(
  api: ApiClient,
  to: string,
  uploaded: UploadedFileInfo,
  contextToken: string,
  caption?: string,
): Promise<string> {
  assertUploaded(uploaded);
  const items: MessageItem[] = [];
  if (caption) {
    items.push({
      type: MessageItemType.TEXT,
      text_item: { text: caption },
    });
  }
  items.push({
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  });

  let lastClientId = "";
  for (const item of items) {
    const req = buildReq({ to, contextToken, items: [item] });
    lastClientId = req.msg?.client_id ?? lastClientId;
    await api.sendMessage(req);
  }
  return lastClientId;
}

/**
 * Send a file attachment with a previously uploaded file.
 */
export async function sendFileMessage(
  api: ApiClient,
  to: string,
  fileName: string,
  uploaded: UploadedFileInfo,
  contextToken: string,
  caption?: string,
): Promise<string> {
  assertNonEmpty("fileName", fileName);
  assertUploaded(uploaded);
  const items: MessageItem[] = [];
  if (caption) {
    items.push({
      type: MessageItemType.TEXT,
      text_item: { text: caption },
    });
  }
  items.push({
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  });

  let lastClientId = "";
  for (const item of items) {
    const req = buildReq({ to, contextToken, items: [item] });
    lastClientId = req.msg?.client_id ?? lastClientId;
    await api.sendMessage(req);
  }
  return lastClientId;
}

/**
 * Send a voice message with a previously uploaded voice file.
 */
export async function sendVoice(
  api: ApiClient,
  to: string,
  uploaded: UploadedFileInfo,
  contextToken: string,
  options: VoiceMessageOptions = {},
): Promise<string> {
  assertUploaded(uploaded);
  const req = buildReq({
    to,
    contextToken,
    items: [
      {
        type: MessageItemType.VOICE,
        voice_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
            encrypt_type: 1,
          },
          encode_type: options.encodeType,
          sample_rate: options.sampleRate,
          bits_per_sample: options.bitsPerSample,
          playtime: options.playtimeMs,
        },
      },
    ],
  });

  const clientId = req.msg?.client_id ?? "";
  await api.sendMessage(req);
  return clientId;
}

/**
 * Upload and send a local file as a native WeChat voice message.
 *
 * This is explicit on purpose: not every audio file should be displayed as a
 * WeChat voice bubble. For TTS, prefer generating SILK and set playtimeMs.
 */
export async function sendVoiceFile(
  api: ApiClient,
  to: string,
  filePath: string,
  contextToken: string,
  options: VoiceFileSendOptions = {},
): Promise<string> {
  assertNonEmpty("filePath", filePath);
  const uploaded = await uploadVoice({
    filePath,
    toUserId: to,
    api,
    cdnBaseUrl: api.cdnBaseUrl,
    options: options.upload,
  });
  return sendVoice(api, to, uploaded, contextToken, {
    ...options,
    encodeType: options.encodeType ?? inferVoiceEncodeType(filePath),
  });
}

/**
 * Upload and send a local file as a media message. Routing by MIME type:
 *   - video/*  -> video message
 *   - image/*  -> image message
 *   - else     -> file attachment
 */
export async function sendMediaFile(
  api: ApiClient,
  to: string,
  filePath: string,
  contextToken: string,
  caption?: string,
  options?: MediaUploadOptions,
): Promise<string> {
  assertNonEmpty("filePath", filePath);
  const mime = getMimeFromFilename(filePath);
  const cdnBaseUrl = api.cdnBaseUrl;

  if (mime.startsWith("video/")) {
    const uploaded = await uploadVideo({
      filePath,
      toUserId: to,
      api,
      cdnBaseUrl,
      options,
    });
    return sendVideo(api, to, uploaded, contextToken, caption);
  }

  if (mime.startsWith("image/")) {
    const uploaded = await uploadImage({
      filePath,
      toUserId: to,
      api,
      cdnBaseUrl,
      options,
    });
    return sendImage(api, to, uploaded, contextToken, caption);
  }

  // File attachment
  const fileName = path.basename(filePath);
  const uploaded = await uploadFile({
    filePath,
    toUserId: to,
    api,
    cdnBaseUrl,
    options,
  });
  return sendFileMessage(
    api,
    to,
    fileName,
    uploaded,
    contextToken,
    caption,
  );
}
