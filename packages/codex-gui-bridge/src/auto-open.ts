import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodexGuiAutoOpenState {
  enabled: boolean;
  updatedAt?: number;
}

export interface CodexGuiAutoOpenPathOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export interface CodexGuiOpenOptions extends CodexGuiAutoOpenPathOptions {
  appName?: string;
  appPath?: string;
  bundleId?: string;
  processName?: string;
  dryRun?: boolean;
  quiet?: boolean;
  force?: boolean;
  platform?: NodeJS.Platform;
  commandRunner?: CommandRunner;
}

export interface CodexGuiOpenResult {
  enabled: boolean;
  alreadyOpen: boolean;
  opened: boolean;
  dryRun: boolean;
  skippedReason?: string;
  appTarget?: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: Error;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

function stripEnvQuotes(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = stripEnvQuotes(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function defaultCommandRunner(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        error: error instanceof Error ? error : undefined,
      });
    });
  });
}

function stateBaseDir(env: NodeJS.ProcessEnv): string {
  return stripEnvQuotes(env.WECHAT2ALL_STATE_DIR) ??
    path.join(os.homedir(), ".wechat2all-runtime-bot");
}

export function codexGuiAutoOpenConfigPath(
  opts: CodexGuiAutoOpenPathOptions = {},
): string {
  const env = opts.env ?? process.env;
  return opts.configPath ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_AUTOOPEN_FILE) ??
    path.join(stateBaseDir(env), "codex-gui-bridge", "autoopen.json");
}

export async function readCodexGuiAutoOpen(
  opts: CodexGuiAutoOpenPathOptions = {},
): Promise<CodexGuiAutoOpenState> {
  const configPath = codexGuiAutoOpenConfigPath(opts);
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CodexGuiAutoOpenState>;
    return {
      enabled: parsed.enabled === true,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { enabled: false };
    throw error;
  }
}

export async function writeCodexGuiAutoOpen(
  enabled: boolean,
  opts: CodexGuiAutoOpenPathOptions = {},
): Promise<CodexGuiAutoOpenState> {
  const configPath = codexGuiAutoOpenConfigPath(opts);
  const state = {
    enabled,
    updatedAt: Date.now(),
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  return state;
}

async function isProcessRunning(
  processName: string,
  commandRunner: CommandRunner,
): Promise<boolean> {
  const result = await commandRunner("/usr/bin/pgrep", ["-x", processName]);
  return result.ok && result.stdout.trim().length > 0;
}

async function isAppBundleRunning(
  appPath: string,
  commandRunner: CommandRunner,
): Promise<boolean> {
  const result = await commandRunner("/usr/bin/pgrep", [
    "-f",
    `${appPath.replace(/\/$/, "")}/Contents/`,
  ]);
  return result.ok && result.stdout.trim().length > 0;
}

async function isCodexRunning(args: {
  appPath: string;
  processName: string;
  commandRunner: CommandRunner;
}): Promise<boolean> {
  if (await isAppBundleRunning(args.appPath, args.commandRunner)) return true;
  return isProcessRunning(args.processName, args.commandRunner);
}

function openArgs(args: {
  appName: string;
  appPath: string;
  bundleId?: string;
}): string[] {
  if (args.bundleId) return ["-b", args.bundleId];
  if (args.appPath) return [args.appPath];
  return ["-a", args.appName];
}

function log(quiet: boolean | undefined, message: string): void {
  if (!quiet) console.log(`[wechat2all-codex-open] ${message}`);
}

export async function ensureCodexGuiOpen(
  opts: CodexGuiOpenOptions = {},
): Promise<CodexGuiOpenResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const commandRunner = opts.commandRunner ?? defaultCommandRunner;
  const appName = opts.appName ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_APP_NAME) ??
    "Codex";
  const appPath = opts.appPath ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_APP_PATH) ??
    `/Applications/${appName}.app`;
  const processName = opts.processName ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_PROCESS_NAME) ??
    appName;
  const bundleId = opts.bundleId ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_BUNDLE_ID);
  const autoOpenOverride = parseBoolean(env.WECHAT2ALL_CODEX_AUTOOPEN);
  const state = opts.force || autoOpenOverride === true
    ? { enabled: true }
    : autoOpenOverride === false
      ? { enabled: false }
      : await readCodexGuiAutoOpen(opts);

  if (!state.enabled) {
    return {
      enabled: false,
      alreadyOpen: false,
      opened: false,
      dryRun: opts.dryRun === true,
      skippedReason: "disabled",
    };
  }

  if (platform !== "darwin") {
    log(opts.quiet, "skipped: macOS only");
    return {
      enabled: true,
      alreadyOpen: false,
      opened: false,
      dryRun: opts.dryRun === true,
      skippedReason: "macos-only",
      appTarget: bundleId ?? appPath,
    };
  }

  if (await isCodexRunning({ appPath, processName, commandRunner })) {
    log(opts.quiet, `${processName} is already open`);
    return {
      enabled: true,
      alreadyOpen: true,
      opened: false,
      dryRun: opts.dryRun === true,
      appTarget: bundleId ?? appPath,
    };
  }

  const args = openArgs({ appName, appPath, bundleId });
  const appTarget = args.join(" ");
  log(opts.quiet, `${processName} is not open; opening ${bundleId ?? appPath ?? appName}`);
  if (opts.dryRun) {
    log(opts.quiet, `dry-run: would run /usr/bin/open ${appTarget}`);
    return {
      enabled: true,
      alreadyOpen: false,
      opened: false,
      dryRun: true,
      appTarget: bundleId ?? appPath,
    };
  }

  const result = await commandRunner("/usr/bin/open", args);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.error?.message || "unknown error";
    throw new Error(`failed to open Codex GUI: ${detail}`);
  }

  return {
    enabled: true,
    alreadyOpen: false,
    opened: true,
    dryRun: false,
    appTarget: bundleId ?? appPath,
  };
}
