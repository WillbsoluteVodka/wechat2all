#!/usr/bin/env npx tsx
/**
 * Echo Bot — a complete example using wechat2all.
 *
 * Demonstrates:
 *   - File-based credential persistence (the library itself is stateless)
 *   - QR code rendering via qrcode-terminal (the library only returns URLs)
 *   - Sync buf persistence for message resume across restarts
 *   - Echoing back every message type: text, image, video, file, voice
 *
 * Prerequisites:
 *   pnpm add qrcode-terminal               # for inline QR code rendering
 *
 * Usage:
 *   pnpm tsx examples/echo-bot.ts           # first run — shows QR code
 *   pnpm tsx examples/echo-bot.ts           # subsequent runs — resumes session
 *   pnpm tsx examples/echo-bot.ts --fresh   # force new QR login
 *   pnpm tsx examples/echo-bot.ts --profile sales  # isolated session/profile
 *
 * Press Ctrl+C to stop.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WeChatClient,
  normalizeAccountId,
  MessageType,
  MessageItemType,
  type WeixinMessage,
  type MessageItem,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Simple file-based persistence (example only — use your own storage)
// ---------------------------------------------------------------------------

const BASE_STATE_DIR = path.join(os.homedir(), ".wechat-echo-bot");

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function sanitizeProfileName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

const PROFILE_NAME = sanitizeProfileName(
  argValue("--profile") ?? process.env.WECHAT_ECHO_PROFILE ?? "default",
);
const STATE_DIR =
  PROFILE_NAME === "default"
    ? BASE_STATE_DIR
    : path.join(BASE_STATE_DIR, "profiles", PROFILE_NAME);
const TEMP_DIR = path.join(STATE_DIR, "tmp");

interface SavedCredentials {
  accountId: string;
  token: string;
  baseUrl?: string;
  userId?: string;
  /** Epoch ms when this QR session was obtained. Used by the example only. */
  loginAt?: number;
}

function envMinutes(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const RECONNECT_CONFIG = {
  sessionDurationMs: envMinutes("WECHAT_SESSION_MINUTES", 24 * 60) * 60 * 1000,
  warningBeforeMs: envMinutes("WECHAT_RECONNECT_WARN_MINUTES", 2 * 60) * 60 * 1000,
  reminderIntervalMs: envMinutes("WECHAT_RECONNECT_REMIND_MINUTES", 30) * 60 * 1000,
  forceBeforeMs: envMinutes("WECHAT_RECONNECT_FORCE_MINUTES", 30) * 60 * 1000,
  qrcodeScanTimeoutMs: envMinutes("WECHAT_RECONNECT_QR_TIMEOUT_MINUTES", 10) * 60 * 1000,
};

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function credentialsPath(): string {
  return path.join(STATE_DIR, "credentials.json");
}

function syncBufPath(): string {
  return path.join(STATE_DIR, "sync-buf.json");
}

function loadCredentials(): SavedCredentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath(), "utf-8");
    return JSON.parse(raw) as SavedCredentials;
  } catch {
    return null;
  }
}

function saveCredentials(creds: SavedCredentials): void {
  ensureDir(STATE_DIR);
  const filePath = credentialsPath();
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2), "utf-8");
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

function loadSyncBuf(): string | undefined {
  try {
    const raw = fs.readFileSync(syncBufPath(), "utf-8");
    const data = JSON.parse(raw) as { buf?: string };
    return data.buf;
  } catch {
    return undefined;
  }
}

function saveSyncBuf(buf: string): void {
  ensureDir(STATE_DIR);
  fs.writeFileSync(syncBufPath(), JSON.stringify({ buf }), "utf-8");
}

function lockPath(): string {
  return path.join(STATE_DIR, "profile.lock");
}

