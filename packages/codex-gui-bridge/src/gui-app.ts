import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface CodexGuiAppTarget {
  appName: string;
  appPath: string;
  processName: string;
  bundleId?: string;
}

export interface CodexGuiAppTargetOptions {
  env?: NodeJS.ProcessEnv;
  appName?: string;
  appPath?: string;
  processName?: string;
  bundleId?: string;
  pathExists?: (candidate: string) => boolean;
  homeDir?: string;
}

export interface OpenCodexGuiThreadOptions {
  openBin?: string;
}

interface KnownCodexGuiApp {
  appName: string;
  appPath: string;
  processName: string;
  bundleId: string;
}

function stripEnvQuotes(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function knownApps(homeDir: string): KnownCodexGuiApp[] {
  return [
    {
      appName: "ChatGPT",
      appPath: "/Applications/ChatGPT.app",
      processName: "ChatGPT",
      bundleId: "com.openai.codex",
    },
    {
      appName: "Codex",
      appPath: "/Applications/Codex.app",
      processName: "Codex",
      bundleId: "com.openai.codex",
    },
    {
      appName: "ChatGPT",
      appPath: path.join(homeDir, "Applications", "ChatGPT.app"),
      processName: "ChatGPT",
      bundleId: "com.openai.codex",
    },
    {
      appName: "Codex",
      appPath: path.join(homeDir, "Applications", "Codex.app"),
      processName: "Codex",
      bundleId: "com.openai.codex",
    },
  ];
}

function appNameFromPath(appPath: string): string | undefined {
  const base = path.basename(appPath).replace(/\.app$/i, "").trim();
  return base || undefined;
}

export function resolveCodexGuiAppTarget(
  opts: CodexGuiAppTargetOptions = {},
): CodexGuiAppTarget {
  const env = opts.env ?? process.env;
  const pathExists = opts.pathExists ?? existsSync;
  const homeDir = opts.homeDir ?? env.HOME ?? os.homedir();
  const configuredAppName = opts.appName ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_APP_NAME);
  const configuredAppPath = opts.appPath ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_APP_PATH);
  const configuredProcessName = opts.processName ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_PROCESS_NAME);
  const configuredBundleId = opts.bundleId ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_BUNDLE_ID);

  const discovered = knownApps(homeDir).find((candidate) => pathExists(candidate.appPath)) ??
    knownApps(homeDir)[1];
  const appName = configuredAppName ??
    (configuredAppPath ? appNameFromPath(configuredAppPath) : undefined) ??
    discovered.appName;

  return {
    appName,
    appPath: configuredAppPath ??
      (configuredAppName ? `/Applications/${configuredAppName}.app` : discovered.appPath),
    processName: configuredProcessName ?? configuredAppName ??
      (configuredAppPath ? appNameFromPath(configuredAppPath) : undefined) ??
      discovered.processName,
    bundleId: configuredBundleId ??
      (configuredAppName || configuredAppPath ? undefined : discovered.bundleId),
  };
}

export async function openCodexGuiThread(
  threadId: string,
  opts: OpenCodexGuiThreadOptions = {},
): Promise<void> {
  const normalized = threadId.trim();
  if (!normalized) throw new Error("Cannot open an empty Codex thread id.");
  if (process.platform !== "darwin") {
    throw new Error("Opening a Codex GUI thread is currently supported on macOS only.");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      opts.openBin ?? "open",
      [`codex://threads/${encodeURIComponent(normalized)}`],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${opts.openBin ?? "open"} failed while opening Codex thread ${normalized}: ` +
          `code=${code ?? "null"} signal=${signal ?? "null"} ${stderr.trim()}`,
      ));
    });
  });
}
