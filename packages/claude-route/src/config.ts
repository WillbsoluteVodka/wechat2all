import os from "node:os";
import path from "node:path";

import type { ClaudeRouteConfig, ClaudeRouteLanguage } from "./types.js";

export interface ClaudeRouteEnvOptions {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function expandPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function language(value: string | undefined): ClaudeRouteLanguage {
  return value?.trim().toLowerCase() === "en" ? "en" : "zh";
}

export function claudeRouteConfigFromEnv(
  opts: ClaudeRouteEnvOptions,
): ClaudeRouteConfig {
  const env = opts.env ?? process.env;
  const rawWorkdir = env.WECHAT2ALL_CLAUDE_WORKDIR ?? env.WECHAT2ALL_CLAUDE_VAULT;
  const rawPromptFile = env.WECHAT2ALL_CLAUDE_PROMPT_FILE;
  const model = env.WECHAT2ALL_CLAUDE_MODEL?.trim() || undefined;
  return {
    workdir: rawWorkdir?.trim() ? expandPath(rawWorkdir) : undefined,
    promptFile: rawPromptFile?.trim()
      ? expandPath(rawPromptFile)
      : path.join(path.resolve(opts.stateDir), "prompt.md"),
    model,
    language: language(env.WECHAT2ALL_CLAUDE_LANGUAGE),
    sessionWindowMs: nonNegativeNumber(
      env.WECHAT2ALL_CLAUDE_SESSION_WINDOW_MINUTES,
      15,
    ) * 60_000,
    maxMediaBytes: positiveNumber(env.WECHAT2ALL_CLAUDE_MAX_MEDIA_MB, 50) * 1024 * 1024,
    maxTurns: positiveInteger(env.WECHAT2ALL_CLAUDE_MAX_TURNS, 40),
    maxBudgetUsd: positiveNumber(env.WECHAT2ALL_CLAUDE_MAX_BUDGET_USD, 1),
    timeoutMs: positiveInteger(env.WECHAT2ALL_CLAUDE_TIMEOUT_MS, 10 * 60_000),
    apiKeyConfigured: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    allowCliAuth: enabled(env.WECHAT2ALL_CLAUDE_ALLOW_CLI_AUTH),
    claudeExecutable: env.WECHAT2ALL_CLAUDE_EXECUTABLE?.trim() || undefined,
  };
}
