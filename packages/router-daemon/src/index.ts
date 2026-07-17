import http from "node:http";
import os from "node:os";
import path from "node:path";

import { normalizeAccountId } from "wechat2all";
import { createClaudeRouteConnectorFromEnv } from "@wechat2all/claude-route";

import {
  FileRuntimeStateStore,
  RuntimeMediaPipeline,
  WeChatRuntime,
  createAgentMemoryProviderFromEnv,
  createCodexConnector,
  createDummyTTSProvider,
  createLLMProviderFromEnv,
  createMainAssistantConnector,
  createMainAssistantSessionReminderAction,
  createRouteAssistantConnector,
  createStateStoreMessageDeduper,
  parseCodexReplyMode,
  type CodexBridgeClient,
  type LLMProvider,
  type RuntimeActionResult,
  type RuntimeMessage,
  type RuntimeProfileConfig,
  type RuntimeSavedCredentials,
} from "@wechat2all/runtime";

import {
  codexBackend,
  createCodexBridgeFromEnv,
  getCodexSetupCheckSnapshot,
  refreshCodexSetupCheck,
  startCodexSetupCheckAfterStartup,
} from "./codex.js";
import {
  createDashboardSnapshot,
  type DashboardRouteStats,
} from "./dashboard.js";
import {
  envNumber,
  loadLocalEnv,
  readRouterAddress,
  resolveLocalEnvPath,
} from "./env.js";
import {
  LocalConfigStore,
  LocalConfigValidationError,
} from "./local-config.js";
import {
  LlmHealthService,
  type LlmHealthSnapshot,
} from "./llm-health.js";
import {
  applySavedRouteOverrides,
  defaultRoutes,
  isPersistableRoute,
  isUserManagedRoute,
} from "./routes.js";
import {
  SessionReminderService,
  type SessionReminderEvent,
} from "./session-reminders.js";
import { createTraceLogger } from "./trace.js";
import { checkUpochiHealth, createUpochiConnector } from "./upochi.js";
import {
  UpochiConfigStore,
  UpochiConfigValidationError,
  UpochiProjectNotFoundError,
} from "./upochi-config.js";

let routerAddress = readRouterAddress();
let HOST = routerAddress.host;
let PORT = routerAddress.port;
let PROFILE_ID = process.env.WECHAT_RUNTIME_PROFILE ?? "default";
const BASE_STATE_DIR = path.join(os.homedir(), ".wechat2all-runtime-bot");
const stateStore = new FileRuntimeStateStore({ baseDir: BASE_STATE_DIR });
let codexBridge: CodexBridgeClient | undefined;
let server: http.Server | undefined;
let localConfig: LocalConfigStore | undefined;
let upochiConfig: UpochiConfigStore | undefined;
let llmHealth: LlmHealthService | undefined;
let sessionReminders: SessionReminderService | undefined;

function finiteMetadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}

