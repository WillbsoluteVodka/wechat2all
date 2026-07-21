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
  createdAt?: number;
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
  projectPath?: string;
  pendingFirstMessage?: boolean;
  pendingGuiNewChat?: boolean;
  pendingGuiNewChatAt?: number;
  boundAt: number;
}

export interface CodexGuiPrompt {
  id?: string;
  text: string;
  threadId?: string;
  replyMode?: CodexGuiReplyMode;
  attachments?: CodexGuiPromptAttachment[];
}

export interface CodexGuiPromptAttachment {
  kind: "image" | "file";
  filePath: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
}

export interface CodexGuiOutputFile {
  kind: "image" | "file";
  filePath: string;
  mimeType?: string;
  source?: string;
}

export interface CodexGuiPromptResult {
  id: string;
  threadId: string;
  turnId?: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  finalText?: string;
  replyParts?: string[];
  outputFiles?: CodexGuiOutputFile[];
  replyMode?: CodexGuiReplyMode;
  error?: string;
}

export type CodexGuiDeliveryMode = "app-server" | "desktop-ipc" | "gui-automation";
export type CodexGuiReplyMode = "final" | "silent" | "stream";

export interface CodexGuiPromptInjectionContext {
  threadId?: string;
  threadTitle?: string;
  threadOpenDelayMs?: number;
  attachmentPaths?: string[];
}

export type CodexGuiPromptInjector = (
  text: string,
  context?: CodexGuiPromptInjectionContext,
) => Promise<void>;

export type CodexGuiThreadOpener = (threadId: string) => Promise<void>;
export type CodexGuiNewChatStarter = () => Promise<void>;

export interface CodexAppServerTransport {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify?(method: string, params?: unknown): void;
  onNotification?(
    handler: (method: string, params: unknown) => void,
  ): () => void;
  /** Invalidates the current app-server session without permanently disposing the transport. */
  reset?(reason?: string): void;
  /** Changes whenever the underlying app-server session is replaced or invalidated. */
  getGeneration?(): number;
  close?(): void;
}

export interface CodexGuiRecoveryResult {
  recovered: boolean;
  threadId?: string;
  detail: string;
}

export interface CodexDesktopThreadSnapshot {
  threadId: string;
  title?: string;
  projectPath?: string;
  updatedAt?: number;
  runtimeStatus?: {
    type: string;
    activeFlags?: unknown[];
  };
  latestTurnStatus?: string;
}

export interface CodexDesktopIpcTransport {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  readThreadSnapshot?(
    threadId: string,
    timeoutMs?: number,
  ): Promise<CodexDesktopThreadSnapshot>;
  close?(): void;
}

export interface CodexGuiBridgeOptions {
  transport?: CodexAppServerTransport;
  desktopIpcTransport?: CodexDesktopIpcTransport;
  codexCommand?: string;
  socketPath?: string;
  desktopIpcSocketPath?: string;
  desktopIpcTimeoutMs?: number;
  desktopIpcThreadOpenDelayMs?: number;
  bindingConfigPath?: string;
  autoOpenConfigPath?: string;
  alarmConfigPath?: string;
  enableAlarmScheduler?: boolean;
  defaultThreadId?: string;
  deliveryMode?: CodexGuiDeliveryMode;
  replyMode?: CodexGuiReplyMode;
  guiPromptInjector?: CodexGuiPromptInjector;
  guiThreadOpener?: CodexGuiThreadOpener;
  guiNewChatStarter?: CodexGuiNewChatStarter;
  timeoutMs?: number;
  turnTimeoutMs?: number;
  maxTurnWaitMs?: number;
  inProgressGraceMs?: number;
  compactionGraceMs?: number;
  guiPollIntervalMs?: number;
  guiThreadOpenDelayMs?: number;
  guiFallbackReconcileMs?: number;
  /** How long GUI delivery may take to become observable through app-server. */
  guiTurnObservationMs?: number;
  guiNewChatDiscoveryMs?: number;
  listLimit?: number;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
}
