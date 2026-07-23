import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RouteManifestV1 } from "@wechat2all/route-sdk";

import {
  CommunityService,
  resolveCommunityRoot,
  versionSatisfies,
  type CommunityOperation,
} from "../src/community.js";
import { handleCommunityHttpRequest } from "../src/community-http.js";
import { readCommunityInstalledRegistry } from "../src/community-registry.js";
import { createInstalledRouteModules } from "../src/installed-routes.js";

function manifest(
  version = "1.0.0",
  permissions: RouteManifestV1["permissions"] = [],
): RouteManifestV1 {
  return {
    protocol: "weconnect.route",
    protocolVersion: 1,
    id: "test-community",
    packageName: "@test/community-route",
    displayName: "Test Community",
    version,
    description: "A Community installer test route.",
    engines: { weconnect: ">=0.1.0 <2", node: ">=20" },
    capabilities: ["text-input", "text-output"],
    permissions,
  };
}

function writeRoutePackage(
  directory: string,
  staticManifest = manifest(),
  exportedManifest = staticManifest,
  topLevelSource = "",
  lifecycleSource = "",
): void {
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: staticManifest.packageName,
      version: staticManifest.version,
      type: "module",
      main: "./dist/index.mjs",
      exports: { ".": "./dist/index.mjs" },
      weconnect: {
        routeManifest: "./weconnect.route.json",
        routeEntrypoint: ".",
      },
    }),
  );
  fs.writeFileSync(
    path.join(directory, "weconnect.route.json"),
    JSON.stringify(staticManifest),
  );
  fs.writeFileSync(path.join(directory, "dist/index.mjs"), `
    ${topLevelSource}
    export const routePackage = {
      protocol: "weconnect.route",
      protocolVersion: 1,
      manifest: ${JSON.stringify(exportedManifest)},
      create(context) {
        return {
          id: "test-community",
          connectorId: "test-community-connector",
          connector: { id: "test-community-connector", handleMessage() { return []; } },
          route: {
            id: "test-community",
            connectorId: "test-community-connector",
            profileId: context.profileId,
          },
          ${lifecycleSource}
        };
      },
    };
    export default routePackage;
  `);
}

function writeCatalog(
  filePath: string,
  routeDirectory: string,
  catalogManifest = manifest(),
): void {
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    routes: [{
      id: catalogManifest.id,
      packageName: catalogManifest.packageName,
      displayName: catalogManifest.displayName,
      version: catalogManifest.version,
      description: catalogManifest.description,
      manifest: catalogManifest,
      artifact: {
        type: "directory",
        url: routeDirectory,
      },
      requirements: [{
        name: "Test app",
        url: "https://example.com/test-app.dmg",
        required: true,
      }],
    }],
  }));
}

