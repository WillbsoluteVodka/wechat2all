import type { RouteDashboardContributionV1, RuntimeRoute } from "@wechat2all/route-sdk";

export const OFFICE_ROUTE_ID = "office";
export const OFFICE_CONNECTOR_ID = "office-route";

export const OFFICE_DASHBOARD: RouteDashboardContributionV1 = {
  agent: {
    name: "Office Route",
    kind: "WeConnect LLM + OfficeCLI",
    status: "ready",
    description: "独立处理 Word、Excel、PowerPoint；复用 WeConnect LLM，不依赖 Codex。",
  },
  management: {
    setupCheck: true,
    commands: [
      { rule: "/status", description: "查看 Office route 配置" },
      { rule: "/files", description: "查看当前会话文件" },
      { rule: "/new", description: "清空当前 Office 工作区" },
      { rule: "/cd ..", description: "回到主 Router" },
    ],
  },
};

export function createOfficeRouteDefinition(profileId: string): RuntimeRoute {
  return {
    id: OFFICE_ROUTE_ID,
    profileId,
    connectorId: OFFICE_CONNECTOR_ID,
    priority: 840,
    terminal: true,
    match: { kind: "text", textCommands: [] },
    metadata: {
      assistantName: "office",
      description: "WeConnect LLM 驱动 OfficeCLI 创建、读取和修改 Office 文档。",
      systemPrompt: "独立 OfficeCLI route，通过主 Router 的 /cd office 进入。",
      builtIn: true,
    },
  };
}
