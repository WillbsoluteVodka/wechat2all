import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RouteProtocolError,
  assertRouteManifestMatchesPackageV1,
  defineRoutePackageV1,
  instantiateRoutePackageV1,
  routePackageFromModuleExportsV1,
  type RouteDashboardContributionV1,
  type RouteHostContextV1,
} from "../src/index.js";

const context: RouteHostContextV1 = {
  profileId: "default",
  env: {},
  storageDir: "/tmp/community-echo",
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
};

function validPackage() {
  return defineRoutePackageV1({
    protocol: "weconnect.route",
    protocolVersion: 1,
    manifest: {
      protocol: "weconnect.route",
      protocolVersion: 1,
      id: "community-echo",
      packageName: "@example/weconnect-route-echo",
      displayName: "Echo",
      version: "1.0.0",
      description: "Echo route",
      engines: { weconnect: ">=0.1.0" },
      capabilities: ["text-input", "text-output"],
      permissions: [],
    },
    create(host) {
      return {
        id: "community-echo",
        connectorId: "community-echo-connector",
        connector: {
          id: "community-echo-connector",
          handleMessage: () => [],
        },
        route: {
          id: "community-echo",
          profileId: host.profileId,
          connectorId: "community-echo-connector",
        },
        dashboard: {
          management: {
            commands: [{ rule: "/echo", description: "Echo" }],
          },
        },
      };
    },
  });
}

test("defines, loads, and instantiates a protocol v1 route package", () => {
  const routePackage = routePackageFromModuleExportsV1({ routePackage: validPackage() });
  const instance = instantiateRoutePackageV1(routePackage, context);

  assert.equal(instance.id, "community-echo");
  assert.equal(instance.route.profileId, "default");
  assert.deepEqual(instance.route.metadata?.routePackage, {
    protocol: "weconnect.route",
    protocolVersion: 1,
    packageName: "@example/weconnect-route-echo",
    packageVersion: "1.0.0",
    displayName: "Echo",
    capabilities: ["text-input", "text-output"],
    permissions: [],
  });
  assert.deepEqual(instance.manifest, routePackage.manifest);
  assert.deepEqual(
    instance.route.metadata?.dashboardManagement,
    instance.dashboard?.management,
  );
});

test("preserves generic config controls and legacy values-only selects", () => {
  const dashboard = {
    management: {
      configControls: [
        {
          configKey: "example",
          field: "legacyMode",
          label: "LEGACY MODE",
          values: [
            { value: "fast", label: "FAST", title: "Use fast mode" },
            { value: "safe", label: "SAFE" },
          ],
        },
        {
          configKey: "example",
          field: "workspace",
          label: "WORKSPACE",
          kind: "text",
          placeholder: "/absolute/path",
          description: "Workspace used by the route.",
          clearable: true,
        },
        {
          configKey: "example",
          field: "apiKey",
          label: "API KEY",
          kind: "secret",
          clearable: true,
        },
        {
          configKey: "example",
          field: "maxTurns",
          label: "MAX TURNS",
          kind: "number",
          placeholder: "40",
        },
        {
          configKey: "example",
          field: "language",
          label: "LANGUAGE",
          kind: "select",
          values: [{ value: "zh", label: "中文" }],
        },
      ],
    },
  } satisfies RouteDashboardContributionV1;
  const base = validPackage();
  const routePackage = defineRoutePackageV1({
    ...base,
    create(host: RouteHostContextV1) {
      return {
        ...base.create(host),
        config: {
          key: "example",
          fields: {
            legacyMode: "EXAMPLE_LEGACY_MODE",
            workspace: "EXAMPLE_WORKSPACE",
            apiKey: "EXAMPLE_API_KEY",
            maxTurns: "EXAMPLE_MAX_TURNS",
            language: "EXAMPLE_LANGUAGE",
          },
          parsePatch: () => ({}),
          snapshot: () => ({}),
        },
        dashboard,
      };
    },
  });

  const instance = instantiateRoutePackageV1(routePackage, context);

  assert.deepEqual(
    instance.route.metadata?.dashboardManagement,
    dashboard.management,
  );
  assert.equal(
    dashboard.management.configControls[0]?.kind,
    undefined,
  );
});

