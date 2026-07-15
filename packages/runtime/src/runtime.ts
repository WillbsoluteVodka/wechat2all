import { EventEmitter } from "node:events";

import type { MonitorOptions, WeChatClient, WeixinMessage } from "wechat2all";

import {
  RuntimeActionQueue,
  type RuntimeActionExecutorOptions,
} from "./actions.js";
import {
  InMemoryRuntimeMessageDeduper,
  type RuntimeMessageDeduper,
} from "./dedupe.js";
import { createMemoryMessage, InMemoryMemoryStore } from "./storage/memory.js";
import { normalizeWeixinMessage } from "./normalize.js";
import { ProfileRegistry } from "./profiles.js";
import { findMatchingRoutes } from "./router.js";
import { RuntimeRouteRegistry } from "./routes/registry.js";
import type { RuntimeMediaPipeline } from "./media/pipeline.js";
import type { RuntimeTTSProvider } from "./media/tts.js";
import type {
  MemoryScope,
  MemoryStore,
  RuntimeAction,
  RuntimeActionResult,
  RuntimeConnector,
  RuntimeEventMap,
  RuntimeMessage,
  RuntimeProfileConfig,
  RuntimeProfileState,
  RuntimeRoute,
  RuntimeRouteManager,
} from "./types.js";

export interface WeChatRuntimeOptions {
  profiles?: RuntimeProfileConfig[];
  connectors?: RuntimeConnector[];
  routes?: RuntimeRoute[];
  memory?: MemoryStore;
  monitor?: Omit<MonitorOptions, "loadSyncBuf" | "saveSyncBuf">;
  deduper?: RuntimeMessageDeduper;
  actionQueue?: RuntimeActionQueue;
  actionExecutor?: RuntimeActionExecutorOptions;
  media?: RuntimeMediaPipeline;
  tts?: RuntimeTTSProvider;
}

type Listener<T extends unknown[]> = (...args: T) => void;

function withDefaultContextToken(
  action: RuntimeAction,
  contextToken: string | undefined,
): RuntimeAction {
  if (!contextToken || action.type === "noop" || action.contextToken) {
    return action;
  }
  return { ...action, contextToken };
}

function conversationRouteKey(profileId: string, conversationId: string): string {
  return `${profileId}\u0000${conversationId}`;
}

function routeCanReceiveConversation(
  route: RuntimeRoute,
  profileId: string,
): boolean {
  if (route.enabled === false) return false;
  return route.profileId === undefined || route.profileId === profileId;
}

export class WeChatRuntime extends EventEmitter implements RuntimeRouteManager {
  private profiles = new ProfileRegistry();
  private connectors = new Map<string, RuntimeConnector>();
  private routes: RuntimeRouteRegistry;
  private conversationRoutes = new Map<string, string>();
  readonly memory: MemoryStore;
  readonly deduper: RuntimeMessageDeduper;
  readonly actionQueue: RuntimeActionQueue;
  readonly media?: RuntimeMediaPipeline;
  readonly tts?: RuntimeTTSProvider;
  private actionExecutorOptions: RuntimeActionExecutorOptions;
  private monitorOptions: Omit<MonitorOptions, "loadSyncBuf" | "saveSyncBuf">;

  constructor(opts: WeChatRuntimeOptions = {}) {
    super();
    this.memory = opts.memory ?? new InMemoryMemoryStore();
    this.media = opts.media;
    this.tts = opts.tts;
    this.deduper = opts.deduper ?? new InMemoryRuntimeMessageDeduper();
    this.actionExecutorOptions = {
      continueOnError: true,
      maxAttempts: 2,
      retryDelayMs: 250,
      dedupeWindowMs: 0,
      ...opts.actionExecutor,
    };
    this.actionQueue = opts.actionQueue ?? new RuntimeActionQueue(
      this.actionExecutorOptions,
    );
    this.monitorOptions = opts.monitor ?? { sessionExpiredBehavior: "stop" };
    this.routes = new RuntimeRouteRegistry({
      routes: opts.routes,
      onChange: (routes) => {
        this.emit("routesChanged", routes);
      },
    });

    for (const profile of opts.profiles ?? []) {
      this.createProfile(profile);
    }
    for (const connector of opts.connectors ?? []) {
      this.registerConnector(connector);
    }
  }

  override on<K extends keyof RuntimeEventMap>(
    eventName: K,
    listener: Listener<RuntimeEventMap[K]>,
  ): this {
    return super.on(eventName, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof RuntimeEventMap>(
    eventName: K,
    ...args: RuntimeEventMap[K]
  ): boolean {
    return super.emit(eventName, ...args);
  }

  createProfile(config: RuntimeProfileConfig): RuntimeProfileState {
    const profile = this.profiles.upsertProfile(config);
    return {
      id: profile.config.id,
      name: profile.config.name,
      enabled: profile.config.enabled ?? true,
      running: profile.client.isRunning(),
    };
  }

  listProfiles(): RuntimeProfileState[] {
    return this.profiles.listProfiles();
  }

  getClient(profileId: string): WeChatClient {
    return this.profiles.requireProfile(profileId).client;
  }

  registerConnector(connector: RuntimeConnector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`Connector already registered: ${connector.id}`);
    }
    this.connectors.set(connector.id, connector);
  }

  addRoute(route: RuntimeRoute): void {
    this.routes.addRoute(route);
  }

  upsertRoute(route: RuntimeRoute): void {
    this.routes.upsertRoute(route);
  }

