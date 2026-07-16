export type ClaudeRouteLanguage = "en" | "zh";

export interface ClaudeRouteConfig {
  workdir?: string;
  promptFile: string;
  model?: string;
  language: ClaudeRouteLanguage;
  sessionWindowMs: number;
  maxMediaBytes: number;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  apiKeyConfigured: boolean;
  allowCliAuth: boolean;
  claudeExecutable?: string;
}

export interface ClaudeRouteOutputFile {
  kind: "image" | "file";
  filePath: string;
  caption?: string;
  mimeType?: string;
}

export interface ClaudeAgentRunRequest {
  prompt: string;
  systemPrompt: string;
  config: ClaudeRouteConfig;
  resumeSessionId?: string;
}

export interface ClaudeAgentRunResult {
  text?: string;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  outputs: ClaudeRouteOutputFile[];
  resetSessionRequested?: boolean;
}

export interface ClaudeAgentAvailability {
  available: boolean;
  reason?: string;
}

export interface ClaudeAgentRunner {
  run(request: ClaudeAgentRunRequest): Promise<ClaudeAgentRunResult>;
  availability?(): Promise<ClaudeAgentAvailability>;
}

export interface ClaudeStoredSession {
  sessionId: string;
  updatedAt: number;
}

export interface ClaudeSessionStore {
  get(key: string): Promise<ClaudeStoredSession | null>;
  set(key: string, value: ClaudeStoredSession): Promise<void>;
  clear(key: string): Promise<void>;
}
