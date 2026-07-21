import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { routePackage as codexRoutePackage } from "@wechat2all/codex-route";
import { routePackage as claudeRoutePackage } from "@wechat2all/claude-route";
import { routePackage as officeRoutePackage } from "@wechat2all/office-route";
import {
  instantiateRoutePackageV1,
  routePackageFromModuleExportsV1,
  type RouteLoggerV1,
  type InstantiatedRouteModuleV1,
  type RoutePackageModuleExportsV1,
  type RoutePackageV1,
} from "@wechat2all/route-sdk";

export type InstalledRouteModule = InstantiatedRouteModuleV1;

export interface InstalledRouteLoadOptions {
  storageRoot: string;
  logger?: RouteLoggerV1;
}

export interface ExternalRouteLoadOptions {
  onError?: (specifier: string, error: Error) => void;
}

const defaultLogger: RouteLoggerV1 = {
  debug(message, context) {
    console.debug(`[route-sdk] ${message}`, context ?? "");
  },
  info(message, context) {
    console.info(`[route-sdk] ${message}`, context ?? "");
  },
  warn(message, context) {
    console.warn(`[route-sdk] ${message}`, context ?? "");
  },
  error(message, context) {
    console.error(`[route-sdk] ${message}`, context ?? "");
  },
};

export function parseRoutePackageSpecifiers(value: string | undefined): string[] {
  return [...new Set(
    (value ?? "")
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function importSpecifier(value: string): string {
  if (value.startsWith("file:")) return value;
  if (path.isAbsolute(value) || value.startsWith(".")) {
    return pathToFileURL(path.resolve(value)).href;
  }
  return value;
}

export async function loadExternalRoutePackages(
  specifiers: readonly string[],
  options: ExternalRouteLoadOptions = {},
): Promise<RoutePackageV1[]> {
  const loaded: RoutePackageV1[] = [];
  for (const specifier of specifiers) {
    let moduleExports: RoutePackageModuleExportsV1;
    try {
      moduleExports = await import(importSpecifier(specifier)) as RoutePackageModuleExportsV1;
      loaded.push(routePackageFromModuleExportsV1(moduleExports));
    } catch (error) {
      const wrapped = new Error(
        `Could not load WeConnect route package ${specifier}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
      if (options.onError) {
        options.onError(specifier, wrapped);
        continue;
      }
      throw wrapped;
    }
  }
  return loaded;
}

function assertNoInstalledRouteConflict(
  candidate: InstalledRouteModule,
  installed: readonly InstalledRouteModule[],
): void {
  if (installed.some((item) => item.id === candidate.id)) {
    throw new Error(`Duplicate WeConnect route id: ${candidate.id}.`);
  }
  if (installed.some((item) => item.connectorId === candidate.connectorId)) {
    throw new Error(`Duplicate WeConnect connector id: ${candidate.connectorId}.`);
  }
  if (
    candidate.config
    && installed.some((item) => item.config?.key === candidate.config?.key)
  ) {
    throw new Error(`Duplicate WeConnect route config key: ${candidate.config.key}.`);
  }
}

export function instantiateInstalledRoutePackages(
  routePackages: readonly RoutePackageV1[],
  profileId: string,
  env: NodeJS.ProcessEnv,
  options: InstalledRouteLoadOptions,
): InstalledRouteModule[] {
  const routeIds = new Set<string>();
  const connectorIds = new Set<string>();
  const configKeys = new Set<string>();

  return routePackages.map((routePackage) => {
    const storageDir = path.join(options.storageRoot, routePackage.manifest.id);
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(storageDir, 0o700);
    } catch {
      // Best effort on filesystems that do not implement POSIX permissions.
    }
    const instance = instantiateRoutePackageV1(routePackage, {
      profileId,
      env,
      storageDir,
      logger: options.logger ?? defaultLogger,
    });
    if (routeIds.has(instance.id)) {
      throw new Error(`Duplicate WeConnect route id: ${instance.id}.`);
    }
    if (connectorIds.has(instance.connectorId)) {
      throw new Error(`Duplicate WeConnect connector id: ${instance.connectorId}.`);
    }
    if (instance.config && configKeys.has(instance.config.key)) {
      throw new Error(`Duplicate WeConnect route config key: ${instance.config.key}.`);
    }
    routeIds.add(instance.id);
    connectorIds.add(instance.connectorId);
    if (instance.config) configKeys.add(instance.config.key);
    return instance;
  });
}

/** Loads built-in and user-installed protocol v1 route packages. */
export async function createInstalledRouteModules(
  profileId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: InstalledRouteLoadOptions,
): Promise<InstalledRouteModule[]> {
  const external = await loadExternalRoutePackages(
    parseRoutePackageSpecifiers(env.WECHAT2ALL_ROUTE_PACKAGES),
    {
      onError(specifier, error) {
        (options.logger ?? defaultLogger).error("Rejected external route package.", {
          specifier,
          error: error.message,
        });
      },
    },
  );
  const installed = instantiateInstalledRoutePackages(
    [codexRoutePackage, claudeRoutePackage, officeRoutePackage],
    profileId,
    env,
    options,
  );
  for (const routePackage of external) {
    try {
      if (installed.some((item) => item.manifest.id === routePackage.manifest.id)) {
        throw new Error(`Duplicate WeConnect route id: ${routePackage.manifest.id}.`);
      }
      if (installed.some(
        (item) => item.manifest.packageName === routePackage.manifest.packageName
      )) {
        throw new Error(
          `Duplicate WeConnect package name: ${routePackage.manifest.packageName}.`,
        );
      }
      const [candidate] = instantiateInstalledRoutePackages(
        [routePackage],
        profileId,
        env,
        options,
      );
      if (!candidate) continue;
      assertNoInstalledRouteConflict(candidate, installed);
      installed.push(candidate);
    } catch (error) {
      (options.logger ?? defaultLogger).error("Rejected external route package.", {
        packageName: routePackage.manifest.packageName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return installed;
}
