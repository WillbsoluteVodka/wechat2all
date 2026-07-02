import { createCodexGuiBridgeClientFromEnv } from "@wechat2all/codex-gui-bridge";
import type { CodexBridgeClient } from "@wechat2all/runtime";

export function codexBackend(env: NodeJS.ProcessEnv = process.env): string {
  void env;
  return "gui-app-server";
}

export function createCodexBridgeFromEnv(opts: {
  env?: NodeJS.ProcessEnv;
} = {}): CodexBridgeClient {
  const env = opts.env ?? process.env;
  return createCodexGuiBridgeClientFromEnv({ env });
}
