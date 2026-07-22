import assert from "node:assert/strict";
import test from "node:test";
import { createCodexRouteDefinition } from "@wechat2all/codex-route";
import { createClaudeRouteDefinition } from "@wechat2all/claude-route";
import { createOfficeRouteDefinition } from "@wechat2all/office-route";

import {
  applySavedRouteOverrides,
  defaultRoutes,
} from "../src/routes.js";

test("default routes expose isolated built-in apps before the main fallback", () => {
  const routes = defaultRoutes("profile-1", [
    createCodexRouteDefinition("profile-1"),
    createClaudeRouteDefinition("profile-1"),
    createOfficeRouteDefinition("profile-1"),
  ]);

  assert.deepEqual(routes.map((route) => route.id), [
    "codex",
    "claude",
    "office",
    "main-assistant-default",
  ]);
  const claude = routes.find((route) => route.id === "claude");
  assert.equal(claude?.profileId, "profile-1");
  assert.equal(claude?.connectorId, "claude-route");
  assert.equal(claude?.terminal, true);
  assert.equal(claude?.metadata?.builtIn, true);
  assert.deepEqual(claude?.match?.textCommands, []);
  assert.equal(routes.at(-1)?.connectorId, "main-assistant");
});

test("a saved user rename applies to an installed route without replacing its connector", () => {
  const claude = defaultRoutes("profile-1", [
    createClaudeRouteDefinition("profile-1"),
  ]).find((route) => route.id === "claude");
  assert.ok(claude);

  const renamed = applySavedRouteOverrides(claude, [{
    ...claude,
    connectorId: "untrusted-connector",
    metadata: {
      ...claude.metadata,
      assistantName: "我的 Claude",
      renamedBy: "user",
      renamedAt: "2026-07-16T00:00:00.000Z",
    },
  }]);

  assert.equal(renamed.connectorId, "claude-route");
  assert.equal(renamed.metadata?.assistantName, "我的 Claude");
  assert.equal(renamed.metadata?.renamedBy, "user");
});
