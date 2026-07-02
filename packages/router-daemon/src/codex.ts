import path from "node:path";

import { createCodexGuiBridgeClientFromEnv } from "@wechat2all/codex-gui-bridge";
import {
  createFileCodexBridgeClient,
  type CodexBridgeClient,
} from "@wechat2all/runtime";

export interface CodexBridgeStateStore {
  profileDir(profileId: string): string;
}

export function codexBackend(env: NodeJS.ProcessEnv = process.env): string {
  return env.WECHAT2ALL_CODEX_BACKEND ?? "file";
}

export function createCodexBridgeFromEnv(opts: {
  stateStore: CodexBridgeStateStore;
  profileId: string;
  env?: NodeJS.ProcessEnv;
}): CodexBridgeClient {
  const env = opts.env ?? process.env;
  if (codexBackend(env) === "gui-app-server") {
    return createCodexGuiBridgeClientFromEnv({ env });
  }
  return createFileCodexBridgeClient({
    baseDir: path.join(opts.stateStore.profileDir(opts.profileId), "codex-bridge"),
  });
}
