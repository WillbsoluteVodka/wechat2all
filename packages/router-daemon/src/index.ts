import http from "node:http";
import os from "node:os";
import path from "node:path";

import { normalizeAccountId } from "wechat2all";

import {
  FileRuntimeStateStore,
  RuntimeMediaPipeline,
  WeChatRuntime,
  createAgentMemoryProviderFromEnv,
  createCodexConnector,
  createDummyTTSProvider,
  createLLMProviderFromEnv,
  createMainAssistantConnector,
  createRouteAssistantConnector,
  createStateStoreMessageDeduper,
  parseCodexReplyMode,
  type CodexBridgeClient,
  type RuntimeActionResult,
  type RuntimeMessage,
  type RuntimeProfileConfig,
} from "@wechat2all/runtime";

import { codexBackend, createCodexBridgeFromEnv } from "./codex.js";
import { createDashboardSnapshot } from "./dashboard.js";
import { envNumber, loadLocalEnv, readRouterAddress } from "./env.js";
import {
  applySavedRouteOverrides,
  defaultRoutes,
  isPersistableRoute,
  isUserManagedRoute,
} from "./routes.js";
import { createTraceLogger } from "./trace.js";

let routerAddress = readRouterAddress();
let HOST = routerAddress.host;
let PORT = routerAddress.port;
const PROFILE_ID = process.env.WECHAT_RUNTIME_PROFILE ?? "default";
const BASE_STATE_DIR = path.join(os.homedir(), ".wechat2all-runtime-bot");
const stateStore = new FileRuntimeStateStore({ baseDir: BASE_STATE_DIR });
let codexBridge: CodexBridgeClient | undefined;

function refreshRouterAddress(): void {
  routerAddress = readRouterAddress();
  HOST = routerAddress.host;
  PORT = routerAddress.port;
}

function getCodexBridge(): CodexBridgeClient {
  codexBridge ??= createCodexBridgeFromEnv();
  return codexBridge;
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
const traceLogger = createTraceLogger();
const trace = traceLogger.trace;

async function buildRuntime(profile: RuntimeProfileConfig): Promise<WeChatRuntime> {
  const savedRoutes = await stateStore.loadRoutes(PROFILE_ID);
  const savedUserRoutes = savedRoutes.filter(isUserManagedRoute);
  const builtInRoutes = defaultRoutes(profile.id)
    .map((route) => applySavedRouteOverrides(route, savedRoutes));
  const llm = createLLMProviderFromEnv();
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
      }),
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
      builtInRoutes[0],
      ...savedUserRoutes,
      builtInRoutes[1],
    ],
    monitor: {
      sessionExpiredBehavior: "stop",
    },
  });

  next.on("message", (message: RuntimeMessage) => {
    trace("info", "message", `${message.kind}: ${message.text ?? "(media)"}`);
  });
  next.on("messageSkipped", (_message, reason) => {
    trace("debug", "message", `Skipped inbound message: ${reason}`);
  });
  next.on("actions", (message, results: RuntimeActionResult[]) => {
    for (const result of results) {
      const suffix = result.ok ? "ok" : `failed: ${result.error?.message ?? "unknown"}`;
      trace("info", "action", `${message.conversationId}: ${result.action.type} -> ${suffix}`);
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

  return next;
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

  let resolveQr: (state: LoginState) => void;
  let rejectQr: (error: Error) => void;
  const qrReady = new Promise<LoginState>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  void current.getClient(PROFILE_ID).login({
    timeoutMs: 8 * 60_000,
    onQRCode(qrcodeUrl) {
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
      loginState = { ...loginState, status };
      trace("info", "login", `QR status: ${status}`);
    },
  }).then(async (result) => {
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
    await stateStore.saveCredentials(PROFILE_ID, {
      accountId: normalizeAccountId(creds.accountId),
      token: creds.token,
      baseUrl: creds.baseUrl,
      userId: result.userId,
      loginAt: Date.now(),
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

async function dashboardSnapshot(): Promise<unknown> {
  const current = await ensureRuntime();
  return createDashboardSnapshot({
    profileId: PROFILE_ID,
    runtime: current,
    stateStore,
    traces: traceLogger.events(),
    routerEndpoint: `http://${HOST}:${PORT}`,
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) as unknown : {};
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "http://localhost:5173",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(data));
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
    if (req.method === "POST" && url.pathname === "/runtime/start") {
      await startRuntimeMonitor();
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: `Unknown route: ${req.method} ${url.pathname}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace("error", "http", message);
    sendJson(res, 500, { error: message });
  }
}

async function main(): Promise<void> {
  loadLocalEnv(trace);
  refreshRouterAddress();
  await ensureRuntime();
  logCodexBackend();
  if (await stateStore.loadCredentials(PROFILE_ID)) {
    void startRuntimeMonitor();
  }

  const server = http.createServer((req, res) => {
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
  });
}

main().catch((error) => {
  console.error("[router-daemon] fatal", error);
  process.exit(1);
});
