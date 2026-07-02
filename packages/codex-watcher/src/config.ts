import path from "node:path";

import { CodexBridgeStore, codexBridgeDirFromEnv } from "@wechat2all/codex-mcp/bridge";

import {
  CodexCliExecutor,
  EchoCodexExecutor,
  type CodexExecutionMode,
  type CodexPromptExecutor,
} from "./executor.js";

export interface WatcherCliConfig {
  bridgeDir: string;
  mode: CodexExecutionMode;
  once: boolean;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  retryDelayMs: number;
  processExisting: boolean;
  timeoutMs: number;
  codexBin: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  sendAck: boolean;
  sendResult: boolean;
  sendErrors: boolean;
  maxWechatMessageChars: number;
  currentProject: string;
  currentThreadId: string;
  bypassApprovalsAndSandbox: boolean;
  extraArgs: string[];
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function envNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const value = env[key];
  if (!value) return fallback;
  const parsed = Number(stripEnvQuotes(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const value = env[key];
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(stripEnvQuotes(value));
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasArg(args: string[], name: string): boolean {
  return args.includes(name);
}

function readMode(value: string | undefined): CodexExecutionMode {
  if (
    value === "resume-last" ||
    value === "resume-session" ||
    value === "exec" ||
    value === "echo"
  ) {
    return value;
  }
  return "resume-last";
}

function readExtraArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.WECHAT2ALL_CODEX_EXTRA_ARGS;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return raw.split(/\s+/).filter(Boolean);
  }
}

function defaultCodexBin(): string {
  return "/Applications/Codex.app/Contents/Resources/codex";
}

export function parseWatcherCliConfig(
  argv = process.argv.slice(2),
  env = process.env,
): WatcherCliConfig {
  const bridgeDir = readArg(argv, "--bridge-dir") ??
    env.WECHAT2ALL_CODEX_BRIDGE_DIR ??
    codexBridgeDirFromEnv(env);
  const mode = readMode(readArg(argv, "--mode") ?? env.WECHAT2ALL_CODEX_WATCH_MODE);
  return {
    bridgeDir: path.resolve(stripEnvQuotes(bridgeDir)),
    mode,
    once: hasArg(argv, "--once") || envBool(env, "WECHAT2ALL_CODEX_WATCH_ONCE", false),
    pollIntervalMs: Number(readArg(argv, "--poll-ms")) ||
      envNumber(env, "WECHAT2ALL_CODEX_POLL_MS", 1500),
    batchSize: Number(readArg(argv, "--batch-size")) ||
      envNumber(env, "WECHAT2ALL_CODEX_BATCH_SIZE", 1),
    maxAttempts: Number(readArg(argv, "--max-attempts")) ||
      envNumber(env, "WECHAT2ALL_CODEX_MAX_ATTEMPTS", 3),
    retryDelayMs: Number(readArg(argv, "--retry-ms")) ||
      envNumber(env, "WECHAT2ALL_CODEX_RETRY_MS", 30_000),
    processExisting: hasArg(argv, "--process-existing") ||
      envBool(env, "WECHAT2ALL_CODEX_PROCESS_EXISTING", false),
    timeoutMs: Number(readArg(argv, "--timeout-ms")) ||
      envNumber(env, "WECHAT2ALL_CODEX_TIMEOUT_MS", 10 * 60 * 1000),
    codexBin: readArg(argv, "--codex-bin") ??
      stripEnvQuotes(env.WECHAT2ALL_CODEX_BIN ?? defaultCodexBin()),
    sessionId: readArg(argv, "--session-id") ??
      (env.WECHAT2ALL_CODEX_SESSION_ID
        ? stripEnvQuotes(env.WECHAT2ALL_CODEX_SESSION_ID)
        : undefined),
    cwd: readArg(argv, "--cwd") ??
      (env.WECHAT2ALL_CODEX_CWD ? path.resolve(stripEnvQuotes(env.WECHAT2ALL_CODEX_CWD)) : undefined),
    model: readArg(argv, "--model") ??
      (env.WECHAT2ALL_CODEX_MODEL ? stripEnvQuotes(env.WECHAT2ALL_CODEX_MODEL) : undefined),
    sendAck: !hasArg(argv, "--no-ack") &&
      envBool(env, "WECHAT2ALL_CODEX_SEND_ACK", true),
    sendResult: !hasArg(argv, "--no-result") &&
      envBool(env, "WECHAT2ALL_CODEX_SEND_RESULT", true),
    sendErrors: !hasArg(argv, "--no-errors") &&
      envBool(env, "WECHAT2ALL_CODEX_SEND_ERRORS", true),
    maxWechatMessageChars: Number(readArg(argv, "--max-wechat-chars")) ||
      envNumber(env, "WECHAT2ALL_CODEX_MAX_WECHAT_CHARS", 3500),
    currentProject: readArg(argv, "--project") ??
      stripEnvQuotes(env.WECHAT2ALL_CODEX_PROJECT ?? "wechat2all"),
    currentThreadId: readArg(argv, "--thread-id") ??
      stripEnvQuotes(env.WECHAT2ALL_CODEX_THREAD_ID ?? "codex-watcher"),
    bypassApprovalsAndSandbox: hasArg(argv, "--dangerously-bypass-approvals-and-sandbox") ||
      envBool(env, "WECHAT2ALL_CODEX_BYPASS_SANDBOX", false),
    extraArgs: readExtraArgs(env),
  };
}

export function createStoreFromConfig(config: WatcherCliConfig): CodexBridgeStore {
  return new CodexBridgeStore(config.bridgeDir);
}

export function createExecutorFromConfig(
  config: WatcherCliConfig,
): CodexPromptExecutor {
  if (config.mode === "echo") return new EchoCodexExecutor();
  return new CodexCliExecutor({
    command: config.codexBin,
    mode: config.mode,
    sessionId: config.sessionId,
    cwd: config.cwd,
    model: config.model,
    timeoutMs: config.timeoutMs,
    extraArgs: config.extraArgs,
    bypassApprovalsAndSandbox: config.bypassApprovalsAndSandbox,
  });
}
