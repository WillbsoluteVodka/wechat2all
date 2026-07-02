export interface CodexGuiBridgeTokenWindow {
  label: string;
  remainingText: string | null;
  resetText: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexGuiBridgeTokenUsage {
  windows: CodexGuiBridgeTokenWindow[];
  resetCreditsText: string | null;
}

export interface CodexGuiChat {
  id: string;
  title?: string;
  project?: string;
  projectPath?: string;
  status?: string;
  updatedAt?: number;
  preview?: string;
  modelProvider?: string;
  model?: string;
  archived?: boolean;
}

export interface CodexGuiBinding {
  threadId: string;
  title?: string;
  project?: string;
  boundAt: number;
}

export interface CodexGuiPrompt {
  id?: string;
  text: string;
  threadId?: string;
  replyMode?: CodexGuiReplyMode;
}

export interface CodexGuiPromptResult {
  id: string;
  threadId: string;
  turnId?: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  finalText?: string;
  replyParts?: string[];
  replyMode?: CodexGuiReplyMode;
  error?: string;
}

export type CodexGuiDeliveryMode = "app-server" | "gui-automation";
export type CodexGuiReplyMode = "final" | "silent" | "stream";

export interface CodexGuiPromptInjectionContext {
  threadId?: string;
  threadTitle?: string;
  threadOpenDelayMs?: number;
}

export type CodexGuiPromptInjector = (
  text: string,
  context?: CodexGuiPromptInjectionContext,
) => Promise<void>;

export interface CodexAppServerTransport {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify?(method: string, params?: unknown): void;
  onNotification?(
    handler: (method: string, params: unknown) => void,
  ): () => void;
  close?(): void;
}

export interface CodexGuiBridgeOptions {
  transport?: CodexAppServerTransport;
  codexCommand?: string;
  socketPath?: string;
  autoOpenConfigPath?: string;
  alarmConfigPath?: string;
  enableAlarmScheduler?: boolean;
  defaultThreadId?: string;
  deliveryMode?: CodexGuiDeliveryMode;
  replyMode?: CodexGuiReplyMode;
  guiPromptInjector?: CodexGuiPromptInjector;
  timeoutMs?: number;
  turnTimeoutMs?: number;
  guiPollIntervalMs?: number;
  guiThreadOpenDelayMs?: number;
  listLimit?: number;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
}