async function waitForOperation(
  service: CommunityService,
  operation: CommunityOperation,
): Promise<CommunityOperation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = service.getOperation(operation.id);
    if (current?.status === "succeeded" || current?.status === "failed") return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for Community operation ${operation.id}.`);
}

function writeTarHeader(name: string, type = "0", linkName = ""): Buffer {
  const header = Buffer.alloc(512);
  const write = (value: string, offset: number, length: number) =>
    header.write(value.slice(0, length), offset, length, "ascii");
  const octal = (value: number, length: number) =>
    `${value.toString(8).padStart(length - 1, "0")}\0`;
  write(name, 0, 100);
  write(octal(0o644, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(0, 12), 124, 12);
  write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  header.fill(0x20, 148, 156);
  write(type, 156, 1);
  write(linkName, 157, 100);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function writeMaliciousArchive(filePath: string, name: string, type = "0", link = ""): void {
  fs.writeFileSync(
    filePath,
    gzipSync(Buffer.concat([writeTarHeader(name, type, link), Buffer.alloc(1024)])),
  );
}

function writeArchiveCatalog(filePath: string, archivePath: string): void {
  const routeManifest = manifest();
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    routes: [{
      id: routeManifest.id,
      packageName: routeManifest.packageName,
      displayName: routeManifest.displayName,
      version: routeManifest.version,
      description: routeManifest.description,
      manifest: routeManifest,
      artifact: { type: "archive", url: archivePath },
    }],
  }));
}

test("resolves platform app-data roots and common engine ranges", () => {
  assert.equal(
    resolveCommunityRoot({}, "darwin", "/Users/test"),
    "/Users/test/Library/Application Support/WeConnect/community",
  );
  assert.equal(versionSatisfies("0.1.0", ">=0.1.0 <2"), true);
  assert.equal(versionSatisfies("20.1.0", ">=20"), true);
  assert.equal(versionSatisfies("2.0.0", "^1.2.3"), false);
});

test("installs, activates, loads, and uninstalls a local Community route", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  writeRoutePackage(source);
  writeCatalog(catalogPath, source);
  let activations = 0;
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
    routeStorageRoot: path.join(root, "route-data"),
    onInstalledChanged() {
      activations++;
    },
  });

  const [available] = await service.catalog();
  assert.equal(available?.status, "available");
  assert.equal(available?.requirements?.[0]?.name, "Test app");
  assert.equal(available?.requirements?.[0]?.url, "https://example.com/test-app.dmg");

  const installedOperation = await waitForOperation(
    service,
    service.startOperation("install", "test-community"),
  );
  assert.equal(installedOperation.status, "succeeded", installedOperation.error);
  assert.equal(installedOperation.restartRequired, false);
  assert.equal(activations, 1);
  assert.equal(service.installed()[0]?.id, "test-community");
  assert.equal((await service.catalog())[0]?.status, "installed");

  writeRoutePackage(source, manifest("1.1.0"));
  writeCatalog(catalogPath, source, manifest("1.1.0"));
  assert.equal((await service.catalog())[0]?.status, "update-available");
  const updatedOperation = await waitForOperation(
    service,
    service.startOperation("update", "test-community"),
  );
  assert.equal(updatedOperation.status, "succeeded", updatedOperation.error);
  assert.equal(service.installed()[0]?.version, "1.1.0");
  assert.equal(activations, 2);

  const modules = await createInstalledRouteModules("profile-test", {}, {
    storageRoot: path.join(root, "module-data"),
    registryPath: service.registryPath,
  });
  assert.ok(modules.some((module) => module.id === "test-community"));

  const removedOperation = await waitForOperation(
    service,
    service.startOperation("uninstall", "test-community"),
  );
  assert.equal(removedOperation.status, "succeeded", removedOperation.error);
  assert.equal(activations, 3);
  assert.deepEqual(service.installed(), []);
});

test("stops the temporary route instance after package validation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-stop-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  const stopped = path.join(root, "validation-stopped");
  writeRoutePackage(
    source,
    manifest(),
    manifest(),
    `import fs from "node:fs";`,
    `lifecycle: {
      async stop() {
        fs.writeFileSync(${JSON.stringify(stopped)}, "stopped");
      },
    },`,
  );
  writeCatalog(catalogPath, source);
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
  });

  const operation = await waitForOperation(
    service,
    service.startOperation("install", "test-community"),
  );

  assert.equal(operation.status, "succeeded", operation.error);
  assert.equal(fs.readFileSync(stopped, "utf8"), "stopped");
});

test("downloads checksummed binaries privately and removes them with the route", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-managed-binary-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  const binary = Buffer.from(`#!/usr/bin/env node
    if (process.env.WECHAT2ALL_LLM_API_KEY) process.exit(91);
    process.stdout.write("1.0.139\\n");
  `);
  const digest = createHash("sha256").update(binary).digest("hex");
  const platform = `${process.platform}-${process.arch}`;
  const managedManifest: RouteManifestV1 = {
    ...manifest(),
    permissions: [{ name: "dependency:install", reason: "Install the private test CLI." }],
    managedDependencies: [{
      type: "binary",
      id: "officecli",
      displayName: "OfficeCLI",
      version: "1.0.139",
      executable: "officecli",
      artifacts: {
        [platform]: {
          urls: ["https://primary.example.com/officecli", "https://fallback.example.com/officecli"],
          sha256: digest,
        },
      },
    }],
  };
  writeRoutePackage(source, managedManifest);
  writeCatalog(catalogPath, source, managedManifest);
  const previousSecret = process.env.WECHAT2ALL_LLM_API_KEY;
  process.env.WECHAT2ALL_LLM_API_KEY = "must-not-reach-dependency";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.WECHAT2ALL_LLM_API_KEY;
    else process.env.WECHAT2ALL_LLM_API_KEY = previousSecret;
  });
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
    fetch: (async (input) => String(input).includes("primary.example.com")
      ? new Response("unavailable", { status: 503 })
      : new Response(binary, {
        status: 200,
        headers: { "content-length": String(binary.byteLength) },
      })) as typeof fetch,
  });
  const installedOperation = await waitForOperation(
    service,
    service.startOperation("install", "test-community", {
      acceptedPermissions: ["dependency:install"],
    }),
  );
  assert.equal(installedOperation.status, "succeeded", installedOperation.error);
  const installDir = service.installed()[0]?.installDir;
  assert.ok(installDir);
  const cli = path.join(installDir, ".weconnect-tools", "bin", process.platform === "win32"
    ? "officecli.exe"
    : "officecli");
  assert.equal(execFileSync(cli, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, WECHAT2ALL_LLM_API_KEY: undefined },
  }).trim(), "1.0.139");

  const removedOperation = await waitForOperation(
    service,
    service.startOperation("uninstall", "test-community"),
  );
  assert.equal(removedOperation.status, "succeeded", removedOperation.error);
  assert.equal(fs.existsSync(installDir), false);
});

test("rolls back a route when its private dependency checksum fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-managed-binary-fail-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  const platform = `${process.platform}-${process.arch}`;
  const managedManifest: RouteManifestV1 = {
    ...manifest(),
    permissions: [{ name: "dependency:install", reason: "Install the private test CLI." }],
    managedDependencies: [{
      type: "binary",
      id: "officecli",
      displayName: "OfficeCLI",
      version: "1.0.139",
      executable: "officecli",
      artifacts: {
        [platform]: { urls: ["https://example.com/officecli"], sha256: "a".repeat(64) },
      },
    }],
  };
  writeRoutePackage(source, managedManifest);
  writeCatalog(catalogPath, source, managedManifest);
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
    fetch: (async () => new Response("wrong binary", { status: 200 })) as typeof fetch,
  });
  const operation = await waitForOperation(
    service,
    service.startOperation("install", "test-community", {
      acceptedPermissions: ["dependency:install"],
    }),
  );
  assert.equal(operation.status, "failed");
  assert.match(operation.error ?? "", /SHA-256 mismatch/);
  assert.deepEqual(service.installed(), []);
  assert.equal(fs.existsSync(path.join(service.rootDir, "routes", "test-community", "1.0.0")), false);
});

test("rejects non-HTTPS requirement links before exposing them to the desktop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-requirement-url-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  writeRoutePackage(source);
  writeCatalog(catalogPath, source);
  const document = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  document.routes[0].requirements[0].url = "file:///tmp/untrusted.dmg";
  fs.writeFileSync(catalogPath, JSON.stringify(document));
  const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];

  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(message, context) { errors.push({ message, context }); },
    },
  });

  assert.deepEqual(await service.catalog(), []);
  assert.equal(errors[0]?.message, "Could not load Community catalog.");
  assert.match(String(errors[0]?.context?.error), /requirements\[0\]\.url must use HTTPS/);
});

test("requires permission approval before any package code is imported", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-permission-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  const protectedManifest = manifest("1.0.0", [{
    name: "network:loopback",
    reason: "Connect to a local companion app.",
  }]);
  writeRoutePackage(source, protectedManifest);
  writeCatalog(catalogPath, source, protectedManifest);
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
  });

  const denied = await waitForOperation(
    service,
    service.startOperation("install", "test-community"),
  );
  assert.equal(denied.status, "failed");
  assert.match(denied.error ?? "", /permission confirmation: network:loopback/);

  const allowed = await waitForOperation(
    service,
    service.startOperation("install", "test-community", {
      acceptedPermissions: ["network:loopback"],
    }),
  );
  assert.equal(allowed.status, "succeeded", allowed.error);
});

test("rejects a catalog that understates package permissions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-manifest-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  const packageManifest = manifest("1.0.0", [{
    name: "network:loopback",
    reason: "Connect to a local companion app.",
  }]);
  const sideEffectSentinel = path.join(root, "route-code-ran");
  writeRoutePackage(
    source,
    packageManifest,
    packageManifest,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sideEffectSentinel)}, "ran");`,
  );
  writeCatalog(catalogPath, source, manifest());
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
  });

  const operation = await waitForOperation(
    service,
    service.startOperation("install", "test-community"),
  );
  assert.equal(operation.status, "failed");
  assert.match(operation.error ?? "", /does not match/);
  assert.equal(fs.existsSync(sideEffectSentinel), false);
  assert.deepEqual(readCommunityInstalledRegistry(service.registryPath).packages, []);
});

