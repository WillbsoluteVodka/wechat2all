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

export interface LocalConfigSnapshot {
  configPath: string;
  runtimeApplied: boolean;
  restartRequired: boolean;
  llm: LlmLocalConfig;
  memory: MemoryLocalConfig;
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

export interface DashboardSnapshot {
  profile: ProfileStatus;
  routes: RouteSummary[];
  agents: AgentSummary[];
  traces: TraceEvent[];
  settings: SettingsSnapshot;
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
