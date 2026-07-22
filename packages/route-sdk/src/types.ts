import type {
  RuntimeConnector,
  RuntimeRoute,
} from "@wechat2all/runtime";

export const WECONNECT_ROUTE_PROTOCOL = "weconnect.route" as const;
export const WECONNECT_ROUTE_PROTOCOL_VERSION = 1 as const;

export type RouteCapabilityV1 =
  | "text-input"
  | "media-input"
  | "text-output"
  | "media-output"
  | "setup-check"
  | "config"
  | "lifecycle"
  | `custom:${string}`;

export interface RoutePermissionV1 {
  /** Stable, machine-readable permission name, for example network or process:spawn. */
  name: string;
  reason: string;
  optional?: boolean;
}

export interface RouteManagedBinaryArtifactV1 {
  /** Ordered immutable HTTPS sources; each must serve bytes matching sha256. */
  urls: string[];
  sha256: string;
}

/** A checksummed executable installed inside the Community route's managed directory. */
export interface RouteManagedBinaryDependencyV1 {
  type: "binary";
  id: string;
  displayName: string;
  /** Exact tool version; ranges are intentionally not accepted. */
  version: string;
  /** Binary name without a path or platform extension. */
  executable: string;
  artifacts: Partial<Record<
    | "darwin-arm64"
    | "darwin-x64"
    | "linux-arm64"
    | "linux-x64"
    | "linux-musl-arm64"
    | "linux-musl-x64"
    | "win32-arm64"
    | "win32-x64",
    RouteManagedBinaryArtifactV1
  >>;
}

export type RouteManagedDependencyV1 = RouteManagedBinaryDependencyV1;

/** Static metadata used by package validation and a future community registry. */
export interface RouteManifestV1 {
  protocol: typeof WECONNECT_ROUTE_PROTOCOL;
  protocolVersion: typeof WECONNECT_ROUTE_PROTOCOL_VERSION;
  id: string;
  packageName: string;
  displayName: string;
  version: string;
  description: string;
  license?: string;
  author?: {
    name: string;
    url?: string;
  };
  homepage?: string;
  repository?: string;
  engines: {
    weconnect: string;
    node?: string;
  };
  capabilities: RouteCapabilityV1[];
  permissions: RoutePermissionV1[];
  /** Optional dependencies installed privately and removed with this route. */
  managedDependencies?: RouteManagedDependencyV1[];
}

export type RouteSetupCheckItemStatusV1 =
  | "pass"
  | "missing"
  | "warn"
  | "unknown"
  | "info";

export interface RouteSetupCheckSnapshotV1 {
  status: "idle" | "checking" | "ready" | "error";
  checkedAt: string | null;
  items: Array<{
    status: RouteSetupCheckItemStatusV1;
    message: string;
    section: string | null;
  }>;
  exitCode: number | null;
  error: string | null;
}

export interface RouteSetupCheckV1 {
  snapshot(): RouteSetupCheckSnapshotV1;
  refresh(): Promise<RouteSetupCheckSnapshotV1>;
}

export interface RouteConfigExtensionV1 {
  /** Top-level key exposed through the host's local configuration API. */
  key: string;
  /** Route-local field name to host environment variable name. */
  fields: Record<string, string>;
  parsePatch(value: unknown): Record<string, string | null | undefined>;
  snapshot(env: Readonly<Record<string, string | undefined>>): unknown;
}

export interface RouteDashboardContributionV1 {
  agent?: {
    name: string;
    kind: string;
    status: string;
    description: string;
  };
  management?: {
    setupCheck?: boolean;
    configControls?: Array<{
      configKey: string;
      field: string;
      label: string;
      values: Array<{
        value: string;
        label: string;
        title?: string;
      }>;
    }>;
    manualPermissions?: Array<{
      title: string;
      items: string[];
    }>;
    commands?: Array<{
      rule: string;
      description: string;
    }>;
  };
}

export interface RouteLifecycleV1 {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface RouteLoggerV1 {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface RouteHostContextV1 {
  profileId: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Private persistent directory assigned to this route package. */
  storageDir: string;
  logger: RouteLoggerV1;
}

/** Live route unit returned by a protocol factory. */
export interface RouteModuleV1 {
  id: string;
  connectorId: string;
  connector: RuntimeConnector;
  route: RuntimeRoute;
  backend?: string;
  config?: RouteConfigExtensionV1;
  setupCheck?: RouteSetupCheckV1;
  dashboard?: RouteDashboardContributionV1;
  lifecycle?: RouteLifecycleV1;
}

/** A validated live module after the host has attached its package manifest. */
export interface InstantiatedRouteModuleV1 extends RouteModuleV1 {
  manifest: RouteManifestV1;
}

/** Standard executable export of a community route npm package. */
export interface RoutePackageV1 {
  protocol: typeof WECONNECT_ROUTE_PROTOCOL;
  protocolVersion: typeof WECONNECT_ROUTE_PROTOCOL_VERSION;
  manifest: RouteManifestV1;
  create(context: RouteHostContextV1): RouteModuleV1;
}

export interface RoutePackageModuleExportsV1 {
  routePackage?: unknown;
  default?: unknown;
}

export type {
  MemoryMessage,
  MemoryRole,
  MemoryScope,
  MemoryStore,
  RuntimeAction,
  RuntimeActionOptions,
  RuntimeActionResult,
  RuntimeAttachment,
  RuntimeConnector,
  RuntimeHandler,
  RuntimeHandlerContext,
  RuntimeMediaService,
  RuntimeMessage,
  RuntimeMessageKind,
  RuntimeReplyToken,
  RuntimeRoute,
  RuntimeRouteManager,
  RuntimeRouteMatch,
} from "@wechat2all/runtime";
