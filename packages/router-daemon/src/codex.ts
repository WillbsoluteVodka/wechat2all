import { createCodexGuiBridgeClientFromEnv } from "@wechat2all/codex-gui-bridge";
import type { CodexBridgeClient } from "@wechat2all/runtime";

import {
  runCodexSetupCheck,
  type CodexSetupCheckItem,
} from "./codex-setup-check.js";

let setupCheckStarted = false;
let setupCheckInFlight: Promise<CodexSetupCheckSnapshot> | undefined;
let setupCheckState: CodexSetupCheckSnapshot = {
  status: "idle",
  checkedAt: null,
  items: [],
  exitCode: null,
  error: null,
};

export interface CodexSetupCheckSnapshot {
  status: "idle" | "checking" | "ready" | "error";
  checkedAt: string | null;
  items: CodexSetupCheckItem[];
  exitCode: number | null;
  error: string | null;
}

export function getCodexSetupCheckSnapshot(): CodexSetupCheckSnapshot {
  return {
    ...setupCheckState,
    items: setupCheckState.items.map((item) => ({ ...item })),
  };
}

export function refreshCodexSetupCheck(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexSetupCheckSnapshot> {
  if (setupCheckInFlight) return setupCheckInFlight;
  setupCheckState = {
    ...setupCheckState,
    status: "checking",
    items: [],
    exitCode: null,
    error: null,
  };
  setupCheckInFlight = runCodexSetupCheck({
    env,
    onItem(item) {
      setupCheckState = {
        ...setupCheckState,
        items: [...setupCheckState.items, item],
      };
    },
  })
    .then((result) => {
      setupCheckState = {
        status: result.started ? "ready" : "error",
        checkedAt: new Date().toISOString(),
        items: result.items,
        exitCode: result.exitCode ?? null,
        error: result.started ? null : result.error ?? "Codex setup check could not start.",
      };
      return getCodexSetupCheckSnapshot();
    })
    .catch((error: unknown) => {
      setupCheckState = {
        ...setupCheckState,
        status: "error",
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      return getCodexSetupCheckSnapshot();
    })
    .finally(() => {
      setupCheckInFlight = undefined;
    });
  return setupCheckInFlight;
}

export function startCodexSetupCheckAfterStartup(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (setupCheckStarted) return;
  setupCheckStarted = true;
  void refreshCodexSetupCheck(env).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[codex-route/setup-check] unexpected failure: ${message}`);
  });
}

export function codexBackend(env: NodeJS.ProcessEnv = process.env): string {
  void env;
  return "gui-app-server";
}

export function createCodexBridgeFromEnv(opts: {
  env?: NodeJS.ProcessEnv;
} = {}): CodexBridgeClient {
  const env = opts.env ?? process.env;
  return createCodexGuiBridgeClientFromEnv({
    env,
    enableAlarmScheduler: true,
  });
}
