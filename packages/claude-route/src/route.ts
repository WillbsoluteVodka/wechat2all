import type { RuntimeRoute } from "@wechat2all/runtime";

export const CLAUDE_ROUTE_ID = "claude";
export const CLAUDE_CONNECTOR_ID = "claude-route";

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
