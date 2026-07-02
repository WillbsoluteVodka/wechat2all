import type { RuntimeRoute } from "../types.js";

export interface RuntimeSavedCredentials {
  accountId: string;
  token: string;
  baseUrl?: string;
  userId?: string;
  loginAt?: number;
}

export interface RuntimeProcessedMessageRecord {
  key: string;
  profileId: string;
  messageId: string;
  conversationId?: string;
  processedAt: number;
}

export interface RuntimeStateStore {
  loadCredentials(profileId: string): Promise<RuntimeSavedCredentials | null>;
  saveCredentials(profileId: string, credentials: RuntimeSavedCredentials): Promise<void>;
  clearCredentials(profileId: string): Promise<void>;

  loadSyncBuf(profileId: string): Promise<string | undefined>;
  saveSyncBuf(profileId: string, buf: string): Promise<void>;

  loadRoutes(profileId: string): Promise<RuntimeRoute[]>;
  saveRoutes(profileId: string, routes: RuntimeRoute[]): Promise<void>;

  hasProcessedMessage(profileId: string, key: string): Promise<boolean>;
  markProcessedMessage(record: RuntimeProcessedMessageRecord): Promise<void>;
}
