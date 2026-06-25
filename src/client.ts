/**
 * WeChatClient — high-level client for the WeChat iLink bot protocol.
 *
 * Wraps the low-level API, QR login, long-poll monitor, media upload/download,
 * and message sending into a single EventEmitter-based interface.
 *
 * This is a pure in-memory client. It does NOT persist any data to disk.
 * The caller is responsible for:
 *   - Storing/loading the token and accountId across restarts
 *   - Storing/loading the sync buf (long-poll cursor) for message resume
 *   - Rendering QR codes during login
 *
 * Usage:
 *   const client = new WeChatClient({ token, accountId });
 *   client.on("message", (msg) => { ... });
 *   await client.start();
 */
import { EventEmitter } from "node:events";

import { ApiClient } from "./api/client.js";
import type { ApiClientOptions } from "./api/client.js";
import type {
  WeixinMessage,
  MessageItem,
  GetUpdatesResp,
  SendTypingReq,
} from "./api/types.js";
import { MessageItemType, TypingStatus } from "./api/types.js";
import { loginWithQRCode } from "./auth/qr-login.js";
import type { LoginResult, QRLoginOptions } from "./auth/qr-login.js";
import { downloadMediaFromItem } from "./media/download.js";
import type { DownloadedMedia } from "./media/download.js";
import type { MediaDownloadOptions } from "./media/download.js";
import {
  sendText,
  sendImage,
  sendVideo,
  sendFileMessage,
  sendMediaFile,
  sendVoiceFile,
} from "./media/send.js";
import type { VoiceFileSendOptions } from "./media/send.js";
import type { UploadedFileInfo } from "./media/upload.js";
import type { MediaUploadOptions } from "./media/upload.js";
import {
  uploadImage,
  uploadVideo,
  uploadFile,
  uploadVoice,
} from "./media/upload.js";
import { startMonitor } from "./monitor.js";
import type { MonitorOptions, MonitorCallbacks } from "./monitor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeChatClientOptions extends ApiClientOptions {
  /** Account ID. Set after login if not provided. */
  accountId?: string;
}

export interface WeChatSessionCredentials {
  accountId?: string;
  token?: string;
  baseUrl: string;
}

export interface WeChatClientEvents {
  message: [msg: WeixinMessage];
  error: [err: Error];
  sessionExpired: [];
  poll: [resp: GetUpdatesResp];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text body from a message's item_list. */
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (
      item.type === MessageItemType.TEXT &&
      item.text_item?.text != null
    ) {
      return String(item.text_item.text);
    }
    // Voice-to-text
    if (
      item.type === MessageItemType.VOICE &&
      item.voice_item?.text
    ) {
      return item.voice_item.text;
    }
  }
  return "";
}

/**
 * Normalize a raw account ID (e.g. "hex@im.bot") to a safe key
 * (e.g. "hex-im-bot").
 */
export function normalizeAccountId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[@.]/g, "-");
}

