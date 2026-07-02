export type PageKey = "wechat" | "routes" | "agents" | "trace" | "settings";

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
