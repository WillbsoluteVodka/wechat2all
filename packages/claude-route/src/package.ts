import {
  defineRoutePackageV1,
  type RouteManifestV1,
} from "@wechat2all/route-sdk";

import { createClaudeRouteConnectorFromEnv } from "./connector.js";
import {
  CLAUDE_CONNECTOR_ID,
  CLAUDE_DASHBOARD,
  CLAUDE_ROUTE_ID,
  createClaudeRouteDefinition,
} from "./route.js";

export const CLAUDE_ROUTE_MANIFEST: RouteManifestV1 = {
  protocol: "weconnect.route",
  protocolVersion: 1,
  id: CLAUDE_ROUTE_ID,
  packageName: "@wechat2all/claude-route",
  displayName: "Claude",
  version: "0.1.0",
  description: "Claude Agent SDK route for a local workspace or Obsidian vault.",
  license: "MIT",
  engines: { weconnect: ">=0.1.0 <2", node: ">=20" },
  capabilities: ["text-input", "media-input", "text-output", "media-output"],
  permissions: [
    {
      name: "network",
      reason: "Call the configured Anthropic API through the Claude Agent SDK.",
    },
    {
      name: "filesystem:read",
      reason: "Read the user-configured workspace and input attachments.",
    },
    {
      name: "filesystem:write",
      reason: "Persist session state and write files requested by the user.",
    },
    {
      name: "process:spawn",
      reason: "Run the Claude Agent SDK executable and its approved tools.",
    },
  ],
};

export const routePackage = defineRoutePackageV1({
  protocol: "weconnect.route",
  protocolVersion: 1,
  manifest: CLAUDE_ROUTE_MANIFEST,
  create(context) {
    return {
      id: CLAUDE_ROUTE_ID,
      connectorId: CLAUDE_CONNECTOR_ID,
      connector: createClaudeRouteConnectorFromEnv({
        id: CLAUDE_CONNECTOR_ID,
        stateDir: context.storageDir,
        env: context.env as NodeJS.ProcessEnv,
        onError(error, operationContext) {
          context.logger.error(error.message, {
            operation: operationContext.operation,
            conversationId: operationContext.message.conversationId,
          });
        },
      }),
      route: createClaudeRouteDefinition(context.profileId),
      backend: "claude-agent-sdk",
      dashboard: CLAUDE_DASHBOARD,
    };
  },
});

export default routePackage;
