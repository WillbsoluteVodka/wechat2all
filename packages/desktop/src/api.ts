import { invoke } from "@tauri-apps/api/core";

import type {
  CommunityCatalogResponse,
  CommunityInstallRequest,
  CommunityInstalledResponse,
  CommunityInstalledRoute,
  CommunityOperation,
  CommunityOperationKind,
  CommunityOperationResponse,
  DashboardSnapshot,
  LocalConfigPatch,
  LocalConfigResponse,
  LocalConfigSnapshot,
  LocalConfigUpdateResponse,
  LlmHealthResponse,
  LoginStatus,
  QrLoginResponse,
  RouteSetupCheckResponse,
} from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

const fallbackSnapshot: DashboardSnapshot = {
  profile: {
    id: "default",
    name: "Main WeChat",
    connected: false,
    running: false,
    accountId: null,
    lastSeenAt: null,
    sessionExpiresAt: null,
  },
  routes: [
    {
      id: "main-assistant-default",
      name: "大助手",
      description: "默认入口：普通对话、route 分发、固定 slash 命令。",
      enabled: true,
      priority: -100,
      connectorId: "main-assistant",
      matchText: ["fallback", "/help", "/ls", "/rename", "/cd"],
      stats: { messagesToday: 0, lastHitAt: null },
    },
    {
      id: "claude",
      name: "claude",
      description: "Claude Agent SDK + Obsidian vault，通过大助手 /cd claude 进入。",
      enabled: true,
      priority: 850,
      connectorId: "claude-route",
      matchText: [],
      stats: { messagesToday: 0, lastHitAt: null },
    },
    {
      id: "assistant-route-default-sales",
      name: "Sales",
      description: "示例 route：处理报价、价格、销售相关消息。",
      enabled: true,
      priority: 80,
      connectorId: "route-assistant",
      matchText: ["报价", "价格", "/sales"],
      stats: { messagesToday: 0, lastHitAt: null },
    },
    {
      id: "assistant-route-default-calendar",
      name: "Calendar",
      description: "示例 route：后续可接 macOS Calendar / Reminder。",
      enabled: false,
      priority: 70,
      connectorId: "mcp-calendar",
      matchText: ["日程", "calendar"],
      stats: { messagesToday: 0, lastHitAt: null },
    },
  ],
  agents: [
    {
      id: "main-assistant",
      name: "大助手",
      kind: "LLM route harness",
      status: "ready",
      routeCount: 1,
      description: "负责默认对话、route 分发和固定 slash 命令。",
    },
    {
      id: "claude-route",
      name: "Claude Route",
      kind: "Claude Agent SDK",
      status: "needs-config",
      routeCount: 1,
      description: "独立 Claude Agent SDK route，可连接 Obsidian vault 或本地工作区。",
    },
    {
      id: "wechat2all-mcp",
      name: "wechat2all MCP Server",
      kind: "MCP",
      status: "planned",
      routeCount: 0,
      description: "给本地 agent 暴露微信发送和查询工具。",
    },
  ],
  traces: [
    {
      id: "trace-1",
      time: "browser preview",
      level: "info",
      source: "desktop",
      message: "Dashboard preview is running without Tauri commands.",
      routeId: null,
    },
  ],
  settings: {
    llmProvider: "deepseek/openai-compatible",
    memoryProvider: "local-jsonl + mem0",
    autostartEnabled: false,
    routerEndpoint: "local://wechat2all-router",
  },
};

const previewCommunityManifest = {
  protocol: "weconnect.route" as const,
  protocolVersion: 1 as const,
  id: "community-preview",
  packageName: "@weconnect-preview/community-route",
  displayName: "Community Preview",
  version: "0.0.0",
  description: "Browser-only preview of the generic Community installation flow.",
  license: "MIT",
  author: { name: "WeConnect Preview" },
  engines: { weconnect: ">=0.1.0 <2", node: ">=20" },
  capabilities: ["text-input", "text-output"],
  permissions: [],
};

let fallbackCommunityInstalled: CommunityInstalledRoute[] = [];
const fallbackCommunityOperations = new Map<string, CommunityOperation>();

