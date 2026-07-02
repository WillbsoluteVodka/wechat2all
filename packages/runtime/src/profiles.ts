import { WeChatClient } from "wechat2all";

import type { RuntimeProfileConfig, RuntimeProfileState } from "./types.js";

export interface RuntimeProfile {
  config: RuntimeProfileConfig;
  client: WeChatClient;
}

export class ProfileRegistry {
  private profiles = new Map<string, RuntimeProfile>();

  upsertProfile(config: RuntimeProfileConfig): RuntimeProfile {
    const existing = this.profiles.get(config.id);
    if (existing) {
      existing.config = { ...existing.config, ...config };
      return existing;
    }

    const client = new WeChatClient({
      accountId: config.credentials?.accountId,
      token: config.credentials?.token,
      baseUrl: config.credentials?.baseUrl,
    });
    const profile: RuntimeProfile = {
      config: { ...config, enabled: config.enabled ?? true },
      client,
    };
    this.profiles.set(config.id, profile);
    return profile;
  }

  getProfile(id: string): RuntimeProfile | undefined {
    return this.profiles.get(id);
  }

  requireProfile(id: string): RuntimeProfile {
    const profile = this.getProfile(id);
    if (!profile) throw new Error(`Unknown runtime profile: ${id}`);
    return profile;
  }

  listProfiles(): RuntimeProfileState[] {
    return [...this.profiles.values()].map((profile) => ({
      id: profile.config.id,
      name: profile.config.name,
      enabled: profile.config.enabled ?? true,
      running: profile.client.isRunning(),
    }));
  }
}
