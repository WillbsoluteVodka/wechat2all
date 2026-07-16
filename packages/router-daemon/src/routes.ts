import type { RuntimeRoute } from "@wechat2all/runtime";
import { createClaudeRouteDefinition } from "@wechat2all/claude-route";

export function isUserManagedRoute(route: RuntimeRoute): boolean {
  return route.metadata?.createdBy === "main-assistant";
}

export function isRenamedRoute(route: RuntimeRoute): boolean {
  return route.metadata?.renamedBy === "user";
}

export function isPersistableRoute(route: RuntimeRoute): boolean {
  return isUserManagedRoute(route) || isRenamedRoute(route);
}

export function applySavedRouteOverrides(
  route: RuntimeRoute,
  savedRoutes: RuntimeRoute[],
): RuntimeRoute {
  const savedRoute = savedRoutes.find((item) => item.id === route.id);
  if (!savedRoute || !isRenamedRoute(savedRoute)) return route;
  return {
    ...route,
    metadata: {
      ...route.metadata,
      assistantName: savedRoute.metadata?.assistantName,
      renamedBy: "user",
      renamedAt: savedRoute.metadata?.renamedAt,
    },
  };
}

export function defaultRoutes(profileId: string): RuntimeRoute[] {
  return [
    {
      id: "codex",
      profileId,
      connectorId: "codex-bridge",
      priority: 900,
      terminal: true,
      match: {
        kind: "text",
        textCommands: [],
      },
      metadata: {
        assistantName: "codex",
        systemPrompt:
          "Codex bridge：本地 Codex 连接能力，通过大助手 /cd codex 进入。",
        builtIn: true,
      },
    },
    createClaudeRouteDefinition(profileId),
    {
      id: "main-assistant-default",
      profileId,
      connectorId: "main-assistant",
      priority: -100,
      terminal: true,
      metadata: {
        systemPrompt: "默认入口：普通对话、route 分发、固定 slash 命令。",
      },
    },
  ];
}

export function routeName(route: RuntimeRoute): string {
  const name = route.metadata?.assistantName;
  return typeof name === "string" && name.trim()
    ? name
    : route.id === "main-assistant-default"
      ? "大助手"
      : route.id;
}

export function routeDescription(route: RuntimeRoute): string {
  const prompt = route.metadata?.systemPrompt;
  if (typeof prompt === "string" && prompt.trim()) return prompt;
  if (route.id === "main-assistant-default") {
    return "默认入口：普通对话、route 分发、固定 slash 命令。";
  }
  return "Runtime route";
}

export function routeMatchText(route: RuntimeRoute): string[] {
  if (route.id === "main-assistant-default") {
    return ["fallback", "/help", "/ls", "/rename", "/cd"];
  }

  const textCommands = route.match?.textCommands;
  if (textCommands) {
    return Array.isArray(textCommands) ? textCommands : [textCommands];
  }

  const textIncludes = route.match?.textIncludes;
  return Array.isArray(textIncludes)
    ? textIncludes
    : textIncludes
      ? [textIncludes]
      : ["fallback"];
}
