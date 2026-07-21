import type {
  RouteModuleV1,
  RuntimeConnector,
  RuntimeRoute,
} from "@wechat2all/route-sdk";

import {
  codexBackend,
  createCodexBridgeFromEnv,
  getCodexSetupCheckSnapshot,
  refreshCodexSetupCheck,
  startCodexRouteAfterHostStartup,
  type CodexSetupCheckSnapshot,
} from "./backend.js";
import {
  createCodexConnector,
  parseCodexReplyMode,
} from "./connector.js";
import {
  CODEX_CONNECTOR_ID,
  CODEX_DASHBOARD,
  CODEX_ROUTE_ID,
  createCodexRouteDefinition,
} from "./route.js";
import {
  codexRouteConfigExtension,
  type CodexRouteConfigExtension,
} from "./config.js";

export interface CodexRouteModule extends RouteModuleV1 {
  id: typeof CODEX_ROUTE_ID;
  connectorId: typeof CODEX_CONNECTOR_ID;
  connector: RuntimeConnector;
  route: RuntimeRoute;
  backend: string;
  config: CodexRouteConfigExtension;
  setupCheck: {
    snapshot(): CodexSetupCheckSnapshot;
    refresh(env?: NodeJS.ProcessEnv): Promise<CodexSetupCheckSnapshot>;
  };
  lifecycle: {
    start(): Promise<void>;
  };
}

export interface CreateCodexRouteModuleOptions {
  profileId: string;
  env?: NodeJS.ProcessEnv;
  processingReminderMs?: number;
  operationTimeoutMs?: number;
}

/**
 * Creates the complete Codex route unit consumed by the host router.
 * The host does not need to know how the bridge or connector is assembled.
 */
export function createCodexRouteModule(
  opts: CreateCodexRouteModuleOptions,
): CodexRouteModule {
  const env = opts.env ?? process.env;
  return {
    id: CODEX_ROUTE_ID,
    connectorId: CODEX_CONNECTOR_ID,
    connector: createCodexConnector({
      id: CODEX_CONNECTOR_ID,
      client: createCodexBridgeFromEnv({ env }),
      replyMode: parseCodexReplyMode(env.WECHAT2ALL_CODEX_REPLY_MODE),
      processingReminderMs: opts.processingReminderMs,
      operationTimeoutMs: opts.operationTimeoutMs,
    }),
    route: createCodexRouteDefinition(opts.profileId),
    backend: codexBackend(env),
    dashboard: CODEX_DASHBOARD,
    config: codexRouteConfigExtension,
    setupCheck: {
      snapshot: getCodexSetupCheckSnapshot,
      refresh: refreshCodexSetupCheck,
    },
    lifecycle: {
      start: () => startCodexRouteAfterHostStartup(env),
    },
  };
}