function acquireProfileLock(): () => void {
  ensureDir(STATE_DIR);
  const filePath = lockPath();
  let fd: number;
  try {
    fd = fs.openSync(filePath, "wx");
  } catch {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
        pid?: number;
      };
      if (
        typeof existing.pid === "number" &&
        !Number.isNaN(existing.pid)
      ) {
        try {
          process.kill(existing.pid, 0);
        } catch {
          fs.unlinkSync(filePath);
          fd = fs.openSync(filePath, "wx");
          fs.writeFileSync(
            fd,
            JSON.stringify({ pid: process.pid, profile: PROFILE_NAME, startedAt: new Date().toISOString() }, null, 2),
            "utf-8",
          );
          fs.closeSync(fd);
          return () => {
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }
          };
        }
      }
    } catch {
      // Fall through to the clearer lock error below.
    }
    throw new Error(
      `Profile "${PROFILE_NAME}" appears to be running already (${filePath}). ` +
        "Use a different --profile for another bot session, or remove the lock if the previous process crashed.",
    );
  }

  fs.writeFileSync(
    fd,
    JSON.stringify({ pid: process.pid, profile: PROFILE_NAME, startedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  fs.closeSync(fd);

  return () => {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

const MEDIA_EXTENSIONS: Record<string, string> = {
  image: ".jpg",
  video: ".mp4",
  voice: ".silk",
  file: ".bin",
};

/**
 * Write a buffer to a temp file and return its path.
 * The caller can pass a preferred filename (for file attachments).
 */
function writeTempFile(data: Buffer, kind: string, fileName?: string): string {
  ensureDir(TEMP_DIR);
  const ext = fileName
    ? path.extname(fileName) || MEDIA_EXTENSIONS[kind] || ".bin"
    : MEDIA_EXTENSIONS[kind] || ".bin";
  const name = fileName ?? `echo-${kind}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(TEMP_DIR, name);
  fs.writeFileSync(filePath, data);
  return filePath;
}

function cleanupTempFile(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// QR code rendering (example — uses qrcode-terminal if available)
// ---------------------------------------------------------------------------

async function renderQRCode(url: string): Promise<void> {
  try {
    const qrt = await import("qrcode-terminal");
    qrt.default.generate(url, { small: true });
  } catch {
    console.log(`QR Code URL: ${url}`);
    console.log("(install qrcode-terminal for inline QR rendering)");
  }
}

// ---------------------------------------------------------------------------
// Session renewal helper (example only)
// ---------------------------------------------------------------------------

interface SessionRenewalState {
  loginAt: number;
  lastContact?: string;
  warningTimer?: NodeJS.Timeout;
  forceTimer?: NodeJS.Timeout;
  reminderTimer?: NodeJS.Timeout;
  reconnecting: boolean;
  awaitingDecision: boolean;
}

function clearTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer) clearTimeout(timer);
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

async function sendRenewalNotice(
  client: WeChatClient,
  state: SessionRenewalState,
  text: string,
): Promise<void> {
  if (!state.lastContact) {
    log(`No recent contact to notify: ${text}`);
    return;
  }
  try {
    await client.sendText(state.lastContact, text);
  } catch (err) {
    log(`Could not notify ${state.lastContact}: ${err}`);
  }
}

async function renewSession(
  client: WeChatClient,
  state: SessionRenewalState,
  reason: string,
): Promise<void> {
  if (state.reconnecting) return;

  state.reconnecting = true;
  state.awaitingDecision = false;
  clearTimer(state.reminderTimer);
  state.reminderTimer = undefined;

  log(`Starting QR session renewal (${reason}).`);
  await sendRenewalNotice(
    client,
    state,
    "微信 iLink 登录即将到期，正在生成新的登录二维码。请查看机器人终端输出并扫码确认。",
  );

  const result = await client.login({
    timeoutMs: RECONNECT_CONFIG.qrcodeScanTimeoutMs,
    onQRCode: async (url) => {
      log("Scan the renewal QR code with WeChat:\n");
      await renderQRCode(url);
      if (state.lastContact) {
        try {
          await client.sendText(
            state.lastContact,
            `新的登录二维码链接：${url}\n请在 10 分钟内扫码确认。`,
          );
        } catch (err) {
          log(`Could not send renewal QR link to ${state.lastContact}: ${err}`);
        }
      }
    },
    onStatus(status) {
      switch (status) {
        case "scaned":
          log("Renewal QR scanned! Confirm on your phone...");
          break;
        case "expired":
          log("Renewal QR expired, refreshing...");
          break;
        case "confirmed":
          log("Renewal login confirmed!");
          break;
      }
    },
  });

  state.reconnecting = false;

  if (!result.connected || !result.botToken || !result.accountId) {
    log(`Session renewal failed: ${result.message}`);
    await sendRenewalNotice(
      client,
      state,
      `自动重连失败：${result.message}。可以回复 /reconnect 重新尝试。`,
    );
    scheduleSessionRenewal(client, state, state.loginAt);
    return;
  }

  state.loginAt = Date.now();
  saveCredentials({
    accountId: normalizeAccountId(result.accountId),
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
    loginAt: state.loginAt,
  });

  log(`Session renewed for account: ${result.accountId}`);
  await sendRenewalNotice(client, state, "自动重连成功，新的登录状态已保存。");
  scheduleSessionRenewal(client, state, state.loginAt);
}

async function sendRenewalPrompt(
  client: WeChatClient,
  state: SessionRenewalState,
): Promise<void> {
  const expiresAt = state.loginAt + RECONNECT_CONFIG.sessionDurationMs;
  const remaining = expiresAt - Date.now();
  state.awaitingDecision = true;

  await sendRenewalNotice(
    client,
    state,
    `微信 iLink 登录将在约 ${formatDuration(remaining)} 后到期。\n回复 Y 立即扫码重连，回复 N 稍后提醒；剩余 30 分钟时会自动进入重连流程。`,
  );
}

function scheduleReminder(
  client: WeChatClient,
  state: SessionRenewalState,
): void {
  clearTimer(state.reminderTimer);
  state.reminderTimer = setTimeout(() => {
    void sendRenewalPrompt(client, state);
    scheduleReminder(client, state);
  }, RECONNECT_CONFIG.reminderIntervalMs);
}

function scheduleSessionRenewal(
  client: WeChatClient,
  state: SessionRenewalState,
  loginAt: number,
): void {
  clearTimer(state.warningTimer);
  clearTimer(state.forceTimer);
  clearTimer(state.reminderTimer);

  state.loginAt = loginAt;
  state.awaitingDecision = false;
  state.reminderTimer = undefined;

  const expiresAt = loginAt + RECONNECT_CONFIG.sessionDurationMs;
  const warningAt = expiresAt - RECONNECT_CONFIG.warningBeforeMs;
  const forceAt = expiresAt - RECONNECT_CONFIG.forceBeforeMs;
  const warningDelay = warningAt - Date.now();
  const forceDelay = forceAt - Date.now();

  if (forceDelay <= 0) {
    void renewSession(client, state, "session expires in 30 minutes");
  } else if (warningDelay <= 0) {
    void sendRenewalPrompt(client, state);
  } else {
    state.warningTimer = setTimeout(() => {
      void sendRenewalPrompt(client, state);
    }, warningDelay);
  }

  if (forceDelay > 0) {
    state.forceTimer = setTimeout(() => {
      void renewSession(client, state, "session expires in 30 minutes");
    }, forceDelay);
  }

  log(
    `Session renewal scheduled: warn in ${formatDuration(Math.max(0, warningDelay))}, force in ${formatDuration(Math.max(0, forceDelay))}.`,
  );
}

async function handleRenewalCommand(
  client: WeChatClient,
  state: SessionRenewalState,
  text: string,
): Promise<boolean> {
  const command = text.trim().toLowerCase();

  if (command === "/reconnect" || command === "/重新连接") {
    await renewSession(client, state, "manual command");
    return true;
  }

  if (!state.awaitingDecision) return false;

  if (command === "y" || command === "yes" || command === "是") {
    await renewSession(client, state, "user accepted renewal");
    return true;
  }

  if (command === "n" || command === "no" || command === "否") {
    state.awaitingDecision = false;
    scheduleReminder(client, state);
    await sendRenewalNotice(
      client,
      state,
      "好的，30 分钟后会再次提醒；剩余 30 分钟时会自动进入重连流程。",
    );
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`);
}

function describeItems(items: MessageItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case MessageItemType.TEXT:
        parts.push(`text: "${item.text_item?.text ?? ""}"`);
        break;
      case MessageItemType.IMAGE:
        parts.push(`image (mid_size=${item.image_item?.mid_size ?? "?"})`);
        break;
      case MessageItemType.VOICE:
        parts.push(
          `voice (${item.voice_item?.playtime ?? "?"}ms)` +
            (item.voice_item?.text ? ` [STT: "${item.voice_item.text}"]` : ""),
        );
        break;
      case MessageItemType.FILE:
        parts.push(`file: "${item.file_item?.file_name ?? "?"}" (${item.file_item?.len ?? "?"} bytes)`);
        break;
      case MessageItemType.VIDEO:
        parts.push(`video (${item.video_item?.play_length ?? "?"}s)`);
        break;
      default:
        parts.push(`unknown type=${item.type}`);
    }
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Media echo: download -> save to temp -> re-upload and send back
// ---------------------------------------------------------------------------

/**
 * Download a media item from an inbound message, then re-upload and send
 * it back to the sender. Returns true if a media item was echoed.
 */
async function echoMediaItem(
  client: WeChatClient,
  from: string,
  item: MessageItem,
  caption?: string,
): Promise<boolean> {
  const downloaded = await client.downloadMedia(item);
  if (!downloaded) return false;

  const tempPath = writeTempFile(downloaded.data, downloaded.kind, downloaded.fileName);
  try {
    if (downloaded.kind === "voice") {
      if (caption) {
        await client.sendText(from, caption);
      }
      await client.sendVoice(from, tempPath, {
        playtimeMs: item.voice_item?.playtime,
        encodeType: item.voice_item?.encode_type,
        sampleRate: item.voice_item?.sample_rate,
        bitsPerSample: item.voice_item?.bits_per_sample,
      });
    } else {
      await client.sendMedia(from, tempPath, caption);
    }
    log(`--> [${from}] echoed ${downloaded.kind} (${downloaded.data.length} bytes)${caption ? ` + "${caption}"` : ""}`);
  } finally {
    cleanupTempFile(tempPath);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const forceFresh = process.argv.includes("--fresh");
  const releaseProfileLock = acquireProfileLock();
  process.once("exit", releaseProfileLock);
  log(`Using profile "${PROFILE_NAME}" at ${STATE_DIR}`);

  // --- Step 1: Try resuming from saved credentials -------------------------

  let client: WeChatClient | null = null;
  let loginAt = Date.now();

  if (!forceFresh) {
    const creds = loadCredentials();
    if (creds) {
      client = new WeChatClient({
        accountId: creds.accountId,
        token: creds.token,
        baseUrl: creds.baseUrl,
      });
      loginAt = creds.loginAt ?? Date.now();
      log(`Resumed session for account: ${creds.accountId}`);
    }
  }

  // --- Step 2: If no session, run QR login ---------------------------------

  if (!client) {
    log("No saved session. Starting QR code login...");
    log("Scan the QR code with WeChat:\n");

    client = new WeChatClient();

    const result = await client.login({
      timeoutMs: 5 * 60_000,
      onQRCode: renderQRCode,
      onStatus(status) {
        switch (status) {
          case "scaned":
            log("QR scanned! Confirm on your phone...");
            break;
          case "expired":
            log("QR expired, refreshing...");
            break;
          case "confirmed":
            log("Login confirmed!");
            break;
        }
      },
    });

    if (!result.connected) {
      console.error(`Login failed: ${result.message}`);
      process.exit(1);
    }

    log(`Logged in as ${result.accountId}`);
    loginAt = Date.now();

    saveCredentials({
      accountId: normalizeAccountId(result.accountId!),
      token: result.botToken!,
      baseUrl: result.baseUrl,
      userId: result.userId,
      loginAt,
    });
    log(`Credentials saved to ${credentialsPath()}`);
  }

  const renewalState: SessionRenewalState = {
    loginAt,
    reconnecting: false,
    awaitingDecision: false,
  };
  scheduleSessionRenewal(client, renewalState, loginAt);

  // --- Step 3: Set up message handler (echo) -------------------------------

  client.on("message", async (msg: WeixinMessage) => {
    const from = msg.from_user_id ?? "(unknown)";
    const items = msg.item_list ?? [];

    if (msg.message_type !== MessageType.USER) return;
    if (msg.from_user_id) renewalState.lastContact = msg.from_user_id;

    log(`<-- [${from}] ${describeItems(items)}`);

    const text = WeChatClient.extractText(msg);
    const mediaItems = items.filter((i) => WeChatClient.isMediaItem(i));

    try {
      if (text && await handleRenewalCommand(client!, renewalState, text)) {
        return;
      }

      if (mediaItems.length > 0) {
        // Echo each media item back, with text as caption on the first one
        let echoedAny = false;
        for (let i = 0; i < mediaItems.length; i++) {
          const caption = i === 0 && text ? `Echo: ${text}` : undefined;
          const echoed = await echoMediaItem(client!, from, mediaItems[i], caption);
          echoedAny = echoedAny || echoed;
          if (!echoed) {
            // Download/upload failed for this item — fall back to text description
            log(`    [${from}] could not echo media item type=${mediaItems[i].type}, skipping`);
          }
        }
        // If there was text but no media was successfully echoed, send text reply
        if (text && !echoedAny) {
          await client!.sendText(from, `Echo: ${text}`);
        }
      } else if (text) {
        // Pure text message — echo it back
        const reply = `Echo: ${text}`;
        await client!.sendText(from, reply);
        log(`--> [${from}] ${reply}`);
      } else {
        // Empty message
        await client!.sendText(from, "Received an empty message.");
        log(`--> [${from}] (empty message ack)`);
      }
    } catch (err) {
      log(`Error replying to ${from}: ${err}`);
    }
  });

  client.on("error", (err: Error) => {
    log(`Poll error: ${err.message}`);
  });

  client.on("sessionExpired", () => {
    log("Session expired! Bot will pause and retry automatically.");
    log("If this persists, re-run with --fresh to re-login.");
  });

  // --- Step 4: Start the long-poll loop ------------------------------------

  log("Echo bot is running. Press Ctrl+C to stop.\n");

  const shutdown = () => {
    log("\nStopping...");
    clearTimer(renewalState.warningTimer);
    clearTimer(renewalState.forceTimer);
    clearTimer(renewalState.reminderTimer);
    client!.stop();
    releaseProfileLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await client.start({
      loadSyncBuf,
      saveSyncBuf,
    });
  } finally {
    releaseProfileLock();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