function actionPerformanceSuffix(result: RuntimeActionResult): string {
  const performance = result.action.metadata?.performance;
  const timings = performance && typeof performance === "object"
    ? performance as Record<string, unknown>
    : {};
  const values = [
    ["download", finiteMetadataNumber(timings.attachmentDownloadMs)],
    ["wait", finiteMetadataNumber(timings.attachmentWaitMs)],
    ["codex", finiteMetadataNumber(timings.codexTurnMs)],
    ["wechat", finiteMetadataNumber(result.durationMs)],
  ] as const;
  const parts = values.flatMap(([label, durationMs]) =>
    durationMs === undefined ? [] : [`${label}=${durationMs}ms`]
  );
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function refreshRouterAddress(): void {
  routerAddress = readRouterAddress();
  HOST = routerAddress.host;
  PORT = routerAddress.port;
}

function refreshRuntimeSettings(): void {
  refreshRouterAddress();
  PROFILE_ID = process.env.WECHAT_RUNTIME_PROFILE ?? "default";
}

function getCodexBridge(): CodexBridgeClient {
  codexBridge ??= createCodexBridgeFromEnv();
  return codexBridge;
}

function envMinutesMs(name: string, fallbackMinutes: number): number {
  return (envNumber(name) ?? fallbackMinutes) * 60_000;
}

function createRuntimeLLMProvider(): LLMProvider {
  try {
    return createLLMProviderFromEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace("warn", "llm", `LLM provider is not configured: ${message}`);
    return {
      id: "unavailable",
      async generate() {
        throw new Error(message);
      },
    };
  }
}

interface LoginState {
  active: boolean;
  status: "idle" | "wait" | "scaned" | "confirmed" | "expired" | "failed";
  qrPayload?: string;
  qrcode?: string;
  error?: string;
  startedAt?: number;
  connectedAt?: number;
}

let runtime: WeChatRuntime | undefined;
let runtimeStarting = false;
let loginState: LoginState = { active: false, status: "idle" };
let loginAbortController: AbortController | undefined;
let loginRunId = 0;
const traceLogger = createTraceLogger();
const trace = traceLogger.trace;
const routeStats = new Map<string, DashboardRouteStats>();

function localDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function recordRouteHit(routeId: string): void {
  const now = new Date();
  const dayKey = localDayKey(now);
  const previous = routeStats.get(routeId);
  routeStats.set(routeId, {
    dayKey,
    messagesToday: previous?.dayKey === dayKey ? previous.messagesToday + 1 : 1,
    lastHitAt: now.toISOString(),
  });
}

async function buildRuntime(profile: RuntimeProfileConfig): Promise<WeChatRuntime> {
  const savedRoutes = await stateStore.loadRoutes(PROFILE_ID);
  const savedUserRoutes = savedRoutes.filter(isUserManagedRoute);
  const builtInRoutes = defaultRoutes(profile.id)
    .map((route) => applySavedRouteOverrides(route, savedRoutes));
  const mainRoute = builtInRoutes.find((route) => route.id === "main-assistant-default");
  if (!mainRoute) throw new Error("Built-in main assistant route is missing.");
  const secondaryBuiltInRoutes = builtInRoutes.filter((route) => route !== mainRoute);
  const llm = createRuntimeLLMProvider();
  const agentMemory = createAgentMemoryProviderFromEnv({
    baseDir: stateStore.memoryDir(PROFILE_ID),
    onError(error, context) {
      trace("warn", "memory", `${context.operation}/${context.providerId}: ${error.message}`);
    },
  });
  const llmTimeoutMs = envNumber("WECHAT2ALL_LLM_TIMEOUT_MS");

  const next = new WeChatRuntime({
    profiles: [profile],
    deduper: createStateStoreMessageDeduper(stateStore),
    media: new RuntimeMediaPipeline({
      cacheDir: stateStore.mediaDir(PROFILE_ID),
      download: {
        timeoutMs: envNumber("WECHAT2ALL_MEDIA_DOWNLOAD_TIMEOUT_MS"),
        maxRetries: envNumber("WECHAT2ALL_MEDIA_DOWNLOAD_MAX_RETRIES"),
        retryDelayMs: envNumber("WECHAT2ALL_MEDIA_DOWNLOAD_RETRY_DELAY_MS"),
      },
      downloadConcurrency: envNumber("WECHAT2ALL_MEDIA_DOWNLOAD_CONCURRENCY"),
      cacheTtlMs: envNumber("WECHAT2ALL_MEDIA_CACHE_TTL_MS"),
      maxCacheBytes: envNumber("WECHAT2ALL_MEDIA_CACHE_MAX_BYTES"),
      pruneIntervalMs: envNumber("WECHAT2ALL_MEDIA_CACHE_PRUNE_INTERVAL_MS"),
    }),
    tts: createDummyTTSProvider({
      outputDir: path.join(stateStore.profileDir(PROFILE_ID), "tts"),
    }),
    actionExecutor: {
      continueOnError: true,
      maxAttempts: envNumber("WECHAT2ALL_ACTION_MAX_ATTEMPTS") ?? 2,
      retryDelayMs: envNumber("WECHAT2ALL_ACTION_RETRY_DELAY_MS") ?? 250,
      dedupeWindowMs: envNumber("WECHAT2ALL_ACTION_DEDUPE_WINDOW_MS") ?? 0,
    },
    connectors: [
      createCodexConnector({
        id: "codex-bridge",
        client: getCodexBridge(),
        replyMode: parseCodexReplyMode(process.env.WECHAT2ALL_CODEX_REPLY_MODE),
        processingReminderMs: envNumber("WECHAT2ALL_CODEX_PROCESSING_REMINDER_MS"),
      }),
      createClaudeRouteConnectorFromEnv({
        stateDir: path.join(stateStore.profileDir(PROFILE_ID), "claude-route"),
        onError(error, context) {
          trace(
            "error",
            "claude",
            `${context.operation}/${context.message.conversationId}: ${error.message}`,
          );
        },
      }),
      createUpochiConnector(),
      createMainAssistantConnector({
        id: "main-assistant",
        llm,
        agentMemory,
        routeAssistantConnectorId: "route-assistant",
        llmTimeoutMs,
        onRoutesChanged: (routes) =>
          stateStore.saveRoutes(PROFILE_ID, routes.filter(isPersistableRoute)),
        onLLMError(error, context) {
          trace("error", "llm", `${context.connectorId}/${context.route.id}: ${error.message}`);
        },
      }),
      createRouteAssistantConnector({
        id: "route-assistant",
        llm,
        agentMemory,
        llmTimeoutMs,
        onLLMError(error, context) {
          trace("error", "llm", `${context.connectorId}/${context.route.id}: ${error.message}`);
        },
      }),
    ],
    routes: [
      ...secondaryBuiltInRoutes,
      ...savedUserRoutes,
      mainRoute,
    ],
    monitor: {
      sessionExpiredBehavior: "stop",
    },
  });

  next.on("message", (message: RuntimeMessage) => {
    trace("info", "message", `${message.kind}: ${message.text ?? "(media)"}`);
    void sessionReminders?.captureMessage(message).catch((error: unknown) => {
      trace(
        "warn",
        "session",
        `Could not persist reminder target: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });
  next.on("messageSkipped", (_message, reason) => {
    trace("debug", "message", `Skipped inbound message: ${reason}`);
  });
  next.on("routeMatched", (_message, route) => {
    recordRouteHit(route.id);
  });
  next.on("actions", (message, results: RuntimeActionResult[]) => {
    for (const result of results) {
      const suffix = result.ok ? "ok" : `failed: ${result.error?.message ?? "unknown"}`;
      trace(
        "info",
        "action",
        `${message.conversationId}: ${result.action.type} -> ${suffix}${actionPerformanceSuffix(result)}`,
      );
    }
  });
  next.on("error", (error) => {
    trace("error", "runtime", error.message);
  });
  next.on("profileStarted", (profileState) => {
    trace("info", "profile", `Started ${profileState.id}`);
  });
  next.on("profileStopped", (profileState) => {
    trace("warn", "profile", `Stopped ${profileState.id}`);
  });
  next.getClient(profile.id).on("sessionExpired", () => {
    sessionReminders?.stopSession();
    trace("warn", "session", "Session expired; hourly reminders stopped.");
  });

  return next;
}

async function deliverSessionReminder(event: SessionReminderEvent): Promise<void> {
  const current = await ensureRuntime();
  const [result] = await current.dispatchActions(PROFILE_ID, [
    createMainAssistantSessionReminderAction({
      conversationId: event.target.userId,
      contextToken: event.target.contextToken,
      remainingMs: event.remainingMs,
      expiresAt: event.expiresAt,
      scheduledAt: event.scheduledAt,
    }),
  ]);
  if (!result?.ok) {
    throw result?.error ?? new Error("WeConnect session reminder was not sent.");
  }
  trace(
    "info",
    "session",
    `WeConnect sent hourly session reminder (${Math.ceil(event.remainingMs / 60_000)}m remaining).`,
  );
}

async function initializeSessionReminders(
  savedCredentials: RuntimeSavedCredentials | null,
): Promise<void> {
  sessionReminders?.close();
  const service = new SessionReminderService({
    statePath: path.join(
      stateStore.profileDir(PROFILE_ID),
      "session-reminder.json",
    ),
    sessionDurationMs: envMinutesMs(
      "WECHAT2ALL_SESSION_DURATION_MINUTES",
      24 * 60,
    ),
    reminderIntervalMs: envMinutesMs(
      "WECHAT2ALL_SESSION_REMINDER_INTERVAL_MINUTES",
      60,
    ),
    onReminder: deliverSessionReminder,
    onError(error) {
      trace("error", "session", `Could not send hourly reminder: ${error.message}`);
    },
    onSkipped(reason) {
      trace("debug", "session", `Hourly reminder skipped: ${reason}`);
    },
  });
  try {
    await service.initialize();
    sessionReminders = service;

    if (savedCredentials?.loginAt) {
      await service.startSession({
        loginAt: savedCredentials.loginAt,
        ownerUserId: savedCredentials.userId,
      });
    } else if (savedCredentials) {
      trace(
        "warn",
        "session",
        "Saved session has no loginAt; hourly reminders will start after the next QR login.",
      );
    }
  } catch (error) {
    service.close();
    sessionReminders = undefined;
    trace(
      "warn",
      "session",
      `Hourly reminders are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function ensureRuntime(): Promise<WeChatRuntime> {
  if (runtime) return runtime;
  const savedCredentials = await stateStore.loadCredentials(PROFILE_ID);
  runtime = await buildRuntime({
    id: PROFILE_ID,
    name: `Desktop Router (${PROFILE_ID})`,
    credentials: savedCredentials
      ? {
          accountId: savedCredentials.accountId,
          token: savedCredentials.token,
          baseUrl: savedCredentials.baseUrl,
        }
      : undefined,
  });
  return runtime;
}

async function startRuntimeMonitor(): Promise<void> {
  if (runtimeStarting) return;
  const current = await ensureRuntime();
  const profile = current.listProfiles().find((item) => item.id === PROFILE_ID);
  if (profile?.running) return;

  runtimeStarting = true;
  void current.startProfile(PROFILE_ID, {
    loadSyncBuf: () => stateStore.loadSyncBuf(PROFILE_ID),
    saveSyncBuf: (buf) => stateStore.saveSyncBuf(PROFILE_ID, buf),
  }).catch((error: unknown) => {
    trace("error", "runtime", error instanceof Error ? error.message : String(error));
  }).finally(() => {
    runtimeStarting = false;
  });
}

function logCodexBackend(): void {
  trace("info", "codex", "Using gui-app-server backend.");
}

async function startQrLogin(): Promise<LoginState> {
  const current = await ensureRuntime();
  if (loginState.active && loginState.qrPayload) {
    return loginState;
  }

  loginState = {
    active: true,
    status: "wait",
    startedAt: Date.now(),
  };
  const runId = ++loginRunId;
  loginAbortController = new AbortController();

  let resolveQr: (state: LoginState) => void;
  let rejectQr: (error: Error) => void;
  const qrReady = new Promise<LoginState>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  void current.getClient(PROFILE_ID).login({
    timeoutMs: 8 * 60_000,
    signal: loginAbortController.signal,
    onQRCode(qrcodeUrl) {
      if (runId !== loginRunId) return;
      loginState = {
        ...loginState,
        active: true,
        status: "wait",
        qrPayload: qrcodeUrl,
        qrcode: qrcodeUrl,
      };
      trace("info", "login", "QR code ready");
      resolveQr(loginState);
    },
    onStatus(status) {
      if (runId !== loginRunId) return;
      loginState = { ...loginState, status };
      trace("info", "login", `QR status: ${status}`);
    },
  }).then(async (result) => {
    if (runId !== loginRunId) return;
    loginAbortController = undefined;
    if (!result.connected) {
      loginState = {
        ...loginState,
        active: false,
        status: "failed",
        error: result.message,
      };
      trace("error", "login", result.message);
      return;
    }

    const creds = current.getClient(PROFILE_ID).getCredentials();
    if (!creds.accountId || !creds.token) {
      throw new Error("Login succeeded but credentials were incomplete.");
    }
    const loginAt = Date.now();
    await stateStore.saveCredentials(PROFILE_ID, {
      accountId: normalizeAccountId(creds.accountId),
      token: creds.token,
      baseUrl: creds.baseUrl,
      userId: result.userId,
      loginAt,
    });
    await sessionReminders?.startSession({
      loginAt,
      ownerUserId: result.userId,
      resetTarget: true,
    }).catch((error: unknown) => {
      trace(
        "warn",
        "session",
        `Could not start hourly reminders: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    loginState = {
      ...loginState,
      active: false,
      status: "confirmed",
      connectedAt: Date.now(),
    };
    trace("info", "login", `Logged in as ${creds.accountId}`);
    await startRuntimeMonitor();
  }).catch((error: unknown) => {
    if (runId !== loginRunId) return;
    loginAbortController = undefined;
    const message = error instanceof Error ? error.message : String(error);
    loginState = {
      ...loginState,
      active: false,
      status: "failed",
      error: message,
    };
    trace("error", "login", message);
    rejectQr(new Error(message));
  });

  return Promise.race([
    qrReady,
    new Promise<LoginState>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for QR code.")), 15_000);
    }),
  ]);
}

async function unlinkWechatSession(): Promise<void> {
  loginRunId++;
  loginAbortController?.abort();
  loginAbortController = undefined;
  try {
    runtime?.stopProfile(PROFILE_ID);
  } catch {
    // The profile may already be stopped.
  }
  await stateStore.clearCredentials(PROFILE_ID);
  sessionReminders?.stopSession();
  await sessionReminders?.clearTarget().catch((error: unknown) => {
    trace(
      "warn",
      "session",
      `Could not clear reminder target: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  loginState = { active: false, status: "idle" };
  runtime = undefined;
  runtimeStarting = false;
  await ensureRuntime();
  trace("info", "login", "Unlinked current WeChat session");
}

async function dashboardSnapshot(): Promise<unknown> {
  const current = await ensureRuntime();
  return createDashboardSnapshot({
    profileId: PROFILE_ID,
    runtime: current,
    stateStore,
    traces: traceLogger.events(),
    routeStats,
    routerEndpoint: `http://${HOST}:${PORT}`,
    sessionExpiresAt: sessionReminders?.getSessionExpiresAt(),
  });
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

async function readJson(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new HttpRequestError(413, `JSON request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpRequestError(400, "Request body must contain valid JSON.");
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "http://localhost:5173",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function llmHealthResponse(result: LlmHealthSnapshot): unknown {
  return {
    ok: true,
    schemaVersion: 1,
    llm: result,
  };
}

function requireLlmHealth(): LlmHealthService {
  if (!llmHealth) throw new Error("LLM health service is not initialized.");
  return llmHealth;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "wechat2all-router-daemon",
        profileId: PROFILE_ID,
        codexBackend: codexBackend(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/snapshot") {
      sendJson(res, 200, await dashboardSnapshot());
      return;
    }
    if (req.method === "GET" && url.pathname === "/config") {
      if (!localConfig) throw new Error("Local config store is not initialized.");
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        config: await localConfig.snapshot(),
      });
      return;
    }
    if (req.method === "PATCH" && url.pathname === "/config") {
      if (!localConfig) throw new Error("Local config store is not initialized.");
      const result = await localConfig.update(await readJson(req));
      if (result.changed) {
        trace("info", "config", `Updated ${result.changedFields.join(", ")}`);
      }
      sendJson(res, 200, { ok: true, schemaVersion: 1, ...result });
      return;
    }
    if (req.method === "GET" && url.pathname === "/upochi/config") {
      if (!upochiConfig) throw new Error("Upochi config store is not initialized.");
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        config: await upochiConfig.snapshot(),
      });
      return;
    }
    if (req.method === "PATCH" && url.pathname === "/upochi/config") {
      if (!upochiConfig) throw new Error("Upochi config store is not initialized.");
      const result = await upochiConfig.update(await readJson(req));
      if (result.changed) {
        trace(
          "info",
          "upochi-config",
          `Updated ${result.changedFields.join(", ")} in ${result.config.envPath}`,
        );
      }
      sendJson(res, 200, { ok: true, schemaVersion: 1, ...result });
      return;
    }
    if (req.method === "GET" && url.pathname === "/upochi/health") {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        upochi: await checkUpochiHealth(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/llm/health") {
      sendJson(res, 200, llmHealthResponse(requireLlmHealth().snapshot()));
      return;
    }
    if (req.method === "POST" && url.pathname === "/llm/health/check") {
      await readJson(req);
      const result = await requireLlmHealth().check();
      sendJson(res, 200, llmHealthResponse(result));
      return;
    }
    if (req.method === "GET" && url.pathname === "/codex/setup-check") {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        check: getCodexSetupCheckSnapshot(),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/codex/setup-check") {
      await readJson(req);
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        check: await refreshCodexSetupCheck(),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/login/qr/start") {
      await readJson(req);
      const state = await startQrLogin();
      sendJson(res, 200, {
        profileId: PROFILE_ID,
        qrUrl: state.qrPayload,
        qrPayload: state.qrPayload,
        qrcode: state.qrcode,
        expiresInSeconds: 300,
        status: state.status,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/login/status") {
      const savedCredentials = await stateStore.loadCredentials(PROFILE_ID);
      sendJson(res, 200, {
        profileId: PROFILE_ID,
        status: loginState.status,
        active: loginState.active,
        connected: Boolean(savedCredentials),
        accountId: savedCredentials?.accountId ?? null,
        error: loginState.error ?? null,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/login/unlink") {
      await readJson(req);
      await unlinkWechatSession();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/runtime/start") {
      await startRuntimeMonitor();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/dev/shutdown") {
      if (process.env.WECHAT2ALL_ENABLE_DEV_SHUTDOWN !== "1") {
        sendJson(res, 404, { error: "Development shutdown is disabled." });
        return;
      }
      sendJson(res, 200, { ok: true });
      setImmediate(() => {
        try {
          runtime?.stopProfile(PROFILE_ID);
        } catch {
          // The profile may already be stopped.
        }
        sessionReminders?.close();
        const forceExit = setTimeout(() => process.exit(0), 2_000);
        forceExit.unref();
        server?.close(() => process.exit(0));
      });
      return;
    }

    sendJson(res, 404, { error: `Unknown route: ${req.method} ${url.pathname}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof HttpRequestError
      ? error.status
      : error instanceof LocalConfigValidationError
        ? 400
        : error instanceof UpochiConfigValidationError
          ? 400
          : error instanceof UpochiProjectNotFoundError
            ? 404
            : 500;
    trace(status >= 500 ? "error" : "warn", "http", message);
    sendJson(res, status, { error: message });
  }
}

async function main(): Promise<void> {
  loadLocalEnv(trace);
  refreshRuntimeSettings();
  localConfig = new LocalConfigStore({ filePath: resolveLocalEnvPath() });
  upochiConfig = new UpochiConfigStore();
  llmHealth = new LlmHealthService({
    timeoutMs: envNumber("WECHAT2ALL_LLM_HEALTH_TIMEOUT_MS"),
    onResult(result) {
      if (result.status === "ready") {
        trace(
          "info",
          "llm-health",
          `LLM check passed for ${result.provider}/${result.model} (${result.latencyMs}ms).`,
        );
        return;
      }
      trace(
        "warn",
        "llm-health",
        `LLM check ${result.status}: ${result.error?.message ?? "unknown error"}`,
      );
    },
  });
  await stateStore.securePermissions();
  const savedCredentials = await stateStore.loadCredentials(PROFILE_ID);
  await initializeSessionReminders(savedCredentials);
  await ensureRuntime();
  logCodexBackend();
  if (savedCredentials) {
    void startRuntimeMonitor();
  }

  server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[router-daemon] fatal http: ${HOST}:${PORT} is already in use. ` +
          "Run `lsof -nP -iTCP:" +
          PORT +
          " -sTCP:LISTEN` to inspect the existing process.",
      );
      process.exit(1);
    }
    console.error("[router-daemon] fatal http", error);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    trace("info", "http", `Listening on http://${HOST}:${PORT}`);
    void requireLlmHealth().check();
    const codexRouteInstalled = runtime?.listRoutes().some((route) =>
      route.connectorId === "codex-bridge" && route.enabled !== false
    );
    if (codexRouteInstalled) startCodexSetupCheckAfterStartup();
  });
}

main().catch((error) => {
  console.error("[router-daemon] fatal", error);
  process.exit(1);
});
