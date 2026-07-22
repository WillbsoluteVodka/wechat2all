import type { AgentSummary, PageKey, RouteSummary } from "../types";

export const pages: Array<{ key: PageKey; label: string; hint: string }> = [
  { key: "home", label: "Home", hint: "anomaly field" },
  { key: "config", label: "Config", hint: "QR + local settings" },
  { key: "routes", label: "Routes", hint: "routing matrix" },
  { key: "community", label: "Community", hint: "route marketplace" },
  { key: "trace", label: "Trace", hint: "signal memory" },
];

export const MAIN_ASSISTANT_DISPLAY_NAME = "WeConnect助手";

export const HOME_INTRO_COPY = [
  {
    lang: "en",
    text: "WeConnect sits in front of the local WeChat runtime, catches each incoming message, and routes it to the right local assistant without leaving this machine.",
  },
  {
    lang: "zh-CN",
    text: "WeConnect 在本地微信运行时前方接收每条消息，并把它路由到合适的本地助手，全程不离开这台机器。",
  },
];

export function displayRouteName(route: Pick<RouteSummary, "id" | "name">) {
  return route.id === "main-assistant-default" || route.name === "大助手"
    ? MAIN_ASSISTANT_DISPLAY_NAME
    : route.name;
}

export function displayAgentName(agent: Pick<AgentSummary, "id" | "name">) {
  return agent.id === "main-assistant" || agent.name === "大助手"
    ? MAIN_ASSISTANT_DISPLAY_NAME
    : agent.name;
}

export interface RouteRuleDetail {
  rule: string;
  description: string;
}

const WECONNECT_ROUTE_RULES: RouteRuleDetail[] = [
  { rule: "/help", description: "展示所有命令和功能" },
  { rule: "/ls", description: "展示当前所有可用 routes" },
  { rule: "/rename <新名字>", description: "重命名当前 route" },
  { rule: "/cd <route>", description: "进入某个 route" },
  { rule: "/cd ..", description: "从二级 route 返回大助手" },
];

function describeMatchRule(rule: string) {
  const descriptions: Record<string, string> = {
    fallback: "Handles messages that do not match another route.",
    "/help": "Shows the available commands and route actions.",
    "/ls": "Lists the routes available to the current assistant.",
    "/rename": "Renames the current route.",
    "/cd": "Switches the conversation to another route.",
    "/sales": "Sends the message to the sales route.",
  };

  if (descriptions[rule]) return descriptions[rule];
  if (rule.startsWith("/")) return `Runs the ${rule} route command.`;
  return `Matches messages containing “${rule}”.`;
}

export function routeRuleDetails(route: RouteSummary): RouteRuleDetail[] {
  if (route.id === "main-assistant-default" || route.name === "大助手") {
    return WECONNECT_ROUTE_RULES;
  }
  if (route.management?.commands?.length) return route.management.commands;
  return route.matchText.map((rule) => ({ rule, description: describeMatchRule(rule) }));
}
