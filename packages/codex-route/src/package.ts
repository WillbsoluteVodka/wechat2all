import {
  defineRoutePackageV1,
  type RouteManifestV1,
} from "@wechat2all/route-sdk";

import { createCodexRouteModule } from "./module.js";

export const CODEX_ROUTE_MANIFEST: RouteManifestV1 = {
  protocol: "weconnect.route",
  protocolVersion: 1,
  id: "codex",
  packageName: "@wechat2all/codex-route",
  displayName: "Codex",
  version: "0.1.0",
  description: "Codex Desktop GUI automation with app-server fallback.",
  license: "MIT",
  engines: {
    weconnect: ">=0.1.0 <2",
    node: ">=20",
  },
  capabilities: [
    "text-input",
    "media-input",
    "text-output",
    "media-output",
    "setup-check",
    "config",
    "lifecycle",
  ],
  permissions: [
    {
      name: "process:spawn",
      reason: "Start and self-heal the local Codex app-server process.",
    },
    {
      name: "filesystem:read",
      reason: "Forward user-selected local attachments and inspect Codex output files.",
    },
    {
      name: "filesystem:write",
      reason: "Persist the bound chat, alarm, and recovery state.",
    },
    {
      name: "network",
      reason: "Codex app-server may contact the configured model provider.",
    },
    {
      name: "macos:accessibility",
      reason: "Inject prompts into the exact Codex Desktop chat.",
    },
    {
      name: "macos:automation",
      reason: "Control ChatGPT/Codex and System Events for GUI delivery.",
    },
  ],
};

function envNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : undefined;
}

export const routePackage = defineRoutePackageV1({
  protocol: "weconnect.route",
  protocolVersion: 1,
  manifest: CODEX_ROUTE_MANIFEST,
  create(context) {
    return createCodexRouteModule({
      profileId: context.profileId,
      env: context.env as NodeJS.ProcessEnv,
      processingReminderMs: envNumber(
        context.env,
        "WECHAT2ALL_CODEX_PROCESSING_REMINDER_MS",
      ),
      operationTimeoutMs: envNumber(
        context.env,
        "WECHAT2ALL_CODEX_ROUTE_OPERATION_TIMEOUT_MS",
      ),
    });
  },
});

export default routePackage;