test("rolls the registry back when route activation fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-rollback-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  writeRoutePackage(source);
  writeCatalog(catalogPath, source);
  let activationAttempts = 0;
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
    onInstalledChanged() {
      activationAttempts++;
      if (activationAttempts === 1) throw new Error("activation exploded");
    },
  });
  const operation = await waitForOperation(
    service,
    service.startOperation("install", "test-community"),
  );
  assert.equal(operation.status, "failed");
  assert.match(operation.error ?? "", /previous installation was restored/);
  assert.deepEqual(service.installed(), []);
});

test("reports when both activation and live runtime rollback fail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-rollback-failed-"));
  const source = path.join(root, "source-route");
  const catalogPath = path.join(root, "catalog.json");
  writeRoutePackage(source);
  writeCatalog(catalogPath, source);
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
    onInstalledChanged() {
      throw new Error("runtime reload exploded");
    },
  });

  const operation = await waitForOperation(
    service,
    service.startOperation("install", "test-community"),
  );
  assert.equal(operation.status, "failed");
  assert.equal(operation.restartRequired, true);
  assert.match(operation.error ?? "", /live runtime could not be rolled back; restart WeConnect/);
  assert.deepEqual(service.installed(), []);
});

test("never deletes a registry path outside the managed routes directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-path-"));
  const appData = path.join(root, "app-data");
  const registryPath = path.join(appData, "installed-routes.json");
  const victim = path.join(root, "must-survive");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "sentinel"), "safe");
  fs.mkdirSync(appData, { recursive: true });
  const routeManifest = manifest();
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    packages: [{
      id: routeManifest.id,
      packageName: routeManifest.packageName,
      version: routeManifest.version,
      displayName: routeManifest.displayName,
      manifest: routeManifest,
      installDir: victim,
      entrypoint: path.join(victim, "sentinel"),
      installedAt: new Date().toISOString(),
      sourceCatalog: "test",
    }],
  }));
  const service = new CommunityService({ rootDir: appData });
  const operation = await waitForOperation(
    service,
    service.startOperation("uninstall", "test-community"),
  );
  assert.equal(operation.status, "failed");
  assert.match(operation.error ?? "", /outside the managed routes directory/);
  assert.equal(fs.readFileSync(path.join(victim, "sentinel"), "utf8"), "safe");
});

