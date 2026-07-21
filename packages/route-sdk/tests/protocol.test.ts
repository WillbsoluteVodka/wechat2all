import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RouteProtocolError,
  assertRouteManifestMatchesPackageV1,
  defineRoutePackageV1,
  instantiateRoutePackageV1,
  routePackageFromModuleExportsV1,
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
