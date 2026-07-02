/**
 * Low-level HTTP API client for the WeChat iLink bot protocol.
 *
 * Endpoints (all POST JSON):
 *   - ilink/bot/getupdates        — long-poll for new messages
 *   - ilink/bot/sendmessage       — send a message (text/image/video/file)
 *   - ilink/bot/getuploadurl      — get CDN upload pre-signed URL
 *   - ilink/bot/getconfig         — get account config (typing ticket, etc.)
 *   - ilink/bot/sendtyping        — send/cancel typing indicator
 *   - ilink/bot/get_bot_qrcode    — initiate QR code login (GET)
 *   - ilink/bot/get_qrcode_status — poll QR scan status (GET)
 */
import crypto from "node:crypto";

import type {
  BaseInfo,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetConfigResp,
  SendMessageReq,
  SendTypingReq,
  QRCodeResponse,
  QRCodeStatusResponse,
} from "./types.js";
import { WeChatApiError } from "./errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** Default long-poll timeout for getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests. */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
/** Default client-side timeout for get_qrcode_status long-poll. */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default bot_type value. */
export const DEFAULT_BOT_TYPE = "3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

// ---------------------------------------------------------------------------
// API client options
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  baseUrl?: string;
  cdnBaseUrl?: string;
  token?: string;
  /** Channel version string sent as base_info.channel_version. */
  channelVersion?: string;
  /** Optional SKRouteTag header. */
  routeTag?: string;
  /** Timeout for regular API requests in ms. */
  apiTimeoutMs?: number;
  /** Timeout for lightweight config/typing requests in ms. */
  configTimeoutMs?: number;
  /** Timeout for QR code fetch requests in ms. */
  qrTimeoutMs?: number;
  /** Timeout for QR status long-poll requests in ms. */
  qrLongPollTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// ApiClient
// ---------------------------------------------------------------------------

export class ApiClient {
  private apiBaseUrl: string;
  readonly cdnBaseUrl: string;
  private token?: string;
  private channelVersion: string;
  private routeTag?: string;
  private apiTimeoutMs: number;
  private configTimeoutMs: number;
  private qrTimeoutMs: number;
  private qrLongPollTimeoutMs: number;

  constructor(opts: ApiClientOptions = {}) {
    this.apiBaseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.cdnBaseUrl = opts.cdnBaseUrl ?? CDN_BASE_URL;
    this.token = opts.token;
    this.channelVersion = opts.channelVersion ?? "standalone-0.1.0";
    this.routeTag = opts.routeTag;
    this.apiTimeoutMs = opts.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    this.configTimeoutMs = opts.configTimeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS;
    this.qrTimeoutMs = opts.qrTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    this.qrLongPollTimeoutMs =
      opts.qrLongPollTimeoutMs ?? QR_LONG_POLL_TIMEOUT_MS;
  }

  /** Update the bearer token (after QR login). */
  setToken(token: string): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  /** API base URL currently used for iLink requests. */
  get baseUrl(): string {
    return this.apiBaseUrl;
  }

