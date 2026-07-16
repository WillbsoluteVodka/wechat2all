import type {
  RuntimeStateStore,
  WeChatRuntime,
} from "@wechat2all/runtime";

import { routeDescription, routeMatchText, routeName } from "./routes.js";
import type { TraceEvent } from "./trace.js";

export interface DashboardRouteStats {
  dayKey: string;
  messagesToday: number;
  lastHitAt: string;
}

export interface DashboardSnapshotOptions {
  profileId: string;
  runtime: WeChatRuntime;
  stateStore: Pick<RuntimeStateStore, "loadCredentials">;
  traces: TraceEvent[];
  routeStats: ReadonlyMap<string, DashboardRouteStats>;
  routerEndpoint: string;
  sessionExpiresAt?: number;
  env?: NodeJS.ProcessEnv;
}

export async function createDashboardSnapshot(
  opts: DashboardSnapshotOptions,
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const savedCredentials = await opts.stateStore.loadCredentials(opts.profileId);
  const profile = opts.runtime.listProfiles().find((item) => item.id === opts.profileId);
  const routes = opts.runtime.listRoutes();
  const dashboardRoutes = routes.filter((route) => route.id !== "main-assistant-commands");
  const mainRoute = dashboardRoutes.find((route) => route.id === "main-assistant-default");
  const now = new Date();
  const todayKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  return {
    profile: {
      id: opts.profileId,
      name: profile?.name ?? `Desktop Router (${opts.profileId})`,
      connected: Boolean(savedCredentials),
      running: profile?.running ?? false,
      accountId: savedCredentials?.accountId ?? null,
      lastSeenAt: savedCredentials?.loginAt
        ? new Date(savedCredentials.loginAt).toISOString()
        : null,
      sessionExpiresAt: opts.sessionExpiresAt
        ? new Date(opts.sessionExpiresAt).toISOString()
        : null,
    },
    routes: dashboardRoutes.map((route) => {
      const routeStats = opts.routeStats.get(route.id);
      const currentStats = routeStats?.dayKey === todayKey ? routeStats : undefined;

      return {
        id: route.id,
        name: routeName(route),
        description: routeDescription(route),
        enabled: route.enabled ?? true,
        priority: route.priority ?? 0,
        connectorId: route.connectorId,
        matchText: routeMatchText(route),
        stats: {
          messagesToday: currentStats?.messagesToday ?? 0,
          lastHitAt: currentStats?.lastHitAt ?? null,
        },
      };
    }),
    agents: [
      {
        id: "main-assistant",
        name: mainRoute ? routeName(mainRoute) : "大助手",
        kind: "LLM route harness",
        status: "ready",
        routeCount: dashboardRoutes.filter((route) => route.connectorId === "main-assistant").length,
        description: "负责默认对话、route 分发和固定 slash 命令。",
      },
      {
        id: "route-assistant",
        name: "Route Assistant",
        kind: "LLM route assistant",
        status: "ready",
        routeCount: routes.filter((route) => route.connectorId === "route-assistant").length,
        description: "负责用户创建的 route-specific assistant。",
      },
      {
        id: "codex-bridge",
        name: "Codex Bridge",
        kind: "MCP bridge",
        status: "ready",
        routeCount: dashboardRoutes.filter((route) => route.connectorId === "codex-bridge").length,
        description: "本地 Codex bridge 能力，后续由 router 管理入口。",
      },
      {
        id: "claude-route",
        name: "Claude Route",
        kind: "Claude Agent SDK",
        status: env.WECHAT2ALL_CLAUDE_WORKDIR ? "configured" : "needs-config",
        routeCount: dashboardRoutes.filter((route) => route.connectorId === "claude-route").length,
        description: "独立 Claude Agent SDK route，可连接 Obsidian vault 或本地工作区。",
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
    traces: opts.traces.slice().reverse(),
    settings: {
      llmProvider: env.WECHAT2ALL_LLM_PROVIDER ?? "openai-compatible",
      memoryProvider: env.WECHAT2ALL_MEMORY_PROVIDER ?? "local",
      codexBackend: "gui-app-server",
      codexDelivery: env.WECHAT2ALL_CODEX_DELIVERY ?? "app-server",
      autostartEnabled: false,
      routerEndpoint: opts.routerEndpoint,
    },
  };
}
