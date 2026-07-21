import {
  WECONNECT_ROUTE_PROTOCOL,
  WECONNECT_ROUTE_PROTOCOL_VERSION,
  type InstantiatedRouteModuleV1,
  type RouteHostContextV1,
  type RouteModuleV1,
  type RoutePackageModuleExportsV1,
  type RoutePackageV1,
} from "./types.js";

const ROUTE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAPABILITY_PATTERN = /^(?:text-input|media-input|text-output|media-output|setup-check|config|lifecycle|custom:[a-z0-9][a-z0-9._-]*)$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/;

export type RouteProtocolErrorCode =
  | "invalid-package"
  | "unsupported-protocol"
  | "invalid-manifest"
  | "invalid-module"
  | "factory-failed";

export class RouteProtocolError extends Error {
  constructor(
    public readonly code: RouteProtocolErrorCode,
    message: string,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RouteProtocolError";
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(
  value: unknown,
  path: string,
  pattern?: RegExp,
  code: RouteProtocolErrorCode = "invalid-manifest",
): asserts value is string {
  if (typeof value !== "string" || !value.trim() || (pattern && !pattern.test(value))) {
    throw new RouteProtocolError(
      code,
      `${path} is missing or invalid.`,
      path,
    );
  }
}

export function assertRouteManifestV1(value: unknown): asserts value is RoutePackageV1["manifest"] {
  const manifest = objectValue(value);
  if (!manifest) {
    throw new RouteProtocolError("invalid-manifest", "manifest must be an object.", "manifest");
  }
  if (manifest.protocol !== WECONNECT_ROUTE_PROTOCOL) {
    throw new RouteProtocolError(
      "unsupported-protocol",
      `manifest.protocol must be ${WECONNECT_ROUTE_PROTOCOL}.`,
      "manifest.protocol",
    );
  }
  if (manifest.protocolVersion !== WECONNECT_ROUTE_PROTOCOL_VERSION) {
    throw new RouteProtocolError(
      "unsupported-protocol",
      `Route protocol version ${String(manifest.protocolVersion)} is unsupported; ` +
        `this host supports v${WECONNECT_ROUTE_PROTOCOL_VERSION}.`,
      "manifest.protocolVersion",
    );
  }
  requiredString(manifest.id, "manifest.id", ROUTE_ID_PATTERN);
  requiredString(manifest.packageName, "manifest.packageName", PACKAGE_NAME_PATTERN);
  requiredString(manifest.displayName, "manifest.displayName");
  requiredString(manifest.version, "manifest.version", VERSION_PATTERN);
  requiredString(manifest.description, "manifest.description");
  if (manifest.license !== undefined) requiredString(manifest.license, "manifest.license");
  if (manifest.homepage !== undefined) requiredString(manifest.homepage, "manifest.homepage");
  if (manifest.repository !== undefined) requiredString(manifest.repository, "manifest.repository");
  if (manifest.author !== undefined) {
    const author = objectValue(manifest.author);
    if (!author) {
      throw new RouteProtocolError("invalid-manifest", "manifest.author must be an object.", "manifest.author");
    }
    requiredString(author.name, "manifest.author.name");
    if (author.url !== undefined) requiredString(author.url, "manifest.author.url");
  }
  const engines = objectValue(manifest.engines);
  requiredString(engines?.weconnect, "manifest.engines.weconnect");
  if (engines?.node !== undefined) requiredString(engines.node, "manifest.engines.node");
  if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.every(
    (capability) => typeof capability === "string" && CAPABILITY_PATTERN.test(capability),
  )) {
    throw new RouteProtocolError(
      "invalid-manifest",
      "manifest.capabilities must be an array of strings.",
      "manifest.capabilities",
    );
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.every((permission) => {
    const entry = objectValue(permission);
    return typeof entry?.name === "string" && PERMISSION_PATTERN.test(entry.name)
      && typeof entry.reason === "string" && entry.reason.length > 0
      && (entry.optional === undefined || typeof entry.optional === "boolean");
  })) {
    throw new RouteProtocolError(
      "invalid-manifest",
      "manifest.permissions must contain valid name/reason entries.",
      "manifest.permissions",
    );
  }
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    throw new RouteProtocolError(
      "invalid-manifest",
      "manifest.capabilities must not contain duplicates.",
      "manifest.capabilities",
    );
  }
  const permissionNames = manifest.permissions.map((permission) => permission.name);
  if (new Set(permissionNames).size !== permissionNames.length) {
    throw new RouteProtocolError(
      "invalid-manifest",
      "manifest.permissions must not contain duplicate names.",
      "manifest.permissions",
    );
  }
}

export function assertRoutePackageV1(value: unknown): asserts value is RoutePackageV1 {
  const routePackage = objectValue(value);
  if (!routePackage) {
    throw new RouteProtocolError("invalid-package", "Route package export must be an object.");
  }
  if (
    routePackage.protocol !== WECONNECT_ROUTE_PROTOCOL
    || routePackage.protocolVersion !== WECONNECT_ROUTE_PROTOCOL_VERSION
  ) {
    throw new RouteProtocolError(
      "unsupported-protocol",
      `Route package must implement ${WECONNECT_ROUTE_PROTOCOL}/v${WECONNECT_ROUTE_PROTOCOL_VERSION}.`,
    );
  }
  assertRouteManifestV1(routePackage.manifest);
  if (typeof routePackage.create !== "function") {
    throw new RouteProtocolError("invalid-package", "Route package create must be a function.", "create");
  }
}

export function defineRoutePackageV1<T extends RoutePackageV1>(routePackage: T): T {
  assertRoutePackageV1(routePackage);
  return routePackage;
}

