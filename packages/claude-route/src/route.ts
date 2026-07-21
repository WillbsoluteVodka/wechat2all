import type {
  RouteDashboardContributionV1,
  RuntimeRoute,
} from "@wechat2all/route-sdk";

export const CLAUDE_ROUTE_ID = "claude";
export const CLAUDE_CONNECTOR_ID = "claude-route";

export const CLAUDE_DASHBOARD: RouteDashboardContributionV1 = {
  agent: {
    name: "Claude Route",
    kind: "Claude Agent SDK",
    status: process.env.WECHAT2ALL_CLAUDE_WORKDIR ? "configured" : "needs-config",
    description: "独立 Claude Agent SDK route，可连接 Obsidian vault 或本地工作区。",
  },
  management: {
    commands: [
      { rule: "/status", description: "查看 Claude route 状态" },
      { rule: "/new", description: "新建 Claude session" },
      { rule: "/cd ..", description: "回到主 Router" },
    ],
  },
};

export function createClaudeRouteDefinition(profileId: string): RuntimeRoute {
  return {
    id: CLAUDE_ROUTE_ID,
    profileId,
    connectorId: CLAUDE_CONNECTOR_ID,
    priority: 850,
    terminal: true,
    match: {
      kind: "text",
      textCommands: [],
    },
    metadata: {
      assistantName: "claude",
      systemPrompt:
        "Claude Agent SDK + Obsidian vault，通过主 Router 的 /cd claude 进入。",
      builtIn: true,
    },
  };
}