  removeRoute(routeId: string): boolean {
    const removed = this.routes.removeRoute(routeId);
    if (removed) {
      for (const [key, activeRouteId] of this.conversationRoutes.entries()) {
        if (activeRouteId === routeId) this.conversationRoutes.delete(key);
      }
    }
    return removed;
  }

  listRoutes(): RuntimeRoute[] {
    return this.routes.listRoutes();
  }

  setConversationRoute(
    profileId: string,
    conversationId: string,
    routeId: string,
  ): void {
    const route = this.routes
      .listRoutes()
      .find((item) => item.id === routeId);
    if (!route) {
      throw new Error(`Cannot cd into unknown route: ${routeId}`);
    }
    if (!routeCanReceiveConversation(route, profileId)) {
      throw new Error(`Route is not available for profile "${profileId}": ${routeId}`);
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

  async startProfile(profileId: string, opts: MonitorOptions = {}): Promise<void> {
    const profile = this.profiles.requireProfile(profileId);
    if (profile.config.enabled === false) {
      throw new Error(`Profile is disabled: ${profileId}`);
    }

    profile.client.on("message", (msg) => {
      void this.handleWeixinMessage(profileId, msg).catch((err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)), {
          profileId,
          msg,
        });
      });
    });
    profile.client.on("error", (err) => this.emit("error", err, { profileId }));
    profile.client.on("sessionExpired", () => {
      this.emit("error", new Error(`Session expired for profile: ${profileId}`), {
        profileId,
      });
    });

    this.emit("profileStarted", {
      id: profile.config.id,
      name: profile.config.name,
      enabled: profile.config.enabled ?? true,
      running: true,
    });

    try {
      await profile.client.start({
        ...this.monitorOptions,
        ...opts,
      });
    } finally {
      this.emit("profileStopped", {
        id: profile.config.id,
        name: profile.config.name,
        enabled: profile.config.enabled ?? true,
        running: false,
      });
    }
  }

  stopProfile(profileId: string): void {
    this.profiles.requireProfile(profileId).client.stop();
  }

  /** Dispatch proactive actions through the same serialized queue as replies. */
  async dispatchActions(
    profileId: string,
    actions: RuntimeAction[],
  ): Promise<RuntimeActionResult[]> {
    const profile = this.profiles.requireProfile(profileId);
    return this.actionQueue.executeBatch({
      client: profile.client,
      actions,
      options: this.actionExecutorOptions,
    });
  }

  normalize(profileId: string, msg: WeixinMessage): RuntimeMessage {
    return normalizeWeixinMessage({ profileId, msg });
  }

  private findRoutesForMessage(message: RuntimeMessage): RuntimeRoute[] {
    const activeRouteId = this.getConversationRoute(
      message.profileId,
      message.conversationId,
    );
    if (activeRouteId) {
      const activeRoute = this.routes
        .listRoutes()
        .find((route) => route.id === activeRouteId);
      if (activeRoute && routeCanReceiveConversation(activeRoute, message.profileId)) {
        return [activeRoute];
      }
      this.clearConversationRoute(message.profileId, message.conversationId);
    }

    return findMatchingRoutes(this.routes.listRoutes(), message);
  }

  private async dispatchActionsForMessage(params: {
    client: WeChatClient;
    message: RuntimeMessage;
    memoryScope: MemoryScope;
    actions: RuntimeAction[];
  }): Promise<RuntimeActionResult[]> {
    const actionsWithContext = params.actions.map((action) =>
      withDefaultContextToken(action, params.message.replyToken?.contextToken),
    );
    const results = await this.actionQueue.executeBatch({
      client: params.client,
      actions: actionsWithContext,
      options: this.actionExecutorOptions,
    });
    this.emit("actions", params.message, results);

    for (const result of results) {
      if (result.ok && !result.deduped && result.action.type === "send_text") {
        await this.memory.appendMessage(createMemoryMessage({
          scope: params.memoryScope,
          role: "assistant",
          content: result.action.text,
          sourceMessageId: params.message.id,
        }));
      }
    }

    return results;
  }

  async handleWeixinMessage(
    profileId: string,
    msg: WeixinMessage,
  ): Promise<void> {
    const profile = this.profiles.requireProfile(profileId);
    const message = this.normalize(profileId, msg);
    if (!(await this.deduper.claim(message))) {
      this.emit("messageSkipped", message, "duplicate");
      return;
    }
    this.emit("message", message);

    const matchingRoutes = this.findRoutesForMessage(message);
    for (const route of matchingRoutes) {
      this.emit("routeMatched", message, route);
      const connector = this.connectors.get(route.connectorId);
      if (!connector) {
        this.emit("error", new Error(`Unknown connector: ${route.connectorId}`), {
          route,
          message,
        });
        continue;
      }

      const memoryScope: MemoryScope = {
        profileId,
        connectorId: connector.id,
        conversationId: message.conversationId,
      };
      if (message.text) {
        await this.memory.appendMessage(createMemoryMessage({
          scope: memoryScope,
          role: "user",
          content: message.text,
          sourceMessageId: message.id,
        }));
      }

      let actions: RuntimeAction[];
      try {
        actions = await connector.handleMessage(message, {
          profileId,
          connectorId: connector.id,
          client: profile.client,
          memory: this.memory,
          memoryScope,
          route,
          routes: this,
          media: this.media,
          tts: this.tts,
          dispatchActions: (nextActions) => this.dispatchActionsForMessage({
            client: profile.client,
            message,
            memoryScope,
            actions: nextActions,
          }),
        });
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)), {
          connectorId: connector.id,
          message,
        });
        continue;
      }

      await this.dispatchActionsForMessage({
        client: profile.client,
        message,
        memoryScope,
        actions,
      });
    }
  }
}