export function assertRouteManifestMatchesPackageV1(
  staticManifest: unknown,
  routePackage: RoutePackageV1,
): void {
  assertRouteManifestV1(staticManifest);
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    const record = objectValue(value);
    if (!record) return value;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "$schema")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  if (JSON.stringify(normalize(staticManifest)) !== JSON.stringify(normalize(routePackage.manifest))) {
    throw new RouteProtocolError(
      "invalid-manifest",
      "Static weconnect.route.json does not match the package's exported manifest.",
      "manifest",
    );
  }
}

export function routePackageFromModuleExportsV1(
  exports: RoutePackageModuleExportsV1,
): RoutePackageV1 {
  const candidate = exports.routePackage ?? exports.default;
  assertRoutePackageV1(candidate);
  return candidate;
}

function assertRouteModuleV1(
  value: unknown,
  routePackage: RoutePackageV1,
  context: RouteHostContextV1,
): asserts value is RouteModuleV1 {
  const instance = objectValue(value);
  if (!instance) {
    throw new RouteProtocolError("invalid-module", "Route factory must return an object.");
  }
  if (instance && typeof (instance as { then?: unknown }).then === "function") {
    throw new RouteProtocolError(
      "invalid-module",
      "Protocol v1 create() must be synchronous; use lifecycle.start() for async work.",
    );
  }
  if (instance.id !== routePackage.manifest.id) {
    throw new RouteProtocolError(
      "invalid-module",
      `Route module id ${String(instance.id)} does not match manifest id ${routePackage.manifest.id}.`,
      "id",
    );
  }
  requiredString(instance.connectorId, "connectorId", CONNECTOR_ID_PATTERN, "invalid-module");
  const connector = objectValue(instance.connector);
  if (
    connector?.id !== instance.connectorId
    || typeof connector.handleMessage !== "function"
  ) {
    throw new RouteProtocolError(
      "invalid-module",
      "connector.id must match connectorId and expose handleMessage().",
      "connector",
    );
  }
  const route = objectValue(instance.route);
  if (route?.id !== instance.id || route.connectorId !== instance.connectorId) {
    throw new RouteProtocolError(
      "invalid-module",
      "route.id/connectorId must match the route module.",
      "route",
    );
  }
  if (route.profileId !== undefined && route.profileId !== context.profileId) {
    throw new RouteProtocolError(
      "invalid-module",
      `route.profileId must be ${context.profileId}.`,
      "route.profileId",
    );
  }
  const config = instance.config === undefined ? undefined : objectValue(instance.config);
  if (instance.config !== undefined && !config) {
    throw new RouteProtocolError("invalid-module", "config extension must be an object.", "config");
  }
  if (config) {
    requiredString(config.key, "config.key", ROUTE_ID_PATTERN, "invalid-module");
    if (
      !objectValue(config.fields)
      || typeof config.parsePatch !== "function"
      || typeof config.snapshot !== "function"
    ) {
      throw new RouteProtocolError("invalid-module", "config extension is invalid.", "config");
    }
  }
  const setupCheck = instance.setupCheck === undefined
    ? undefined
    : objectValue(instance.setupCheck);
  if (
    instance.setupCheck !== undefined
    && (!setupCheck || typeof setupCheck.snapshot !== "function" || typeof setupCheck.refresh !== "function")
  ) {
    throw new RouteProtocolError("invalid-module", "setupCheck extension is invalid.", "setupCheck");
  }
  const lifecycle = instance.lifecycle === undefined
    ? undefined
    : objectValue(instance.lifecycle);
  if (
    instance.lifecycle !== undefined
    && (!lifecycle
      || (lifecycle.start !== undefined && typeof lifecycle.start !== "function")
      || (lifecycle.stop !== undefined && typeof lifecycle.stop !== "function"))
  ) {
    throw new RouteProtocolError("invalid-module", "lifecycle extension is invalid.", "lifecycle");
  }
  if (instance.dashboard !== undefined && !objectValue(instance.dashboard)) {
    throw new RouteProtocolError("invalid-module", "dashboard extension must be an object.", "dashboard");
  }
  if (instance.backend !== undefined && typeof instance.backend !== "string") {
    throw new RouteProtocolError("invalid-module", "backend must be a string.", "backend");
  }
}

export function instantiateRoutePackageV1(
  routePackage: RoutePackageV1,
  context: RouteHostContextV1,
): InstantiatedRouteModuleV1 {
  assertRoutePackageV1(routePackage);
  let instance: RouteModuleV1;
  try {
    instance = routePackage.create(context);
  } catch (error) {
    throw new RouteProtocolError(
      "factory-failed",
      `Route package ${routePackage.manifest.packageName} failed to create: ${
        error instanceof Error ? error.message : String(error)
      }`,
      undefined,
      { cause: error },
    );
  }
  assertRouteModuleV1(instance, routePackage, context);
  const metadata = {
    ...(instance.route.metadata ?? {}),
    routePackage: {
      protocol: routePackage.protocol,
      protocolVersion: routePackage.protocolVersion,
      packageName: routePackage.manifest.packageName,
      packageVersion: routePackage.manifest.version,
      displayName: routePackage.manifest.displayName,
      capabilities: routePackage.manifest.capabilities,
      permissions: routePackage.manifest.permissions,
    },
    ...(instance.dashboard?.agent ? { dashboardAgent: instance.dashboard.agent } : {}),
    ...(instance.dashboard?.management
      ? { dashboardManagement: instance.dashboard.management }
      : {}),
  };
  return {
    ...instance,
    manifest: routePackage.manifest,
    route: {
      ...instance.route,
      profileId: instance.route.profileId ?? context.profileId,
      metadata,
    },
  };
}
