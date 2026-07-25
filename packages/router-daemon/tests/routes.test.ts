import assert from "node:assert/strict";
import test from "node:test";

import {
  applySavedRouteOverrides,
  defaultRoutes,
} from "../src/routes.js";

function installedRoute() {
  return {
    id: "community-test",
    profileId: "profile-1",
    connectorId: "community-test-connector",
    priority: 850,
    terminal: true,
    match: { kind: "text" as const, textCommands: [] },
    metadata: {
      assistantName: "community-test",
      community: true,
    },
  };
}

test("default routes expose installed routes before the main fallback", () => {
  const routes = defaultRoutes("profile-1", [
    installedRoute(),
  ]);

  assert.deepEqual(routes.map((route) => route.id), [
    "community-test",
    "main-assistant-default",
  ]);
  const installed = routes.find((route) => route.id === "community-test");
  assert.equal(installed?.profileId, "profile-1");
  assert.equal(installed?.connectorId, "community-test-connector");
  assert.equal(installed?.terminal, true);
  assert.equal(installed?.metadata?.community, true);
  assert.deepEqual(installed?.match?.textCommands, []);
  assert.equal(routes.at(-1)?.connectorId, "main-assistant");
});

test("a saved user rename applies to an installed route without replacing its connector", () => {
  const route = defaultRoutes("profile-1", [
    installedRoute(),
  ]).find((item) => item.id === "community-test");
  assert.ok(route);

  const renamed = applySavedRouteOverrides(route, [{
    ...route,
    connectorId: "untrusted-connector",
    metadata: {
      ...route.metadata,
      assistantName: "我的 Community Route",
      renamedBy: "user",
      renamedAt: "2026-07-16T00:00:00.000Z",
    },
  }]);

  assert.equal(renamed.connectorId, "community-test-connector");
  assert.equal(renamed.metadata?.assistantName, "我的 Community Route");
  assert.equal(renamed.metadata?.renamedBy, "user");
});
