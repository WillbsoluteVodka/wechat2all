export type PageKey = "home" | "config" | "routes" | "agents" | "trace";

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
  stats: {
    messagesToday: number;
    lastHitAt?: string | null;
  };
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

export interface CodexLocalConfig {
  delivery: "app-server" | "gui-automation";
}

export interface LocalConfigSnapshot {
  configPath: string;
  runtimeApplied: boolean;
  restartRequired: boolean;
  llm: LlmLocalConfig;
  memory: MemoryLocalConfig;
  codex: CodexLocalConfig;
  claude: ClaudeLocalConfig;
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
  codex?: {
    delivery?: "app-server" | "gui-automation" | null;
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

export type UpochiLlmModel = "deepseek-chat" | "gpt-4.1-mini";

export interface UpochiConfigSnapshot {
  projectPath: string;
  envPath: string;
  envExists: boolean;
  restartRequired: boolean;
  llm: {
    endpoint: string | null;
    model: string | null;
    apiKey: SecretConfigStatus;
  };
}

export interface UpochiConfigPatch {
  model?: UpochiLlmModel;
  apiKey?: string | null;
}

export interface UpochiConfigResponse {
  ok: true;
  schemaVersion: 1;
  config: UpochiConfigSnapshot;
}

export interface UpochiConfigUpdateResponse extends UpochiConfigResponse {
  changed: boolean;
  changedFields: string[];
}

export interface UpochiHealthResponse {
  ok: true;
  schemaVersion: 1;
  upochi: {
    status: "ready" | "not-running";
    running: boolean;
    baseUrl: string;
    checkedAt: string;
    latencyMs: number;
    error: string | null;
  };
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

export type CodexSetupCheckItemStatus = "pass" | "missing" | "warn" | "unknown" | "info";

export interface CodexSetupCheckResponse {
  ok: true;
  schemaVersion: 1;
  check: {
    status: "idle" | "checking" | "ready" | "error";
    checkedAt: string | null;
    items: Array<{
      status: CodexSetupCheckItemStatus;
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