test("rejects config controls outside the route's own config boundary", () => {
  const base = validPackage();
  const packageWithControl = (
    control: unknown,
    includeConfig = true,
  ) => ({
    ...base,
    create(host: RouteHostContextV1) {
      return {
        ...base.create(host),
        ...(includeConfig
          ? {
              config: {
                key: "example",
                fields: { mode: "EXAMPLE_MODE" },
                parsePatch: () => ({}),
                snapshot: () => ({}),
              },
            }
          : {}),
        dashboard: {
          management: {
            configControls: [control],
          },
        } as RouteDashboardContributionV1,
      };
    },
  });
  const validControl = {
    configKey: "example",
    field: "mode",
    label: "MODE",
    values: [],
  };

  assert.doesNotThrow(() =>
    instantiateRoutePackageV1(packageWithControl(validControl), context)
  );
  assert.throws(
    () => instantiateRoutePackageV1(packageWithControl({
      ...validControl,
      configKey: "llm",
      field: "apiKey",
    }), context),
    (error) =>
      error instanceof RouteProtocolError
      && error.code === "invalid-module"
      && error.path === "dashboard.management.configControls.0.configKey",
  );
  assert.throws(
    () => instantiateRoutePackageV1(packageWithControl({
      ...validControl,
      field: "undeclared",
    }), context),
    (error) =>
      error instanceof RouteProtocolError
      && error.code === "invalid-module"
      && error.path === "dashboard.management.configControls.0.field",
  );
  assert.throws(
    () => instantiateRoutePackageV1(
      packageWithControl(validControl, false),
      context,
    ),
    (error) =>
      error instanceof RouteProtocolError
      && error.code === "invalid-module"
      && error.path === "dashboard.management.configControls.0.configKey",
  );
});

test("rejects malformed dashboard management and config controls", () => {
  const base = validPackage();
  const packageWithDashboard = (dashboard: unknown) => ({
    ...base,
    create(host: RouteHostContextV1) {
      return {
        ...base.create(host),
        config: {
          key: "example",
          fields: { mode: "EXAMPLE_MODE" },
          parsePatch: () => ({}),
          snapshot: () => ({}),
        },
        dashboard: dashboard as RouteDashboardContributionV1,
      };
    },
  });
  const validControl = {
    configKey: "example",
    field: "mode",
    label: "MODE",
  };
  const invalidDashboards: Array<{
    dashboard: unknown;
    path: string;
  }> = [
    {
      dashboard: { management: { configControls: {} } },
      path: "dashboard.management.configControls",
    },
    {
      dashboard: {
        management: {
          configControls: [{ ...validControl, kind: "unsupported" }],
        },
      },
      path: "dashboard.management.configControls.0.kind",
    },
    {
      dashboard: {
        management: {
          configControls: [{ ...validControl, values: {} }],
        },
      },
      path: "dashboard.management.configControls.0.values",
    },
    {
      dashboard: {
        management: {
          configControls: [{
            ...validControl,
            values: [{ value: "one", label: 1 }],
          }],
        },
      },
      path: "dashboard.management.configControls.0.values.0",
    },
    {
      dashboard: {
        management: {
          configControls: [
            validControl,
            { ...validControl, label: "DUPLICATE" },
          ],
        },
      },
      path: "dashboard.management.configControls.1",
    },
    {
      dashboard: { management: { setupCheck: "yes" } },
      path: "dashboard.management.setupCheck",
    },
    {
      dashboard: { management: { manualPermissions: [{}] } },
      path: "dashboard.management.manualPermissions.0",
    },
    {
      dashboard: { management: { commands: [{ rule: "/test" }] } },
      path: "dashboard.management.commands.0",
    },
    {
      dashboard: { agent: { name: "Agent" } },
      path: "dashboard.agent.kind",
    },
  ];

  for (const { dashboard, path } of invalidDashboards) {
    assert.throws(
      () => instantiateRoutePackageV1(packageWithDashboard(dashboard), context),
      (error) =>
        error instanceof RouteProtocolError
        && error.code === "invalid-module"
        && error.path === path,
      path,
    );
  }
});