test("Community mutations enforce local browser origin and JSON content type", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-http-"));
  const service = new CommunityService({ rootDir: root });
  const request = async (headers: Record<string, string>): Promise<number> => {
    let status = 0;
    const req = { method: "POST", headers } as unknown as http.IncomingMessage;
    const res = {
      writeHead(nextStatus: number) {
        status = nextStatus;
        return this;
      },
      end() {},
    } as unknown as http.ServerResponse;
    await handleCommunityHttpRequest(
      req,
      res,
      new URL("http://127.0.0.1/community/routes/test-community/install"),
      service,
    );
    return status;
  };

  assert.equal(await request({
    origin: "https://attacker.example",
    "content-type": "text/plain",
  }), 403);
  assert.equal(await request({
    origin: "http://localhost:5173",
    "content-type": "text/plain",
  }), 415);
});

test("installs a valid local tar.gz release artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-tar-"));
  const source = path.join(root, "source-route");
  const archivePath = path.join(root, "route.tar.gz");
  const catalogPath = path.join(root, "catalog.json");
  writeRoutePackage(source);
  execFileSync("tar", ["-czf", archivePath, "-C", source, "."]);
  writeArchiveCatalog(catalogPath, archivePath);
  const service = new CommunityService({
    rootDir: path.join(root, "app-data"),
    catalogSources: [catalogPath],
  });
  const operation = await waitForOperation(
    service,
    service.startOperation("install", "test-community"),
  );
  assert.equal(operation.status, "succeeded", operation.error);
  assert.equal(service.installed()[0]?.version, "1.0.0");
});

test("rejects traversal and symlink members before archive extraction", async () => {
  for (const malicious of [
    { name: "../escape", type: "0", link: "" },
    { name: "route-link", type: "2", link: "/tmp" },
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "weconnect-community-archive-"));
    const archivePath = path.join(root, "malicious.tar.gz");
    const catalogPath = path.join(root, "catalog.json");
    writeMaliciousArchive(archivePath, malicious.name, malicious.type, malicious.link);
    writeArchiveCatalog(catalogPath, archivePath);
    const service = new CommunityService({
      rootDir: path.join(root, "app-data"),
      catalogSources: [catalogPath],
    });
    const operation = await waitForOperation(
      service,
      service.startOperation("install", "test-community"),
    );
    assert.equal(operation.status, "failed");
    assert.match(operation.error ?? "", /Unsafe path|only regular files and directories|Could not extract/);
    assert.equal(fs.existsSync(path.join(root, "escape")), false);
  }
});
