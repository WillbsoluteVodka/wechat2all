# WeChat iLink Bot API Endpoints

This document lists all API endpoints available in the wechat2all library.

---

## Message & Updates

### getUpdates

**Endpoint:** `ilink/bot/getupdates` (POST)

**English Description:**  
Long-poll for new messages from WeChat users. Returns an empty response on client-side timeout (normal for long-poll).

**中文描述：**  
长轮询获取来自微信用户的新消息。客户端超时时返回空响应（长轮询的正常行为）。

**Parameters:**
- `get_updates_buf: string` - Poll cursor for message synchronization
- `base_info?: BaseInfo` - Metadata (channel version, etc.)

**Response:**
- `ret: number` - Return code
- `msgs: Message[]` - Array of new messages
- `get_updates_buf: string` - Updated poll cursor for next request

---

### sendMessage

**Endpoint:** `ilink/bot/sendmessage` (POST)

**English Description:**  
Send a message downstream to a WeChat user. Supports text, image, video, file, and voice messages.

**中文描述：**  
向微信用户发送消息。支持文本、图片、视频、文件和语音消息。

**Parameters:**
- `ilink_user_id: string` - Target user ID
- `context_token?: string` - Context token for message correlation
- `msg_items: MessageItem[]` - Message content (text/image/video/etc.)
- `base_info?: BaseInfo` - Metadata

**Response:** Empty on success

---

## Media & CDN

### getUploadUrl

**Endpoint:** `ilink/bot/getuploadurl` (POST)

**English Description:**  
Get a pre-signed CDN upload URL for uploading media files (images, videos, files, voice).

**中文描述：**  
获取预签名的 CDN 上传 URL，用于上传媒体文件（图片、视频、文件、语音）。

**Parameters:**
- `ilink_user_id: string` - User ID for upload context
- `msg_type: number` - Media type (1=image, 2=video, 3=file, 4=voice)
- `file_md5: string` - MD5 hash of file
- `file_size: number` - File size in bytes
- `file_name?: string` - Original filename
- `base_info?: BaseInfo` - Metadata

**Response:**
- `ret: number` - Return code
- `upload_full_url?: string` - Full upload URL (newer format)
- `upload_param?: string` - Upload parameters (legacy format)
- `thumb_upload_full_url?: string` - Thumbnail upload URL
- `thumb_upload_param?: string` - Thumbnail upload parameters (legacy)

---

## Configuration & Status

### getConfig

**Endpoint:** `ilink/bot/getconfig` (POST)

**English Description:**  
Fetch bot configuration for a specific user, including typing ticket and session info.

**中文描述：**  
获取特定用户的机器人配置，包括输入状态票据和会话信息。

**Parameters:**
- `ilink_user_id: string` - User ID
- `context_token?: string` - Context token for session correlation
- `base_info?: BaseInfo` - Metadata

**Response:**
- `ret: number` - Return code
- `typing_ticket?: string` - Ticket for typing indicator
- Other configuration fields

---

### sendTyping

**Endpoint:** `ilink/bot/sendtyping` (POST)

**English Description:**  
Send or cancel a typing indicator to show that the bot is composing a response.

**中文描述：**  
发送或取消输入状态指示器，向用户显示机器人正在编写响应。

**Parameters:**
- `ilink_user_id: string` - Target user ID
- `context_token?: string` - Context token
- `typing_status: number` - Status (1=typing, 2=cancel)
- `typing_ticket?: string` - Ticket from getConfig
- `base_info?: BaseInfo` - Metadata

**Response:** Empty on success

---

## QR Code Login

### getQRCode

**Endpoint:** `ilink/bot/get_bot_qrcode` (GET)

**English Description:**  
Generate a new QR code for bot login. Used to authenticate without pre-existing credentials.

**中文描述：**  
生成新的二维码用于机器人登录。用于在没有预先存在凭证时进行身份验证。

**Parameters:**
- `bot_type?: string` - Bot type identifier (default: "3")

**Response:**
- `ret: number` - Return code
- `qrcode: string` - QR code string for scanning
- `uuid?: string` - Unique identifier for this QR session
- `expire_time?: number` - Expiration timestamp

---

### pollQRCodeStatus

**Endpoint:** `ilink/bot/get_qrcode_status` (GET)

**English Description:**  
Long-poll the QR code scan status. Check if user has scanned and approved the login.

**中文描述：**  
长轮询二维码扫描状态。检查用户是否已扫描并批准登录。

**Parameters:**
- `qrcode: string` - QR code string from getQRCode

**Response:**
- `status: string` - Status ("wait" | "confirmed" | "expired")
- `token?: string` - Authentication token (on confirmed status)
- `expires_in?: number` - Token expiration time in seconds

---

## Base Info Structure

**English Description:**  
Common metadata sent with all API requests.

**中文描述：**  
与所有 API 请求一起发送的通用元数据。

```typescript
interface BaseInfo {
  channel_version?: string;  // Client version string
}
```

---

## Timeout Defaults

- **Long-poll endpoints** (`getUpdates`, `pollQRCodeStatus`): 35 seconds
- **Regular API endpoints** (`sendMessage`, `getUploadUrl`): 15 seconds
- **Lightweight endpoints** (`getConfig`, `sendTyping`): 10 seconds

---

## Authentication Headers

All POST requests include:
- `Authorization: Bearer {token}` (after QR login)
- `AuthorizationType: ilink_bot_token`
- `X-WECHAT-UIN: {random-base64-uint32}` - Random per-request identifier
- `SKRouteTag: {routeTag}` - Optional routing hint

---

## Base URL

Default: `https://ilinkai.weixin.qq.com`

CDN URL: `https://novac2c.cdn.weixin.qq.com/c2c`