test("verifies the static marketplace manifest against the executable export", () => {
  const routePackage = validPackage();
  assert.doesNotThrow(() => assertRouteManifestMatchesPackageV1({
    $schema: "./route-manifest.v1.schema.json",
    ...routePackage.manifest,
  }, routePackage));
  assert.throws(
    () => assertRouteManifestMatchesPackageV1({
      ...routePackage.manifest,
      displayName: "Different name",
    }, routePackage),
    (error) => error instanceof RouteProtocolError && error.code === "invalid-manifest",
  );
});

test("rejects an unsupported protocol version before route code runs", () => {
  assert.throws(
    () => routePackageFromModuleExportsV1({
      routePackage: {
        ...validPackage(),
        protocolVersion: 2,
      },
    }),
    (error) => error instanceof RouteProtocolError && error.code === "unsupported-protocol",
  );
});

test("rejects module ids that do not match the signed manifest boundary", () => {
  const routePackage = validPackage();
  const invalid = {
    ...routePackage,
    create(host: RouteHostContextV1) {
      return { ...routePackage.create(host), id: "different-route" };
    },
  };
  assert.throws(
    () => instantiateRoutePackageV1(invalid, context),
    (error) => error instanceof RouteProtocolError && error.code === "invalid-module",
  );
});

test("requires permission reasons for future install approval UI", () => {
  const routePackage = validPackage();
  const invalid = {
    ...routePackage,
    manifest: {
      ...routePackage.manifest,
      permissions: [{ name: "network", reason: "" }],
    },
  };
  assert.throws(
    () => routePackageFromModuleExportsV1({ routePackage: invalid }),
    (error) => error instanceof RouteProtocolError && error.code === "invalid-manifest",
  );
});

test("validates checksummed route-private binaries and explicit install permission", () => {
  const routePackage = validPackage();
  const dependency = {
    type: "binary" as const,
    id: "officecli",
    displayName: "OfficeCLI",
    version: "1.0.139",
    executable: "officecli",
    artifacts: {
      "darwin-arm64": {
        urls: ["https://example.com/officecli-mac-arm64"],
        sha256: "a".repeat(64),
      },
    },
  };
  assert.doesNotThrow(() => routePackageFromModuleExportsV1({
    routePackage: {
      ...routePackage,
      manifest: {
        ...routePackage.manifest,
        permissions: [{ name: "dependency:install", reason: "Install a private CLI." }],
        managedDependencies: [dependency],
      },
    },
  }));
  assert.throws(
    () => routePackageFromModuleExportsV1({
      routePackage: {
        ...routePackage,
        manifest: {
          ...routePackage.manifest,
          managedDependencies: [dependency],
        },
      },
    }),
    (error) => error instanceof RouteProtocolError && error.code === "invalid-manifest",
  );
  assert.throws(
    () => routePackageFromModuleExportsV1({
      routePackage: {
        ...routePackage,
        manifest: {
          ...routePackage.manifest,
          permissions: [{ name: "dependency:install", reason: "Install a private CLI." }],
          managedDependencies: [{ ...dependency, version: "^1.0.0" }],
        },
      },
    }),
    (error) => error instanceof RouteProtocolError && error.code === "invalid-manifest",
  );
  assert.throws(
    () => routePackageFromModuleExportsV1({
      routePackage: {
        ...routePackage,
        manifest: {
          ...routePackage.manifest,
          permissions: [{
            name: "dependency:install",
            reason: "Install a private CLI.",
            optional: true,
          }],
          managedDependencies: [dependency],
        },
      },
    }),
    (error) => error instanceof RouteProtocolError && error.code === "invalid-manifest",
  );
});