  /** Update the API base URL returned by QR login. */
  setBaseUrl(baseUrl: string): void {
    if (baseUrl.trim()) {
      this.apiBaseUrl = baseUrl.trim();
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private buildBaseInfo(): BaseInfo {
    return { channel_version: this.channelVersion };
  }

  private buildHeaders(bodyStr: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
      "X-WECHAT-UIN": randomWechatUin(),
    };
    if (this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`;
    }
    if (this.routeTag) {
      headers.SKRouteTag = this.routeTag;
    }
    return headers;
  }

  /**
   * POST JSON to an iLink API endpoint with timeout + abort.
   */
  private async apiFetch(params: {
    endpoint: string;
    body: string;
    timeoutMs: number;
  }): Promise<string> {
    const base = ensureTrailingSlash(this.baseUrl);
    const url = new URL(params.endpoint, base);
    const headers = this.buildHeaders(params.body);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, params.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: params.body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const rawText = await res.text();
      if (!res.ok) {
        throw new WeChatApiError({
          endpoint: params.endpoint,
          status: res.status,
          statusText: res.statusText,
          responseBody: rawText,
          message: `API ${params.endpoint} ${res.status} ${res.statusText}: ${rawText}`,
        });
      }
      return rawText;
    } catch (err) {
      clearTimeout(timer);
      if (timedOut) {
        throw new WeChatApiError({
          endpoint: params.endpoint,
          timedOut: true,
          cause: err,
          message: `API ${params.endpoint} timed out after ${params.timeoutMs}ms`,
        });
      }
      throw err;
    }
  }

  private parseJson<T>(endpoint: string, rawText: string): T {
    try {
      return JSON.parse(rawText) as T;
    } catch (err) {
      throw new WeChatApiError({
        endpoint,
        responseBody: rawText,
        cause: err,
        message: `API ${endpoint} returned invalid JSON`,
      });
    }
  }

  private assertApiSuccess(
    endpoint: string,
    resp: { ret?: number; errcode?: number; errmsg?: string },
  ): void {
    const failed =
      (resp.ret !== undefined && resp.ret !== 0) ||
      (resp.errcode !== undefined && resp.errcode !== 0);
    if (!failed) return;

    throw new WeChatApiError({
      endpoint,
      ret: resp.ret,
      errcode: resp.errcode,
      errmsg: resp.errmsg,
      responseBody: JSON.stringify(resp),
      message: `API ${endpoint} failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
    });
  }

  // -----------------------------------------------------------------------
  // Public API methods
  // -----------------------------------------------------------------------

