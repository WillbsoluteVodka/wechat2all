import { createLLMProviderFromEnv } from "@wechat2all/runtime";
import { defineRoutePackageV1, type RouteManifestV1 } from "@wechat2all/route-sdk";

import { createOfficeCliRunner } from "./cli.js";
import { createOfficeRouteConnector } from "./connector.js";
import {
  OFFICE_CONNECTOR_ID,
  OFFICE_DASHBOARD,
  OFFICE_ROUTE_ID,
  createOfficeRouteDefinition,
} from "./route.js";
import { createOfficeSetupCheck } from "./setup.js";

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function llmConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  const provider = env.WECHAT2ALL_LLM_PROVIDER;
  return (provider === undefined || provider === "openai-compatible")
    && Boolean(env.WECHAT2ALL_LLM_API_KEY && env.WECHAT2ALL_LLM_MODEL);
}

export const OFFICE_ROUTE_MANIFEST: RouteManifestV1 = {
  protocol: "weconnect.route",
  protocolVersion: 1,
  id: OFFICE_ROUTE_ID,
  packageName: "@wechat2all/office-route",
  displayName: "Office",
  version: "0.1.0",
  description: "Independent LLM-powered Word, Excel, and PowerPoint route using OfficeCLI.",
  license: "MIT",
  engines: { weconnect: ">=0.1.0 <2", node: ">=20" },
  capabilities: ["text-input", "media-input", "text-output", "media-output", "setup-check"],
  permissions: [
    { name: "network", reason: "Use the WeConnect LLM provider configured by WECHAT2ALL_LLM_* variables." },
    { name: "filesystem:read", reason: "Read user-provided Office documents and assets inside the private route workspace." },
    { name: "filesystem:write", reason: "Create and edit Office documents inside the private route workspace." },
    { name: "process:spawn", reason: "Run the OfficeCLI binary with validated arguments and no shell." },
  ],
};

export const routePackage = defineRoutePackageV1({
  protocol: "weconnect.route",
  protocolVersion: 1,
  manifest: OFFICE_ROUTE_MANIFEST,
  create(context) {
    const configured = llmConfigured(context.env);
    const cli = createOfficeCliRunner({
      executable: context.env.WECHAT2ALL_OFFICECLI_EXECUTABLE,
      env: context.env,
    });
    const setupCheck = createOfficeSetupCheck({ cli, llmConfigured: configured });
    return {
      id: OFFICE_ROUTE_ID,
      connectorId: OFFICE_CONNECTOR_ID,
      connector: createOfficeRouteConnector({
        id: OFFICE_CONNECTOR_ID,
        config: {
          storageDir: context.storageDir,
          llm: createLLMProviderFromEnv({ env: context.env }),
          cli,
          llmConfigured: configured,
          maxTurns: positiveNumber(context.env.WECHAT2ALL_OFFICE_MAX_TURNS, 12),
          maxCommandsPerTurn: positiveNumber(context.env.WECHAT2ALL_OFFICE_MAX_COMMANDS_PER_TURN, 12),
          commandTimeoutMs: positiveNumber(context.env.WECHAT2ALL_OFFICE_COMMAND_TIMEOUT_MS, 120_000),
          maxMediaBytes: positiveNumber(context.env.WECHAT2ALL_OFFICE_MAX_MEDIA_MB, 50) * 1024 * 1024,
          maxOutputChars: positiveNumber(context.env.WECHAT2ALL_OFFICE_MAX_OUTPUT_CHARS, 24_000),
        },
        onError(error, operation) {
          context.logger.error(error.message, {
            operation: operation.operation,
            conversationId: operation.message.conversationId,
          });
        },
      }),
      route: createOfficeRouteDefinition(context.profileId),
      backend: "weconnect-llm+officecli",
      setupCheck,
      dashboard: OFFICE_DASHBOARD,
      lifecycle: {
        start() {
          void setupCheck.refresh().catch((error: unknown) => {
            context.logger.warn("Office setup check failed.", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
      },
    };
  },
});

export default routePackage;
