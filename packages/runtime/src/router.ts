import type { RuntimeMessage, RuntimeRoute, RuntimeRouteMatch } from "./types.js";

function arrayIncludes<T>(value: T | T[] | undefined, actual: T): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) ? value.includes(actual) : value === actual;
}

function textMatches(text: string | undefined, matcher: string | string[] | undefined): boolean {
  if (matcher === undefined) return true;
  if (!text) return false;
  const haystack = text.toLowerCase();
  const values = Array.isArray(matcher) ? matcher : [matcher];
  return values.some((value) => haystack.includes(value.toLowerCase()));
}

function textCommandMatches(
  text: string | undefined,
  commands: string | string[] | undefined,
): boolean {
  if (commands === undefined) return true;
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  const values = Array.isArray(commands) ? commands : [commands];
  return values.some((command) => {
    const normalizedCommand = command.trim().toLowerCase();
    return normalized === normalizedCommand ||
      normalized.startsWith(`${normalizedCommand} `);
  });
}

export function routeMatchesMessage(
  route: RuntimeRoute,
  message: RuntimeMessage,
): boolean {
  if (route.enabled === false) return false;
  if (route.profileId !== undefined && route.profileId !== message.profileId) {
    return false;
  }

  const match: RuntimeRouteMatch = route.match ?? {};
  if (match.conversationId !== undefined && match.conversationId !== message.conversationId) {
    return false;
  }
  if (match.senderId !== undefined && match.senderId !== message.senderId) {
    return false;
  }
  if (!arrayIncludes(match.kind, message.kind)) return false;
  if (!textMatches(message.text, match.textIncludes)) return false;
  if (!textCommandMatches(message.text, match.textCommands)) return false;
  return true;
}

export function findMatchingRoutes(
  routes: RuntimeRoute[],
  message: RuntimeMessage,
): RuntimeRoute[] {
  const sorted = routes
    .filter((route) => routeMatchesMessage(route, message))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const matched: RuntimeRoute[] = [];
  for (const route of sorted) {
    matched.push(route);
    if (route.terminal) break;
  }
  return matched;
}