  /**
   * Long-poll for new messages. Returns empty response on client-side timeout
   * (normal for long-poll).
   */
  async getUpdates(
    getUpdatesBuf: string,
    timeoutMs?: number,
  ): Promise<GetUpdatesResp> {
    const timeout = timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    try {
      const rawText = await this.apiFetch({
        endpoint: "ilink/bot/getupdates",
        body: JSON.stringify({
          get_updates_buf: getUpdatesBuf,
          base_info: this.buildBaseInfo(),
        }),
        timeoutMs: timeout,
      });
      return this.parseJson<GetUpdatesResp>(
        "ilink/bot/getupdates",
        rawText,
      );
    } catch (err) {
      if (
        (err instanceof Error && err.name === "AbortError") ||
        (err instanceof WeChatApiError && err.timedOut)
      ) {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw err;
    }
  }

  /** Send a message downstream. */
  async sendMessage(req: SendMessageReq): Promise<void> {
    const endpoint = "ilink/bot/sendmessage";
    const rawText = await this.apiFetch({
      endpoint,
      body: JSON.stringify({ ...req, base_info: this.buildBaseInfo() }),
      timeoutMs: this.apiTimeoutMs,
    });
    if (rawText.trim()) {
      this.assertApiSuccess(
        endpoint,
        this.parseJson(endpoint, rawText),
      );
    }
  }

  /** Get a pre-signed CDN upload URL. */
  async getUploadUrl(
    req: GetUploadUrlReq,
  ): Promise<GetUploadUrlResp> {
    const endpoint = "ilink/bot/getuploadurl";
    const rawText = await this.apiFetch({
      endpoint,
      body: JSON.stringify({
        ...req,
        base_info: this.buildBaseInfo(),
      }),
      timeoutMs: this.apiTimeoutMs,
    });
    const resp = this.parseJson<GetUploadUrlResp>(endpoint, rawText);
    this.assertApiSuccess(endpoint, resp);
    return resp;
  }

  /** Fetch bot config (includes typing_ticket) for a given user. */
  async getConfig(
    ilinkUserId: string,
    contextToken?: string,
  ): Promise<GetConfigResp> {
    const endpoint = "ilink/bot/getconfig";
    const rawText = await this.apiFetch({
      endpoint,
      body: JSON.stringify({
        ilink_user_id: ilinkUserId,
        context_token: contextToken,
        base_info: this.buildBaseInfo(),
      }),
      timeoutMs: this.configTimeoutMs,
    });
    const resp = this.parseJson<GetConfigResp>(endpoint, rawText);
    this.assertApiSuccess(endpoint, resp);
    return resp;
  }

  /** Send a typing indicator. */
  async sendTyping(req: SendTypingReq): Promise<void> {
    const endpoint = "ilink/bot/sendtyping";
    const rawText = await this.apiFetch({
      endpoint,
      body: JSON.stringify({
        ...req,
        base_info: this.buildBaseInfo(),
      }),
      timeoutMs: this.configTimeoutMs,
    });
    if (rawText.trim()) {
      this.assertApiSuccess(
        endpoint,
        this.parseJson(endpoint, rawText),
      );
    }
  }

  // -----------------------------------------------------------------------
  // QR code login (these use GET, not POST)
  // -----------------------------------------------------------------------

  /** Fetch a new QR code for bot login. */
  async getQRCode(botType?: string): Promise<QRCodeResponse> {
    const base = ensureTrailingSlash(this.baseUrl);
    const bt = botType ?? DEFAULT_BOT_TYPE;
    const url = new URL(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(bt)}`,
      base,
    );

    const headers: Record<string, string> = {};
    if (this.routeTag) {
      headers.SKRouteTag = this.routeTag;
    }

    const rawText = await this.getFetchText({
      endpoint: "ilink/bot/get_bot_qrcode",
      url,
      headers,
      timeoutMs: this.qrTimeoutMs,
    });
    const resp = this.parseJson<QRCodeResponse>(
      "ilink/bot/get_bot_qrcode",
      rawText,
    );
    if (!resp.qrcode || !resp.qrcode_img_content) {
      throw new WeChatApiError({
        endpoint: "ilink/bot/get_bot_qrcode",
        responseBody: rawText,
        message: "QR code response is missing qrcode or qrcode_img_content",
      });
    }
    return resp;
  }

  /**
   * Long-poll the QR code scan status.
   * Returns `{ status: "wait" }` on client-side timeout.
   */
  async pollQRCodeStatus(
    qrcode: string,
  ): Promise<QRCodeStatusResponse> {
    const base = ensureTrailingSlash(this.baseUrl);
    const url = new URL(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      base,
    );

    const headers: Record<string, string> = {
      "iLink-App-ClientVersion": "1",
    };
    if (this.routeTag) {
      headers.SKRouteTag = this.routeTag;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      this.qrLongPollTimeoutMs,
    );
    try {
      const res = await fetch(url.toString(), {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const rawText = await res.text();
      if (!res.ok) {
        throw new WeChatApiError({
          endpoint: "ilink/bot/get_qrcode_status",
          status: res.status,
          statusText: res.statusText,
          responseBody: rawText,
          message: `Failed to poll QR status: ${res.status} ${res.statusText}: ${rawText}`,
        });
      }
      return this.parseJson<QRCodeStatusResponse>(
        "ilink/bot/get_qrcode_status",
        rawText,
      );
    } catch (err) {
      clearTimeout(timer);
      if ((err instanceof Error && err.name === "AbortError") || timedOut) {
        return { status: "wait" };
      }
      throw err;
    }
  }

  private async getFetchText(params: {
    endpoint: string;
    url: URL;
    headers: Record<string, string>;
    timeoutMs: number;
  }): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, params.timeoutMs);
    try {
      const res = await fetch(params.url.toString(), {
        headers: params.headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const rawText = await res.text();
      if (!res.ok) {
        throw new WeChatApiError({
          endpoint: params.endpoint,
          status: res.status,
          statusText: res.statusText,
          responseBody: rawText,
          message: `API ${params.endpoint} ${res.status} ${res.statusText}: ${rawText}`,
        });
      }
      return rawText;
    } catch (err) {
      clearTimeout(timer);
      if (timedOut) {
        throw new WeChatApiError({
          endpoint: params.endpoint,
          timedOut: true,
          cause: err,
          message: `API ${params.endpoint} timed out after ${params.timeoutMs}ms`,
        });
      }
      throw err;
    }
  }
}