function previewOperation(kind: CommunityOperationKind, routeId: string): CommunityOperationResponse {
  if (routeId !== previewCommunityManifest.id) {
    throw new Error(`Unknown Community preview route: ${routeId}`);
  }
  const now = new Date().toISOString();
  if (kind === "uninstall") {
    fallbackCommunityInstalled = fallbackCommunityInstalled.filter((route) => route.id !== routeId);
  } else if (!fallbackCommunityInstalled.some((route) => route.id === routeId)) {
    fallbackCommunityInstalled = [{
      id: previewCommunityManifest.id,
      packageName: previewCommunityManifest.packageName,
      displayName: previewCommunityManifest.displayName,
      version: previewCommunityManifest.version,
      manifest: previewCommunityManifest,
      installedAt: now,
      sourceCatalog: "browser-preview",
      installDir: `~/Library/Application Support/WeConnect/community/routes/${routeId}/0.0.0`,
      status: "installed",
    }];
  }
  const operation: CommunityOperation = {
    id: `preview-${kind}-${Date.now()}`,
    kind,
    routeId,
    status: "succeeded",
    progress: 100,
    message: `${kind} completed in browser preview.`,
    restartRequired: false,
    createdAt: now,
    updatedAt: now,
  };
  fallbackCommunityOperations.set(operation.id, operation);
  return { ok: true, operation };
}

let fallbackLocalConfig: LocalConfigSnapshot = {
  configPath: ".env.local",
  runtimeApplied: true,
  restartRequired: false,
  llm: {
    provider: "openai-compatible",
    apiKey: { configured: false, masked: null },
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    temperature: null,
    maxTokens: 800,
    timeoutMs: 15_000,
  },
  memory: {
    provider: "local",
    apiKey: { configured: false, masked: null },
    baseUrl: "https://api.mem0.ai",
    timeoutMs: 15_000,
    localMaxSearchRows: 2_000,
  },
  claude: {
    apiKey: { configured: false, masked: null },
    workdir: null,
    promptFile: null,
    model: null,
    language: "zh",
    sessionWindowMinutes: 15,
    maxMediaMb: 50,
    maxTurns: 40,
    maxBudgetUsd: 1,
    timeoutMs: 10 * 60_000,
    allowCliAuth: false,
    executable: null,
  },
};

function previewSecretStatus(
  value: string | null | undefined,
  current: LocalConfigSnapshot["llm"]["apiKey"],
) {
  if (value === undefined) return current;
  if (value === null) return { configured: false, masked: null };
  return {
    configured: true,
    masked: value.length < 8 ? "********" : `${value.slice(0, 3)}...${value.slice(-4)}`,
  };
}

function nextValue<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  if (!isTauri()) return fallbackSnapshot;
  return invoke<DashboardSnapshot>("get_dashboard_snapshot");
}

export async function getLlmHealth(): Promise<LlmHealthResponse> {
  if (!isTauri()) {
    return {
      ok: true,
      schemaVersion: 1,
      llm: {
        status: "not-configured",
        provider: "openai-compatible",
        model: null,
        apiKeyConfigured: false,
        configured: false,
        usable: false,
        checkedAt: null,
        latencyMs: null,
        error: { code: "model_missing", message: "Browser preview has no configured LLM." },
      },
    };
  }
  return invoke<LlmHealthResponse>("get_llm_health");
}

const fallbackRouteSetupCheck: RouteSetupCheckResponse = {
  ok: true,
  schemaVersion: 1,
  check: {
    status: "ready",
    checkedAt: new Date().toISOString(),
    items: [
      { status: "info", message: "Setup checks are unavailable in browser preview.", section: "Preview" },
    ],
    exitCode: 1,
    error: null,
  },
};

export async function getRouteSetupCheck(routeId: string): Promise<RouteSetupCheckResponse> {
  if (!isTauri()) return fallbackRouteSetupCheck;
  return invoke<RouteSetupCheckResponse>("get_route_setup_check", { routeId });
}

