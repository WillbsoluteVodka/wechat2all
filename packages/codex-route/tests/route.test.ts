import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_CONNECTOR_ID,
  CODEX_DASHBOARD,
  CODEX_ROUTE_ID,
  codexRouteConfigExtension,
  createCodexRouteDefinition,
  routePackage,
} from "../src/index.js";

test("Codex route definition is owned by the route package", () => {
  const route = createCodexRouteDefinition("profile-1");

  assert.equal(route.id, CODEX_ROUTE_ID);
  assert.equal(route.connectorId, CODEX_CONNECTOR_ID);
  assert.equal(route.profileId, "profile-1");
  assert.equal(route.terminal, true);
  assert.equal(routePackage.manifest.packageName, "@wechat2all/codex-route");
  const dashboardManagement = CODEX_DASHBOARD.management;
  assert.ok(dashboardManagement);
  assert.equal(dashboardManagement.setupCheck, true);
  assert.deepEqual(dashboardManagement.configControls?.[0], {
    configKey: "codex",
    field: "delivery",
    label: "MODE",
    values: [
      {
        value: "gui-automation",
        label: "GUI AUTOMATION",
        title: "Drive Codex Desktop first, then fall back to app-server",
      },
      {
        value: "app-server",
        label: "APP SERVER",
        title: "Use the local Codex app-server directly",
      },
    ],
  });
  assert.ok(dashboardManagement.commands?.some((command) => command.rule === "/new"));
  assert.ok(dashboardManagement.commands?.some((command) => command.rule === "/recover"));
});

test("Codex route config extension owns delivery validation and snapshot", () => {
  assert.deepEqual(
    codexRouteConfigExtension.parsePatch({ delivery: "app-server" }),
    { delivery: "app-server" },
  );
  assert.deepEqual(
    codexRouteConfigExtension.snapshot({ WECHAT2ALL_CODEX_DELIVERY: "app-server" }),
    { delivery: "app-server" },
  );
  assert.throws(
    () => codexRouteConfigExtension.parsePatch({ delivery: "desktop-ipc" }),
    /must be one of/,
  );
});
