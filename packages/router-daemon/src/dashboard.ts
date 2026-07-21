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
  const routeAgents = new Map<string, {
    id: string;
    name: string;
    kind: string;
    status: string;
    routeCount: number;
    description: string;
  }>();
  for (const route of dashboardRoutes) {
    const value = route.metadata?.dashboardAgent;
    if (!value || typeof value !== "object") continue;
    const agent = value as Record<string, unknown>;
    const previous = routeAgents.get(route.connectorId);
    routeAgents.set(route.connectorId, {
      id: route.connectorId,
      name: typeof agent.name === "string" ? agent.name : routeName(route),
      kind: typeof agent.kind === "string" ? agent.kind : "Route package",
      status: typeof agent.status === "string" ? agent.status : "ready",
      routeCount: (previous?.routeCount ?? 0) + 1,
      description: typeof agent.description === "string"
        ? agent.description
        : routeDescription(route),
    });
  }

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
        package:
          route.metadata?.routePackage
          && typeof route.metadata.routePackage === "object"
            ? route.metadata.routePackage
            : null,
        matchText: routeMatchText(route),
        management:
          route.metadata?.dashboardManagement
          && typeof route.metadata.dashboardManagement === "object"
            ? route.metadata.dashboardManagement
            : null,
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
      ...routeAgents.values(),
      {
        id: "wechat2all-mcp",
        name: "wechat2all MCP Server",
        kind: "MCP",
        status: "planned",
        routeCount: 0,
        description: "给本地 agent 暴露微信发送和查询工具。",
      },
    ],
    traces: opts.traces.slice().reverse(),
    settings: {
      llmProvider: env.WECHAT2ALL_LLM_PROVIDER ?? "openai-compatible",
      memoryProvider: env.WECHAT2ALL_MEMORY_PROVIDER ?? "local",
      autostartEnabled: false,
      routerEndpoint: opts.routerEndpoint,
    },
  };
}
