export type PageKey = "home" | "config" | "routes" | "community" | "trace";

export interface ProfileStatus {
  id: string;
  name: string;
  connected: boolean;
  running: boolean;
  accountId?: string | null;
  lastSeenAt?: string | null;
  sessionExpiresAt?: string | null;
}

export interface RouteSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  connectorId: string;
  matchText: string[];
  management?: RouteManagement | null;
  stats: {
    messagesToday: number;
    lastHitAt?: string | null;
  };
}

export interface CommunityRouteManifest {
  protocol: "weconnect.route";
  protocolVersion: 1;
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
  capabilities: string[];
  permissions: Array<{
    name: string;
    reason: string;
    optional?: boolean;
  }>;
  managedDependencies?: Array<{
    type: "binary";
    id: string;
    displayName: string;
    version: string;
    executable: string;
    artifacts: Record<string, { urls: string[]; sha256: string }>;
  }>;
}

export interface CommunityRouteRequirement {
  name: string;
  description?: string;
  url?: string;
  required?: boolean;
}

export interface CommunityCatalogRoute {
  id: string;
  packageName: string;
  displayName: string;
  version: string;
  description: string;
  manifest: CommunityRouteManifest;
  artifact: {
    type: "archive" | "directory";
    url: string;
    sha256?: string;
  };
  requirements?: CommunityRouteRequirement[];
  installedVersion: string | null;
  status: "available" | "installed" | "update-available";
}

export interface CommunityInstalledRoute {
  id: string;
  packageName: string;
  displayName: string;
  version: string;
  manifest: CommunityRouteManifest;
  installedAt: string;
  sourceCatalog: string;
  installDir: string;
  status?: "installed";
}

export interface CommunityCatalogResponse {
  ok: true;
  schemaVersion: 1;
  routes: CommunityCatalogRoute[];
}

export interface CommunityInstalledResponse {
  ok: true;
  schemaVersion: 1;
  routes: CommunityInstalledRoute[];
}

export type CommunityOperationKind = "install" | "update" | "uninstall";
export type CommunityOperationStatus = "queued" | "running" | "succeeded" | "failed";

export interface CommunityOperation {
  id: string;
  kind: CommunityOperationKind;
  routeId: string;
  status: CommunityOperationStatus;
  progress: number;
  message?: string;
  error?: string;
  restartRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityOperationResponse {
  ok: true;
  operation: CommunityOperation;
}

export interface CommunityInstallRequest {
  version?: string;
  acceptedPermissions?: string[];
}

export interface RouteManagement {
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
}

export interface AgentSummary {
  id: string;
  name: string;
  kind: string;
  status: string;
  routeCount: number;
  description: string;
}

export interface TraceEvent {
  id: string;
  time: string;
  level: "debug" | "info" | "warn" | "error" | string;
  source: string;
  message: string;
  routeId?: string | null;
}

export interface SettingsSnapshot {
  llmProvider: string;
  memoryProvider: string;
  autostartEnabled: boolean;
  routerEndpoint: string;
}

export interface SecretConfigStatus {
  configured: boolean;
  masked: string | null;
}

export interface LlmLocalConfig {
  provider: "openai-compatible" | "mock" | string;
  apiKey: SecretConfigStatus;
  model: string | null;
  baseUrl: string;
  temperature: number | null;
  maxTokens: number | null;
  timeoutMs: number | null;
}

export interface MemoryLocalConfig {
  provider: "local" | "mem0" | "none" | string;
  apiKey: SecretConfigStatus;
  baseUrl: string;
  timeoutMs: number;
  localMaxSearchRows: number | null;
}

export interface ClaudeLocalConfig {
  apiKey: SecretConfigStatus;
  workdir: string | null;
  promptFile: string | null;
  model: string | null;
  language: "zh" | "en";
  sessionWindowMinutes: number;
  maxMediaMb: number;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  allowCliAuth: boolean;
  executable: string | null;
}

export interface LocalConfigSnapshot {
  configPath: string;
  runtimeApplied: boolean;
  restartRequired: boolean;
  llm: LlmLocalConfig;
  memory: MemoryLocalConfig;
  claude: ClaudeLocalConfig;
  [extensionKey: string]: unknown;
}

export interface LocalConfigPatch {
  llm?: {
    provider?: string | null;
    apiKey?: string | null;
    model?: string | null;
    baseUrl?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
    timeoutMs?: number | null;
  };
  memory?: {
    provider?: string | null;
    apiKey?: string | null;
    baseUrl?: string | null;
    timeoutMs?: number | null;
    localMaxSearchRows?: number | null;
  };
  claude?: {
    apiKey?: string | null;
    workdir?: string | null;
    promptFile?: string | null;
    model?: string | null;
    language?: "zh" | "en" | null;
    sessionWindowMinutes?: number | null;
    maxMediaMb?: number | null;
    maxTurns?: number | null;
    maxBudgetUsd?: number | null;
    timeoutMs?: number | null;
    allowCliAuth?: boolean | null;
    executable?: string | null;
  };
  [extensionKey: string]: unknown;
}

export interface LocalConfigResponse {
  ok: boolean;
  schemaVersion: number;
  config: LocalConfigSnapshot;
}

export interface LocalConfigUpdateResponse extends LocalConfigResponse {
  changed: boolean;
  changedFields: string[];
}

export interface DashboardSnapshot {
  profile: ProfileStatus;
  routes: RouteSummary[];
  agents: AgentSummary[];
  traces: TraceEvent[];
  settings: SettingsSnapshot;
}

export interface LlmHealthResponse {
  ok: true;
  schemaVersion: 1;
  llm: {
    status: "idle" | "checking" | "not-configured" | "ready" | "error";
    provider: string;
    model: string | null;
    apiKeyConfigured: boolean;
    configured: boolean;
    usable: boolean;
    checkedAt: string | null;
    latencyMs: number | null;
    error: {
      code: "api_key_missing" | "model_missing" | "provider_unsupported" | "request_failed";
      message: string;
    } | null;
  };
}

export type RouteSetupCheckItemStatus = "pass" | "missing" | "warn" | "unknown" | "info";

export interface RouteSetupCheckResponse {
  ok: true;
  schemaVersion: 1;
  check: {
    status: "idle" | "checking" | "ready" | "error";
    checkedAt: string | null;
    items: Array<{
      status: RouteSetupCheckItemStatus;
      message: string;
      section: string | null;
    }>;
    exitCode: number | null;
    error: string | null;
  };
}

export interface QrLoginResponse {
  profileId: string;
  qrUrl: string;
  qrPayload: string;
  qrcode: string;
  expiresInSeconds: number;
  status: string;
}

export interface LoginStatus {
  profileId: string;
  status: string;
  active: boolean;
  connected: boolean;
  accountId?: string | null;
  error?: string | null;
}
