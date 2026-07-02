import { invoke } from "@tauri-apps/api/core";

import type {
  DashboardSnapshot,
  LoginStatus,
  QrLoginResponse,
  SettingsSnapshot,
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
      id: "codex",
      name: "codex",
      description: "Codex bridge：本地 Codex 连接能力，通过大助手 /cd codex 进入。",
      enabled: true,
      priority: 900,
      connectorId: "codex-bridge",
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
      id: "codex-bridge",
      name: "Codex Bridge",
      kind: "MCP bridge",
      status: "ready",
      routeCount: 1,
      description: "本地 Codex bridge 能力，后续由 router 管理入口。",
    },
    {
      id: "wechat2all-mcp",
      name: "wechat2all MCP Server",
      kind: "MCP",
      status: "planned",
      routeCount: 0,
      description: "给 Codex/Claude/Cursor 等 agent 暴露微信发送和查询工具。",
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

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  if (!isTauri()) return fallbackSnapshot;
  return invoke<DashboardSnapshot>("get_dashboard_snapshot");
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

export async function saveSettings(
  payload: SettingsSnapshot,
): Promise<SettingsSnapshot> {
  if (!isTauri()) return payload;
  return invoke<SettingsSnapshot>("save_settings", { payload });
}
