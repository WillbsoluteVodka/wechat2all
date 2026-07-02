#!/usr/bin/env npx tsx
/**
 * Runtime Bot — scan-login demo for @wechat2all/runtime.
 *
 * Demonstrates:
 *   - One physical WeChat scan/profile with multiple logical routes
 *   - File-based credential and sync-buf persistence for that profile
 *   - QR login through the underlying WeChatClient
 *   - RuntimeMessage logging for real WeChat messages
 *   - A default "大助手" route for chat and route navigation
 *   - Dynamic route-specific assistants persisted per profile
 *   - RuntimeAction execution back to WeChat
 *
 * Usage:
 *   pnpm runtime-bot
 *   pnpm runtime-bot -- --profile main --fresh
 *
 * Try these in the single WeChat chat:
 *   hello
 *   /help
 *   /ls
 *   /rename 我的总控台
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeAccountId } from "wechat2all";

import {
  WeChatRuntime,
  FileRuntimeStateStore,
  RuntimeMediaPipeline,
  createAgentMemoryProviderFromEnv,
  createDummyTTSProvider,
  createLLMProviderFromEnv,
  createMainAssistantConnector,
  createRouteAssistantConnector,
  createStateStoreMessageDeduper,
  type RuntimeMessage,
  type RuntimeProfileConfig,
  type RuntimeRoute,
} from "../src/index.js";

const BASE_STATE_DIR = path.join(os.homedir(), ".wechat2all-runtime-bot");

function log(message: string): void {
  console.log(`[runtime-bot] ${message}`);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function sanitizeProfileName(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return value || "default";
}

const PROFILE_ID = sanitizeProfileName(
  argValue("--profile") ?? process.env.WECHAT_RUNTIME_PROFILE ?? "default",
);
const FORCE_FRESH = process.argv.includes("--fresh");
const STATE_DIR =
  PROFILE_ID === "default"
    ? BASE_STATE_DIR
    : path.join(BASE_STATE_DIR, "profiles", PROFILE_ID);
const stateStore = new FileRuntimeStateStore({ baseDir: BASE_STATE_DIR });

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadEnvFile(filePath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = stripEnvQuotes(trimmed.slice(index + 1).trim());
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

function loadLocalEnv(): void {
  const candidates = [
    path.join(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "../..", ".env.local"),
    path.join(STATE_DIR, ".env.local"),
  ];
  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    if (loadEnvFile(candidate)) {
      log(`Loaded local env from ${candidate}`);
    }
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function credentialsPath(): string {
  return stateStore.credentialsPath(PROFILE_ID);
}

function memoryPath(): string {
  return stateStore.memoryDir(PROFILE_ID);
}

function lockPath(): string {
  return path.join(STATE_DIR, "profile.lock");
}

function isUserManagedRoute(route: RuntimeRoute): boolean {
  return route.metadata?.createdBy === "main-assistant";
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
      if (typeof existing.pid === "number" && !Number.isNaN(existing.pid)) {
        try {
          process.kill(existing.pid, 0);
        } catch {
          fs.unlinkSync(filePath);
          return acquireProfileLock();
        }
      }
    } catch {
      // Fall through to the clearer lock error below.
    }

    throw new Error(
      `Profile "${PROFILE_ID}" appears to be running already (${filePath}). ` +
        "Use another --profile only for another WeChat account, or remove the lock if the previous process crashed.",
    );
  }

  fs.writeFileSync(
    fd,
    JSON.stringify(
      { pid: process.pid, profile: PROFILE_ID, startedAt: new Date().toISOString() },
      null,
      2,
    ),
    "utf-8",
  );
  fs.closeSync(fd);

  return () => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore double-release.
    }
  };
}

async function renderQRCode(url: string): Promise<void> {
  try {
    const qrt = await import("qrcode-terminal");
    qrt.default.generate(url, { small: true });
  } catch {
    log(`QR Code URL: ${url}`);
    log("Install qrcode-terminal for inline terminal QR rendering.");
  }
}

function oneLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function envNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function describeMessage(message: RuntimeMessage): Record<string, unknown> {
  return {
    id: message.id,
    profileId: message.profileId,
    conversationId: message.conversationId,
    senderId: message.senderId,
    kind: message.kind,
    text: oneLine(message.text),
    attachments: message.attachments.map((attachment) => ({
      kind: attachment.kind,
      id: attachment.id,
      fileName: attachment.fileName,
      size: attachment.size,
      durationMs: attachment.durationMs,
      mimeType: attachment.mimeType,
    })),
    hasReplyToken: Boolean(message.replyToken),
  };
}

function createRuntime(
  profile: RuntimeProfileConfig,
  savedRoutes: RuntimeRoute[],
): WeChatRuntime {
  const llm = createLLMProviderFromEnv();
  const agentMemory = createAgentMemoryProviderFromEnv({
    baseDir: memoryPath(),
    onError(error, context) {
      log(
        `Memory error in ${context.operation}/${context.providerId}: ${error.message}`,
      );
    },
  });
  const mainAssistantConnectorId = "main-assistant";
  const routeAssistantConnectorId = "route-assistant";
  const llmTimeoutMs = envNumber("WECHAT2ALL_LLM_TIMEOUT_MS");
  const actionMaxAttempts = envNumber("WECHAT2ALL_ACTION_MAX_ATTEMPTS") ?? 2;
  const actionRetryDelayMs = envNumber("WECHAT2ALL_ACTION_RETRY_DELAY_MS") ?? 250;
  const actionDedupeWindowMs = envNumber("WECHAT2ALL_ACTION_DEDUPE_WINDOW_MS") ?? 0;
  log(`Using LLM provider: ${llm.id}`);
  log(`Using memory provider: ${agentMemory.id}`);

  return new WeChatRuntime({
    profiles: [profile],
    deduper: createStateStoreMessageDeduper(stateStore),
    media: new RuntimeMediaPipeline({
      cacheDir: stateStore.mediaDir(PROFILE_ID),
    }),
    tts: createDummyTTSProvider({
      outputDir: path.join(STATE_DIR, "tts"),
    }),
    actionExecutor: {
      continueOnError: true,
      maxAttempts: actionMaxAttempts,
      retryDelayMs: actionRetryDelayMs,
      dedupeWindowMs: actionDedupeWindowMs,
    },
    connectors: [
      createMainAssistantConnector({
        id: mainAssistantConnectorId,
        llm,
        agentMemory,
        routeAssistantConnectorId,
        llmTimeoutMs,
        onLLMError(error, context) {
          log(
            `LLM error in ${context.connectorId}/${context.route.id}: ${error.message}`,
          );
        },
        onRoutesChanged: (routes) =>
          stateStore.saveRoutes(PROFILE_ID, routes.filter(isUserManagedRoute)),
      }),
      createRouteAssistantConnector({
        id: routeAssistantConnectorId,
        llm,
        agentMemory,
        llmTimeoutMs,
        onLLMError(error, context) {
          log(
            `LLM error in ${context.connectorId}/${context.route.id}: ${error.message}`,
          );
        },
      }),
    ],
    routes: [
      ...savedRoutes,
      {
        id: "main-assistant-default",
        profileId: profile.id,
        connectorId: mainAssistantConnectorId,
        priority: -100,
        terminal: true,
      },
    ],
    monitor: {
      sessionExpiredBehavior: "stop",
    },
  });
}

async function ensureLoggedIn(runtime: WeChatRuntime): Promise<void> {
  const client = runtime.getClient(PROFILE_ID);
  if (!FORCE_FRESH && await stateStore.loadCredentials(PROFILE_ID)) {
    log(`Resuming saved session for profile "${PROFILE_ID}".`);
    return;
  }

  log("No saved session, or --fresh was requested. Starting QR login...");
  log("Scan the QR code with WeChat and confirm on your phone:\n");

  const result = await client.login({
    timeoutMs: 5 * 60_000,
    onQRCode: renderQRCode,
    onStatus(status) {
      switch (status) {
        case "scaned":
          log("QR scanned. Confirm on your phone...");
          break;
        case "expired":
          log("QR expired, refreshing...");
          break;
        case "confirmed":
          log("Login confirmed.");
          break;
      }
    },
  });

  if (!result.connected) {
    throw new Error(`Login failed: ${result.message}`);
  }

  const creds = client.getCredentials();
  if (!creds.accountId || !creds.token) {
    throw new Error("Login succeeded but credentials were incomplete.");
  }

  await stateStore.saveCredentials(PROFILE_ID, {
    accountId: normalizeAccountId(creds.accountId),
    token: creds.token,
    baseUrl: creds.baseUrl,
    userId: result.userId,
    loginAt: Date.now(),
  });
  log(`Logged in as ${creds.accountId}`);
  log(`Credentials saved to ${credentialsPath()}`);
}

async function main(): Promise<void> {
  const releaseProfileLock = acquireProfileLock();
  process.once("exit", releaseProfileLock);
  log(`Using profile "${PROFILE_ID}" at ${STATE_DIR}`);
  loadLocalEnv();

  const savedCredentials = FORCE_FRESH
    ? null
    : await stateStore.loadCredentials(PROFILE_ID);
  const savedRoutes = (await stateStore.loadRoutes(PROFILE_ID))
    .filter(isUserManagedRoute);
  if (savedRoutes.length > 0) {
    log(`Loaded ${savedRoutes.length} user-created route(s).`);
  }
  const runtime = createRuntime({
    id: PROFILE_ID,
    name: `Runtime Bot (${PROFILE_ID})`,
    credentials: savedCredentials
      ? {
          accountId: savedCredentials.accountId,
          token: savedCredentials.token,
          baseUrl: savedCredentials.baseUrl,
        }
      : undefined,
  }, savedRoutes);

  runtime.on("message", (message) => {
    log(`RuntimeMessage\n${JSON.stringify(describeMessage(message), null, 2)}`);
  });

  runtime.on("actions", (message, results) => {
    for (const result of results) {
      const status = result.ok ? "ok" : `failed: ${result.error?.message ?? "unknown error"}`;
      log(`Action for ${message.conversationId}: ${result.action.type} -> ${status}`);
    }
  });

  runtime.on("error", (error) => {
    log(`Runtime error: ${error.message}`);
  });

  runtime.on("profileStarted", (profile) => {
    log(`Profile started: ${profile.id}`);
  });

  runtime.on("profileStopped", (profile) => {
    log(`Profile stopped: ${profile.id}`);
  });

  await ensureLoggedIn(runtime);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log("Stopping...");
    runtime.stopProfile(PROFILE_ID);
    releaseProfileLock();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    log("Runtime bot is running. Press Ctrl+C to stop.\n");
    await runtime.startProfile(PROFILE_ID, {
      loadSyncBuf: () => stateStore.loadSyncBuf(PROFILE_ID),
      saveSyncBuf: (buf) => stateStore.saveSyncBuf(PROFILE_ID, buf),
    });
  } finally {
    releaseProfileLock();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