function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (active.length === 1) return active[0];

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }

  return controller.signal;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WeChatClient extends EventEmitter {
  readonly api: ApiClient;
  private accountId?: string;
  private abortController?: AbortController;
  private running = false;

  /** In-process cache: userId -> contextToken (echoed from getUpdates). */
  private contextTokens = new Map<string, string>();

  constructor(opts: WeChatClientOptions = {}) {
    super();
    this.api = new ApiClient(opts);
    this.accountId = opts.accountId
      ? normalizeAccountId(opts.accountId)
      : undefined;
  }

  // -----------------------------------------------------------------------
  // Getters / setters
  // -----------------------------------------------------------------------

  getAccountId(): string | undefined {
    return this.accountId;
  }

  isRunning(): boolean {
    return this.running;
  }

  getCredentials(): WeChatSessionCredentials {
    return {
      accountId: this.accountId,
      token: this.api.getToken(),
      baseUrl: this.api.baseUrl,
    };
  }

  /** Get the cached context token for a user (needed for sending replies). */
  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  // -----------------------------------------------------------------------
  // QR login
  // -----------------------------------------------------------------------

  /**
   * Run the QR code login flow. On success, configures the API client
   * with the new token and sets the accountId.
   *
   * The library does NOT render QR codes. Use `opts.onQRCode` to receive
   * the QR code URL and handle display yourself.
   *
   * The library does NOT persist credentials. The caller should save
   * `result.botToken`, `result.accountId`, and `result.baseUrl` themselves.
   */
  async login(opts: QRLoginOptions = {}): Promise<LoginResult> {
    const result = await loginWithQRCode(this.api, opts);

    if (result.connected && result.botToken && result.accountId) {
      this.accountId = normalizeAccountId(result.accountId);
      this.api.setToken(result.botToken);
      if (result.baseUrl) {
        this.api.setBaseUrl(result.baseUrl);
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Long-poll monitor
  // -----------------------------------------------------------------------

  /**
   * Start the long-poll monitor loop. Emits "message" events for each
   * inbound message.
   *
   * Sync buf persistence is opt-in via `opts.loadSyncBuf` / `opts.saveSyncBuf`.
   *
   * Call `stop()` to terminate.
   */
  async start(opts: Omit<MonitorOptions, "accountId"> = {}): Promise<void> {
    if (this.running) {
      throw new Error("WeChatClient monitor is already running.");
    }
    if (!this.accountId) {
      throw new Error(
        "No accountId set. Call login() first or pass accountId in constructor.",
      );
    }
    if (!this.api.getToken()) {
      throw new Error(
        "No token set. Call login() first or pass token in constructor options.",
      );
    }

    const internalController = new AbortController();
    this.abortController = internalController;
    this.running = true;
    const { signal: externalSignal, ...restOpts } = opts;
    const monitorSignal = mergeAbortSignals(
      internalController.signal,
      externalSignal,
    );

    const monitorOpts: MonitorOptions = {
      ...restOpts,
      signal: monitorSignal,
    };

    const callbacks: MonitorCallbacks = {
      onMessage: async (msg) => {
        // Cache context_token
        if (msg.context_token && msg.from_user_id) {
          this.contextTokens.set(
            msg.from_user_id,
            msg.context_token,
          );
        }
        this.emit("message", msg);
      },
      onError: (err) => {
        this.emit("error", err);
      },
      onSessionExpired: () => {
        this.emit("sessionExpired");
      },
      onPoll: (resp) => {
        this.emit("poll", resp);
      },
    };

    try {
      await startMonitor(this.api, monitorOpts, callbacks);
    } finally {
      if (this.abortController === internalController) {
        this.abortController = undefined;
      }
      this.running = false;
    }
  }

  /** Stop the long-poll monitor loop. */
  stop(): void {
    this.abortController?.abort();
    this.abortController = undefined;
  }

  // -----------------------------------------------------------------------
  // Sending messages
  // -----------------------------------------------------------------------

  /**
   * Send a text message. Uses the cached context token for the target user.
   * Pass an explicit contextToken to override.
   */
  async sendText(
    to: string,
    text: string,
    contextToken?: string,
  ): Promise<string> {
    const ct =
      contextToken ?? this.contextTokens.get(to);
    if (!ct) {
      throw new Error(
        `No context_token for user ${to}. Receive a message from them first.`,
      );
    }
    return sendText(this.api, to, text, ct);
  }

  /**
   * Upload a local file and send it as the appropriate media type.
   * (image/*, video/*, or file attachment based on MIME type.)
   */
  async sendMedia(
    to: string,
    filePath: string,
    caption?: string,
    contextToken?: string,
    options?: MediaUploadOptions,
  ): Promise<string> {
    const ct =
      contextToken ?? this.contextTokens.get(to);
    if (!ct) {
      throw new Error(
        `No context_token for user ${to}. Receive a message from them first.`,
      );
    }
    return sendMediaFile(this.api, to, filePath, ct, caption, options);
  }

  /**
   * Upload and send a local file as a native WeChat voice message.
   *
   * For best compatibility, generate SILK for TTS and pass playtimeMs.
   */
  async sendVoice(
    to: string,
    filePath: string,
    options: VoiceFileSendOptions = {},
    contextToken?: string,
  ): Promise<string> {
    const ct =
      contextToken ?? this.contextTokens.get(to);
    if (!ct) {
      throw new Error(
        `No context_token for user ${to}. Receive a message from them first.`,
      );
    }
    return sendVoiceFile(this.api, to, filePath, ct, options);
  }

  /**
   * Send an already-uploaded image.
   */
  async sendUploadedImage(
    to: string,
    uploaded: UploadedFileInfo,
    caption?: string,
    contextToken?: string,
  ): Promise<string> {
    const ct =
      contextToken ?? this.contextTokens.get(to);
    if (!ct) {
      throw new Error(
        `No context_token for user ${to}.`,
      );
    }
    return sendImage(this.api, to, uploaded, ct, caption);
  }

  /**
   * Send an already-uploaded video.
   */
  async sendUploadedVideo(
    to: string,
    uploaded: UploadedFileInfo,
    caption?: string,
    contextToken?: string,
  ): Promise<string> {
    const ct =
      contextToken ?? this.contextTokens.get(to);
    if (!ct) {
      throw new Error(
        `No context_token for user ${to}.`,
      );
    }
    return sendVideo(this.api, to, uploaded, ct, caption);
  }

  /**
   * Send an already-uploaded file attachment.
   */
  async sendUploadedFile(
    to: string,
    fileName: string,
    uploaded: UploadedFileInfo,
    caption?: string,
    contextToken?: string,
  ): Promise<string> {
    const ct =
      contextToken ?? this.contextTokens.get(to);
    if (!ct) {
      throw new Error(
        `No context_token for user ${to}.`,
      );
    }
    return sendFileMessage(
      this.api,
      to,
      fileName,
      uploaded,
      ct,
      caption,
    );
  }

  // -----------------------------------------------------------------------
  // Typing indicator
  // -----------------------------------------------------------------------

  /**
   * Send a "typing" indicator to the user. Requires a typing_ticket
   * (obtained from getConfig).
   */
  async sendTyping(
    userId: string,
    typingTicket: string,
    status: "typing" | "cancel" = "typing",
  ): Promise<void> {
    const req: SendTypingReq = {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status:
        status === "typing"
          ? TypingStatus.TYPING
          : TypingStatus.CANCEL,
    };
    await this.api.sendTyping(req);
  }

  /**
   * Get the typing ticket for a user (calls getConfig).
   */
  async getTypingTicket(
    userId: string,
    contextToken?: string,
  ): Promise<string> {
    const resp = await this.api.getConfig(userId, contextToken);
    return resp.typing_ticket ?? "";
  }

  // -----------------------------------------------------------------------
  // Media upload helpers
  // -----------------------------------------------------------------------

  async uploadImage(
    filePath: string,
    toUserId: string,
    options?: MediaUploadOptions,
  ): Promise<UploadedFileInfo> {
    return uploadImage({
      filePath,
      toUserId,
      api: this.api,
      cdnBaseUrl: this.api.cdnBaseUrl,
      options,
    });
  }

  async uploadVideo(
    filePath: string,
    toUserId: string,
    options?: MediaUploadOptions,
  ): Promise<UploadedFileInfo> {
    return uploadVideo({
      filePath,
      toUserId,
      api: this.api,
      cdnBaseUrl: this.api.cdnBaseUrl,
      options,
    });
  }

  async uploadFile(
    filePath: string,
    toUserId: string,
    options?: MediaUploadOptions,
  ): Promise<UploadedFileInfo> {
    return uploadFile({
      filePath,
      toUserId,
      api: this.api,
      cdnBaseUrl: this.api.cdnBaseUrl,
      options,
    });
  }

  async uploadVoice(
    filePath: string,
    toUserId: string,
    options?: MediaUploadOptions,
  ): Promise<UploadedFileInfo> {
    return uploadVoice({
      filePath,
      toUserId,
      api: this.api,
      cdnBaseUrl: this.api.cdnBaseUrl,
      options,
    });
  }

  // -----------------------------------------------------------------------
  // Media download
  // -----------------------------------------------------------------------

  /**
   * Download and decrypt a media item from an inbound message.
   */
  async downloadMedia(
    item: MessageItem,
    options?: MediaDownloadOptions,
  ): Promise<DownloadedMedia | null> {
    return downloadMediaFromItem(item, this.api.cdnBaseUrl, options);
  }

  // -----------------------------------------------------------------------
  // Static helpers
  // -----------------------------------------------------------------------

  /** Extract the text body from a WeixinMessage. */
  static extractText(msg: WeixinMessage): string {
    return extractTextBody(msg.item_list);
  }

  /** Check if a message item is a media type. */
  static isMediaItem(item: MessageItem): boolean {
    return (
      item.type === MessageItemType.IMAGE ||
      item.type === MessageItemType.VIDEO ||
      item.type === MessageItemType.FILE ||
      item.type === MessageItemType.VOICE
    );
  }
}
