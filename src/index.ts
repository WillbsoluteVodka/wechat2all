/**
 * wechat2all
 *
 * Local-first WeChat iLink gateway SDK.
 * Reverse-engineered from @tencent-weixin/openclaw-weixin.
 *
 * This library is stateless — it does NOT persist data to disk.
 * Credential storage, sync buf persistence, and QR code rendering
 * are the caller's responsibility.
 */

// Main client
export { WeChatClient, normalizeAccountId } from "./client.js";
export type {
  WeChatClientOptions,
  WeChatClientEvents,
  WeChatSessionCredentials,
} from "./client.js";

// Low-level API client
export { ApiClient, DEFAULT_BASE_URL, CDN_BASE_URL, DEFAULT_BOT_TYPE } from "./api/client.js";
export type { ApiClientOptions } from "./api/client.js";
export { WeChatApiError } from "./api/errors.js";
export type { WeChatApiErrorOptions } from "./api/errors.js";

// Protocol types
export {
  UploadMediaType,
  MessageType,
  MessageItemType,
  MessageState,
  TypingStatus,
  VoiceEncodeType,
} from "./api/types.js";
export type {
  BaseInfo,
  CDNMedia,
  TextItem,
  ImageItem,
  VoiceItem,
  FileItem,
  VideoItem,
  RefMessage,
  MessageItem,
  WeixinMessage,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendMessageResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetConfigReq,
  GetConfigResp,
  SendTypingReq,
  SendTypingResp,
  QRCodeResponse,
  QRCodeStatusResponse,
} from "./api/types.js";

// Auth
export { loginWithQRCode } from "./auth/qr-login.js";
export type { LoginResult, QRLoginOptions } from "./auth/qr-login.js";

// Monitor
export { startMonitor, SESSION_EXPIRED_ERRCODE } from "./monitor.js";
export type {
  MonitorOptions,
  MonitorCallbacks,
  SessionExpiredBehavior,
} from "./monitor.js";

// Media
export { downloadMediaFromItem } from "./media/download.js";
export type {
  DownloadedMedia,
  MediaDownloadOptions,
} from "./media/download.js";
export { uploadImage, uploadVideo, uploadFile } from "./media/upload.js";
export { uploadVoice } from "./media/upload.js";
export type {
  UploadedFileInfo,
  MediaUploadOptions,
} from "./media/upload.js";
export {
  sendText,
  sendImage,
  sendVideo,
  sendFileMessage,
  sendMediaFile,
  sendVoice,
  sendVoiceFile,
} from "./media/send.js";
export type {
  VoiceMessageOptions,
  VoiceFileSendOptions,
} from "./media/send.js";

// CDN primitives
export { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "./cdn/aes-ecb.js";
export { downloadAndDecrypt, downloadPlain, parseAesKey } from "./cdn/cdn-download.js";
export type { CdnDownloadOptions } from "./cdn/cdn-download.js";
export { uploadBufferToCdn } from "./cdn/cdn-upload.js";
export type { CdnUploadOptions } from "./cdn/cdn-upload.js";
export { buildCdnDownloadUrl, buildCdnUploadUrl } from "./cdn/cdn-url.js";

// Utilities
export { getMimeFromFilename, getExtensionFromMime, getExtensionFromContentTypeOrUrl } from "./util/mime.js";
export { generateId, tempFileName } from "./util/random.js";