export async function refreshRouteSetupCheck(routeId: string): Promise<RouteSetupCheckResponse> {
  if (!isTauri()) return fallbackRouteSetupCheck;
  return invoke<RouteSetupCheckResponse>("refresh_route_setup_check", { routeId });
}

export async function requestQrLogin(profileId: string): Promise<QrLoginResponse> {
  if (!isTauri()) {
    return {
      profileId,
      qrUrl: "wechat2all://qr-login/browser-preview",
      qrPayload: "wechat2all://qr-login/browser-preview",
      qrcode: "browser-preview",
      expiresInSeconds: 300,
      status: "browser-preview",
    };
  }
  return invoke<QrLoginResponse>("request_qr_login", { profileId });
}

export async function getLoginStatus(profileId: string): Promise<LoginStatus> {
  if (!isTauri()) {
    return {
      profileId,
      status: "browser-preview",
      active: false,
      connected: false,
      accountId: null,
      error: null,
    };
  }
  return invoke<LoginStatus>("get_login_status", { profileId });
}

export async function unlinkWechatSession(profileId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("unlink_wechat_session", { profileId });
}

export async function getLocalConfig(): Promise<LocalConfigSnapshot> {
  if (!isTauri()) return fallbackLocalConfig;
  const response = await invoke<LocalConfigResponse>("get_local_config");
  return response.config;
}

export async function patchLocalConfig(
  payload: LocalConfigPatch,
): Promise<LocalConfigUpdateResponse> {
  if (!isTauri()) {
    const llmPatch = payload.llm;
    const memoryPatch = payload.memory;
    const claudePatch = payload.claude;
    const extensionPatch = Object.fromEntries(
      Object.entries(payload)
        .filter(([key, value]) => !["llm", "memory", "claude"].includes(key)
          && value && typeof value === "object" && !Array.isArray(value))
        .map(([key, value]) => [
          key,
          {
            ...(fallbackLocalConfig[key] && typeof fallbackLocalConfig[key] === "object"
              ? fallbackLocalConfig[key] as Record<string, unknown>
              : {}),
            ...value as Record<string, unknown>,
          },
        ]),
    );
    fallbackLocalConfig = {
      ...fallbackLocalConfig,
      ...extensionPatch,
      runtimeApplied: false,
      restartRequired: true,
      llm: {
        ...fallbackLocalConfig.llm,
        provider: nextValue(llmPatch?.provider, fallbackLocalConfig.llm.provider) ?? "mock",
        apiKey: previewSecretStatus(llmPatch?.apiKey, fallbackLocalConfig.llm.apiKey),
        model: nextValue(llmPatch?.model, fallbackLocalConfig.llm.model),
        baseUrl: nextValue(llmPatch?.baseUrl, fallbackLocalConfig.llm.baseUrl) ?? "",
        temperature: nextValue(llmPatch?.temperature, fallbackLocalConfig.llm.temperature),
        maxTokens: nextValue(llmPatch?.maxTokens, fallbackLocalConfig.llm.maxTokens),
        timeoutMs: nextValue(llmPatch?.timeoutMs, fallbackLocalConfig.llm.timeoutMs),
      },
      memory: {
        ...fallbackLocalConfig.memory,
        provider: nextValue(memoryPatch?.provider, fallbackLocalConfig.memory.provider) ?? "local",
        apiKey: previewSecretStatus(memoryPatch?.apiKey, fallbackLocalConfig.memory.apiKey),
        baseUrl: nextValue(memoryPatch?.baseUrl, fallbackLocalConfig.memory.baseUrl) ?? "",
        timeoutMs: nextValue(memoryPatch?.timeoutMs, fallbackLocalConfig.memory.timeoutMs) ?? 15_000,
        localMaxSearchRows: nextValue(
          memoryPatch?.localMaxSearchRows,
          fallbackLocalConfig.memory.localMaxSearchRows,
        ),
      },
      claude: {
        ...fallbackLocalConfig.claude,
        apiKey: previewSecretStatus(
          claudePatch?.apiKey,
          fallbackLocalConfig.claude.apiKey,
        ),
        workdir: nextValue(claudePatch?.workdir, fallbackLocalConfig.claude.workdir),
        promptFile: nextValue(
          claudePatch?.promptFile,
          fallbackLocalConfig.claude.promptFile,
        ),
        model: nextValue(claudePatch?.model, fallbackLocalConfig.claude.model),
        language: nextValue(
          claudePatch?.language,
          fallbackLocalConfig.claude.language,
        ) ?? "zh",
        sessionWindowMinutes: nextValue(
          claudePatch?.sessionWindowMinutes,
          fallbackLocalConfig.claude.sessionWindowMinutes,
        ) ?? 15,
        maxMediaMb: nextValue(
          claudePatch?.maxMediaMb,
          fallbackLocalConfig.claude.maxMediaMb,
        ) ?? 50,
        maxTurns: nextValue(
          claudePatch?.maxTurns,
          fallbackLocalConfig.claude.maxTurns,
        ) ?? 40,
        maxBudgetUsd: nextValue(
          claudePatch?.maxBudgetUsd,
          fallbackLocalConfig.claude.maxBudgetUsd,
        ) ?? 1,
        timeoutMs: nextValue(
          claudePatch?.timeoutMs,
          fallbackLocalConfig.claude.timeoutMs,
        ) ?? 10 * 60_000,
        allowCliAuth: nextValue(
          claudePatch?.allowCliAuth,
          fallbackLocalConfig.claude.allowCliAuth,
        ) ?? false,
        executable: nextValue(
          claudePatch?.executable,
          fallbackLocalConfig.claude.executable,
        ),
      },
    };
    return {
      ok: true,
      schemaVersion: 1,
      changed: true,
      changedFields: ["browser-preview"],
      config: fallbackLocalConfig,
    };
  }
  return invoke<LocalConfigUpdateResponse>("patch_local_config", { payload });
}

