import fs from "node:fs";
import path from "node:path";

import {
  assertRouteManifestV1,
  type RouteManifestV1,
} from "@wechat2all/route-sdk";

export const COMMUNITY_REGISTRY_SCHEMA_VERSION = 1 as const;

export interface InstalledCommunityRoute {
  id: string;
  packageName: string;
  version: string;
  displayName: string;
  manifest: RouteManifestV1;
  installDir: string;
  entrypoint: string;
  installedAt: string;
  sourceCatalog: string;
}

export interface CommunityInstalledRegistry {
  schemaVersion: typeof COMMUNITY_REGISTRY_SCHEMA_VERSION;
  packages: InstalledCommunityRoute[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Community registry ${field} is missing or invalid.`);
  }
  return value;
}

function resolveContainedFile(root: string, candidate: string, field: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Community registry ${field} escapes its install directory.`);
  }
  return resolved;
}

function managedInstallDir(packagesRoot: string, id: string, version: string): string {
  return path.resolve(packagesRoot, id, version);
}

function parseInstalledRoute(
  value: unknown,
  packagesRoot: string,
): InstalledCommunityRoute {
  const record = objectValue(value);
  if (!record) throw new Error("Community registry package must be an object.");
  assertRouteManifestV1(record.manifest);
  const id = requiredString(record.id, "package.id");
  const packageName = requiredString(record.packageName, "package.packageName");
  const version = requiredString(record.version, "package.version");
  if (
    record.manifest.id !== id
    || record.manifest.packageName !== packageName
    || record.manifest.version !== version
  ) {
    throw new Error(`Community registry metadata does not match manifest for ${id}.`);
  }
  const installDir = path.resolve(requiredString(record.installDir, "package.installDir"));
  const expectedInstallDir = managedInstallDir(packagesRoot, id, version);
  if (installDir !== expectedInstallDir) {
    throw new Error(
      `Community registry installDir for ${id}@${version} is outside the managed routes directory.`,
    );
  }
  const entrypoint = resolveContainedFile(
    installDir,
    requiredString(record.entrypoint, "package.entrypoint"),
    "package.entrypoint",
  );
  return {
    id,
    packageName,
    version,
    displayName: requiredString(record.displayName, "package.displayName"),
    manifest: record.manifest,
    installDir,
    entrypoint,
    installedAt: requiredString(record.installedAt, "package.installedAt"),
    sourceCatalog: requiredString(record.sourceCatalog, "package.sourceCatalog"),
  };
}

export function emptyCommunityInstalledRegistry(): CommunityInstalledRegistry {
  return { schemaVersion: COMMUNITY_REGISTRY_SCHEMA_VERSION, packages: [] };
}

export function readCommunityInstalledRegistry(
  filePath: string,
  packagesRoot = path.join(path.dirname(filePath), "routes"),
): CommunityInstalledRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyCommunityInstalledRegistry();
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  const document = objectValue(parsed);
  if (document?.schemaVersion !== COMMUNITY_REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Community registry schema version: ${String(document?.schemaVersion)}.`,
    );
  }
  if (!Array.isArray(document.packages)) {
    throw new Error("Community registry packages must be an array.");
  }
  const packages = document.packages.map((entry) => parseInstalledRoute(entry, packagesRoot));
  const routeIds = new Set<string>();
  const packageNames = new Set<string>();
  for (const item of packages) {
    if (routeIds.has(item.id)) {
      throw new Error(`Duplicate Community route id in registry: ${item.id}.`);
    }
    if (packageNames.has(item.packageName)) {
      throw new Error(`Duplicate Community package name in registry: ${item.packageName}.`);
    }
    routeIds.add(item.id);
    packageNames.add(item.packageName);
  }
  return { schemaVersion: COMMUNITY_REGISTRY_SCHEMA_VERSION, packages };
}

export function writeCommunityInstalledRegistry(
  filePath: string,
  registry: CommunityInstalledRegistry,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The atomic rename normally consumes the temporary file.
    }
  }
}
