import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defineRoutePackageV1, type RoutePackageV1 } from "@wechat2all/route-sdk";

import {
  createInstalledRouteModules,
  instantiateInstalledRoutePackages,
  loadExternalRoutePackages,
  parseRoutePackageSpecifiers,
} from "../src/installed-routes.js";

function testPackage(id: string, connectorId = `${id}-connector`): RoutePackageV1 {
  return defineRoutePackageV1({
    protocol: "weconnect.route",
    protocolVersion: 1,
    manifest: {
      protocol: "weconnect.route",
      protocolVersion: 1,
      id,
      packageName: `@test/${id}`,
      displayName: id,
      version: "1.0.0",
      description: `${id} test route`,
      engines: { weconnect: ">=0.1.0" },
      capabilities: ["text-input", "text-output"],
      permissions: [],
    },
    create(context) {
      return {
        id,
        connectorId,
        connector: { id: connectorId, handleMessage: () => [] },
        route: { id, connectorId, profileId: context.profileId },
      };
    },
  });
}

test("parses and de-duplicates external package specifiers", () => {
  assert.deepEqual(
    parseRoutePackageSpecifiers("@a/one, ./two\n@a/one"),
    ["@a/one", "./two"],
  );
});

test("loads a protocol package through the standard module export", async () => {
  const source = `data:text/javascript,${encodeURIComponent(`
    export const routePackage = {
      protocol: "weconnect.route",
      protocolVersion: 1,
      manifest: {
        protocol: "weconnect.route", protocolVersion: 1, id: "loaded-route",
        packageName: "@test/loaded-route", displayName: "Loaded", version: "1.0.0",
        description: "Loaded route", engines: { weconnect: ">=0.1.0" },
        capabilities: [], permissions: []
      },
      create() { throw new Error("factory should not run during import"); }
    };
  `)}`;
  const [loaded] = await loadExternalRoutePackages([source]);
  assert.equal(loaded?.manifest.id, "loaded-route");
});

test("resolves a local package directory through its WeConnect entrypoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-directory-route-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    type: "module",
    main: "./dist/index.mjs",
    exports: { ".": "./dist/index.mjs" },
    weconnect: { routeEntrypoint: "." },
  }));
  fs.writeFileSync(path.join(root, "dist/index.mjs"), `
    export default {
      protocol: "weconnect.route", protocolVersion: 1,
      manifest: {
        protocol: "weconnect.route", protocolVersion: 1, id: "directory-route",
        packageName: "@test/directory-route", displayName: "Directory", version: "1.0.0",
        description: "Directory route", engines: { weconnect: ">=0.1.0" },
        capabilities: [], permissions: []
      },
      create() { throw new Error("not instantiated"); }
    };
  `);
  const [loaded] = await loadExternalRoutePackages([root]);
  assert.equal(loaded?.manifest.id, "directory-route");
});

test("rejects a broken external package without dropping valid packages", async () => {
  const errors: string[] = [];
  const invalid = `data:text/javascript,${encodeURIComponent("export default { nope: true };")}`;
  const valid = `data:text/javascript,${encodeURIComponent(`
    export default {
      protocol: "weconnect.route", protocolVersion: 1,
      manifest: {
        protocol: "weconnect.route", protocolVersion: 1, id: "surviving-route",
        packageName: "@test/surviving-route", displayName: "Surviving", version: "1.0.0",
        description: "Surviving route", engines: { weconnect: ">=0.1.0" },
        capabilities: [], permissions: []
      },
      create() { throw new Error("not instantiated by this test"); }
    };
  `)}`;
  const loaded = await loadExternalRoutePackages([invalid, valid], {
    onError(specifier, error) {
      errors.push(`${specifier.slice(0, 20)}:${error.message}`);
    },
  });

  assert.deepEqual(loaded.map((item) => item.manifest.id), ["surviving-route"]);
  assert.equal(errors.length, 1);
});

test("assigns private storage and rejects duplicate ids", () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-routes-"));
  const [instance] = instantiateInstalledRoutePackages(
    [testPackage("route-one")],
    "profile-1",
    {},
    { storageRoot },
  );
  assert.equal(instance?.manifest.packageName, "@test/route-one");
  assert.equal(fs.statSync(path.join(storageRoot, "route-one")).mode & 0o777, 0o700);
  assert.throws(
    () => instantiateInstalledRoutePackages(
      [testPackage("route-one"), testPackage("route-one")],
      "profile-1",
      {},
      { storageRoot },
    ),
    /Duplicate WeConnect route id/,
  );
});

test("a crashing community factory does not prevent built-in routes from loading", async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-routes-safe-"));
  const crashingPath = path.join(storageRoot, "crashing-route.mjs");
  fs.writeFileSync(crashingPath, `
    export default {
      protocol: "weconnect.route", protocolVersion: 1,
      manifest: {
        protocol: "weconnect.route", protocolVersion: 1, id: "crashing-route",
        packageName: "@test/crashing-route", displayName: "Crashing", version: "1.0.0",
        description: "Crashing route", engines: { weconnect: ">=0.1.0" },
        capabilities: [], permissions: []
      },
      create() { throw new Error("factory exploded"); }
    };
  `);
  const errors: string[] = [];
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error(message: string, context?: Record<string, unknown>) {
      errors.push(`${message}:${String(context?.error ?? "")}`);
    },
  };
  const installed = await createInstalledRouteModules(
    "profile-1",
    { WECHAT2ALL_ROUTE_PACKAGES: crashingPath },
    { storageRoot, logger },
  );

  assert.deepEqual(installed.map((item) => item.id), ["codex", "claude", "office"]);
  const codex = installed.find((item) => item.id === "codex");
  const management = codex?.route.metadata?.dashboardManagement as {
    setupCheck?: boolean;
    configControls?: unknown[];
    manualPermissions?: unknown[];
    commands?: Array<{ rule?: string }>;
  } | undefined;
  assert.equal(management?.setupCheck, true);
  assert.ok(management?.configControls?.length);
  assert.ok(management?.manualPermissions?.length);
  assert.ok(management?.commands?.some((command) => command.rule === "/status"));
  assert.match(errors.join("\n"), /factory exploded/);
});