export async function getCommunityCatalog(): Promise<CommunityCatalogResponse> {
  if (!isTauri()) {
    const installed = fallbackCommunityInstalled.find(
      (route) => route.id === previewCommunityManifest.id,
    );
    return {
      ok: true,
      schemaVersion: 1,
      routes: [{
        id: previewCommunityManifest.id,
        packageName: previewCommunityManifest.packageName,
        displayName: previewCommunityManifest.displayName,
        version: previewCommunityManifest.version,
        description: previewCommunityManifest.description,
        manifest: previewCommunityManifest,
        artifact: {
          type: "directory",
          url: "browser-preview://community-route",
        },
        requirements: [],
        installedVersion: installed?.version ?? null,
        status: installed ? "installed" : "available",
      }],
    };
  }
  return invoke<CommunityCatalogResponse>("get_community_catalog");
}

export async function getCommunityInstalled(): Promise<CommunityInstalledResponse> {
  if (!isTauri()) {
    return { ok: true, schemaVersion: 1, routes: fallbackCommunityInstalled };
  }
  return invoke<CommunityInstalledResponse>("get_community_installed");
}

export async function installCommunityRoute(
  routeId: string,
  payload: CommunityInstallRequest = {},
): Promise<CommunityOperationResponse> {
  if (!isTauri()) return previewOperation("install", routeId);
  return invoke<CommunityOperationResponse>("install_community_route", { routeId, payload });
}

export async function updateCommunityRoute(
  routeId: string,
  payload: CommunityInstallRequest = {},
): Promise<CommunityOperationResponse> {
  if (!isTauri()) return previewOperation("update", routeId);
  return invoke<CommunityOperationResponse>("update_community_route", { routeId, payload });
}

export async function uninstallCommunityRoute(
  routeId: string,
): Promise<CommunityOperationResponse> {
  if (!isTauri()) return previewOperation("uninstall", routeId);
  return invoke<CommunityOperationResponse>("uninstall_community_route", { routeId });
}

export async function getCommunityOperation(
  operationId: string,
): Promise<CommunityOperationResponse> {
  if (!isTauri()) {
    const operation = fallbackCommunityOperations.get(operationId);
    if (!operation) throw new Error(`Unknown Community operation: ${operationId}`);
    return { ok: true, operation };
  }
  return invoke<CommunityOperationResponse>("get_community_operation", { operationId });
}
