import type {
  MessageItem,
  WeChatClient,
  WeixinMessage,
} from "wechat2all";
import type { RuntimeMediaPipeline } from "./media/pipeline.js";
import type { RuntimeTTSProvider } from "./media/tts.js";

export type RuntimePlatform = "wechat-ilink";

export type RuntimeMessageKind =
  | "text"
  | "image"
  | "voice"
  | "video"
  | "file"
  | "mixed"
  | "unknown";

export interface RuntimeAttachment {
  id?: string;
  kind: Exclude<RuntimeMessageKind, "text" | "mixed" | "unknown">;
  fileName?: string;
  size?: number;
  durationMs?: number;
  mimeType?: string;
  raw: MessageItem;
}

export interface RuntimeReplyToken {
  userId: string;
  contextToken: string;
}

export interface RuntimeMessage {
  id: string;
  platform: RuntimePlatform;
  profileId: string;
  conversationId: string;
  senderId: string;
  recipientId?: string;
  timestamp: number;
  kind: RuntimeMessageKind;
  text?: string;
  attachments: RuntimeAttachment[];
  replyToken?: RuntimeReplyToken;
  raw: WeixinMessage;
}

export interface RuntimeActionOptions {
  id?: string;
  dedupeKey?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  metadata?: Record<string, unknown>;
}

export type RuntimeAction =
  | ({
      type: "send_text";
      conversationId: string;
      text: string;
      contextToken?: string;
    } & RuntimeActionOptions)
  | ({
      type: "send_media";
      conversationId: string;
      filePath: string;
      caption?: string;
      contextToken?: string;
    } & RuntimeActionOptions)
  | ({
      type: "send_voice";
      conversationId: string;
      filePath: string;
      playtimeMs?: number;
      contextToken?: string;
    } & RuntimeActionOptions)
  | ({
      type: "typing";
      conversationId: string;
      status: "typing" | "cancel";
      contextToken?: string;
    } & RuntimeActionOptions)
  | ({ type: "noop"; reason?: string } & RuntimeActionOptions);

export interface RuntimeActionResult {
  action: RuntimeAction;
  ok: boolean;
  result?: unknown;
  error?: Error;
  attempts?: number;
  deduped?: boolean;
  durationMs?: number;
}

export interface MemoryScope {
  profileId: string;
  connectorId: string;
  conversationId: string;
}

export type MemoryRole = "system" | "user" | "assistant" | "tool";

export interface MemoryMessage {
  id: string;
  scope: MemoryScope;
  role: MemoryRole;
  content: string;
  contentJson?: unknown;
  sourceMessageId?: string;
  createdAt: number;
}

export interface MemoryStore {
  appendMessage(message: MemoryMessage): Promise<void>;
  getRecentMessages(scope: MemoryScope, limit: number): Promise<MemoryMessage[]>;
  clear(scope: MemoryScope): Promise<void>;
}

export interface RuntimeRouteMatch {
  conversationId?: string;
  senderId?: string;
  kind?: RuntimeMessageKind | RuntimeMessageKind[];
  textIncludes?: string | string[];
  /** Matches exact command text or command followed by whitespace, e.g. "/status". */
  textCommands?: string | string[];
}

export interface RuntimeRoute {
  id: string;
  profileId?: string;
  connectorId: string;
  enabled?: boolean;
  priority?: number;
  /** Stop evaluating lower-priority routes after this route matches. */
  terminal?: boolean;
  metadata?: Record<string, unknown>;
  match?: RuntimeRouteMatch;
}

export interface RuntimeRouteManager {
  addRoute(route: RuntimeRoute): void;
  upsertRoute(route: RuntimeRoute): void;
  removeRoute(routeId: string): boolean;
  listRoutes(): RuntimeRoute[];
  setConversationRoute(profileId: string, conversationId: string, routeId: string): void;
  clearConversationRoute(profileId: string, conversationId: string): boolean;
  getConversationRoute(profileId: string, conversationId: string): string | undefined;
}

export interface RuntimeHandlerContext {
  profileId: string;
  connectorId: string;
  client: WeChatClient;
  memory: MemoryStore;
  memoryScope: MemoryScope;
  route: RuntimeRoute;
  routes: RuntimeRouteManager;
  media?: RuntimeMediaPipeline;
  tts?: RuntimeTTSProvider;
  dispatchActions?: (actions: RuntimeAction[]) => Promise<RuntimeActionResult[]>;
}

export type RuntimeHandler = (
  message: RuntimeMessage,
  context: RuntimeHandlerContext,
) => RuntimeAction[] | Promise<RuntimeAction[]>;

export interface RuntimeConnector {
  id: string;
  name?: string;
  handleMessage: RuntimeHandler;
}

export interface RuntimeProfileConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  credentials?: {
    accountId?: string;
    token?: string;
    baseUrl?: string;
  };
}

export interface RuntimeProfileState {
  id: string;
  name?: string;
  enabled: boolean;
  running: boolean;
  lastError?: string;
}

export interface RuntimeEventMap {
  message: [message: RuntimeMessage];
  messageSkipped: [message: RuntimeMessage, reason: string];
  routeMatched: [message: RuntimeMessage, route: RuntimeRoute];
  actions: [message: RuntimeMessage, results: RuntimeActionResult[]];
  error: [error: Error, context?: unknown];
  routesChanged: [routes: RuntimeRoute[]];
  profileStarted: [profile: RuntimeProfileState];
  profileStopped: [profile: RuntimeProfileState];
}
