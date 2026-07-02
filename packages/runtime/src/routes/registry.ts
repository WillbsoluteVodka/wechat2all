import type { RuntimeRoute, RuntimeRouteManager } from "../types.js";

export interface RuntimeRouteRegistryOptions {
  routes?: RuntimeRoute[];
  onChange?: (routes: RuntimeRoute[]) => void | Promise<void>;
}

function cloneRoute(route: RuntimeRoute): RuntimeRoute {
  return {
    ...route,
    match: route.match ? { ...route.match } : undefined,
    metadata: route.metadata ? { ...route.metadata } : undefined,
  };
}

export function validateRuntimeRoute(route: RuntimeRoute): void {
  if (!route.id.trim()) {
    throw new Error("Runtime route id is required.");
  }
  if (!route.connectorId.trim()) {
    throw new Error(`Runtime route "${route.id}" requires connectorId.`);
  }
  if (route.priority !== undefined && !Number.isFinite(route.priority)) {
    throw new Error(`Runtime route "${route.id}" has invalid priority.`);
  }
}

function conversationRouteKey(profileId: string, conversationId: string): string {
  return `${profileId}\u0000${conversationId}`;
}

export class RuntimeRouteRegistry implements RuntimeRouteManager {
  private routes: RuntimeRoute[] = [];
  private conversationRoutes = new Map<string, string>();
  private onChange?: RuntimeRouteRegistryOptions["onChange"];

  constructor(opts: RuntimeRouteRegistryOptions = {}) {
    this.onChange = opts.onChange;
    for (const route of opts.routes ?? []) {
      this.addRoute(route, { notify: false });
    }
  }

  private notify(): void {
    if (!this.onChange) return;
    void Promise.resolve(this.onChange(this.listRoutes())).catch(() => {
      // Route change persistence errors are surfaced by the caller's callback.
    });
  }

  addRoute(route: RuntimeRoute, opts: { notify?: boolean } = {}): void {
    validateRuntimeRoute(route);
    if (this.routes.some((existing) => existing.id === route.id)) {
      throw new Error(`Route already registered: ${route.id}`);
    }
    this.routes.push({ ...cloneRoute(route), enabled: route.enabled ?? true });
    if (opts.notify !== false) this.notify();
  }

  upsertRoute(route: RuntimeRoute): void {
    validateRuntimeRoute(route);
    const normalized = { ...cloneRoute(route), enabled: route.enabled ?? true };
    const index = this.routes.findIndex((existing) => existing.id === route.id);
    if (index >= 0) {
      this.routes[index] = normalized;
    } else {
      this.routes.push(normalized);
    }
    this.notify();
  }

  removeRoute(routeId: string): boolean {
    const before = this.routes.length;
    this.routes = this.routes.filter((route) => route.id !== routeId);
    const removed = this.routes.length !== before;
    if (removed) {
      for (const [key, activeRouteId] of this.conversationRoutes.entries()) {
        if (activeRouteId === routeId) this.conversationRoutes.delete(key);
      }
      this.notify();
    }
    return removed;
  }

  replaceRoutes(routes: RuntimeRoute[]): void {
    const seen = new Set<string>();
    for (const route of routes) {
      validateRuntimeRoute(route);
      if (seen.has(route.id)) {
        throw new Error(`Duplicate route id: ${route.id}`);
      }
      seen.add(route.id);
    }
    this.routes = routes.map((route) => ({
      ...cloneRoute(route),
      enabled: route.enabled ?? true,
    }));
    this.notify();
  }

  listRoutes(): RuntimeRoute[] {
    return this.routes.map(cloneRoute);
  }

  setConversationRoute(
    profileId: string,
    conversationId: string,
    routeId: string,
  ): void {
    if (!this.routes.some((route) => route.id === routeId)) {
      throw new Error(`Cannot cd into unknown route: ${routeId}`);
    }
    this.conversationRoutes.set(
      conversationRouteKey(profileId, conversationId),
      routeId,
    );
  }

  clearConversationRoute(profileId: string, conversationId: string): boolean {
    return this.conversationRoutes.delete(
      conversationRouteKey(profileId, conversationId),
    );
  }

  getConversationRoute(
    profileId: string,
    conversationId: string,
  ): string | undefined {
    return this.conversationRoutes.get(
      conversationRouteKey(profileId, conversationId),
    );
  }
}
