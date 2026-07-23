import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TraceFn } from "./trace.js";

export interface RouterAddress {
  host: string;
  port: number;
}

export interface LoadEnvFileOptions {
  env?: NodeJS.ProcessEnv;
  override?: boolean;
}

export function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadEnvFile(
  filePath: string,
  trace?: TraceFn,
  options: LoadEnvFileOptions = {},
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  const env = options.env ?? process.env;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = stripEnvQuotes(trimmed.slice(index + 1).trim());
    if (options.override || env[key] === undefined) env[key] = value;
  }
  trace?.("info", "env", `Loaded ${filePath}`);
  return true;
}

export function persistentLocalEnvPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homedir = os.homedir(),
): string {
  if (platform === "darwin") {
    return path.join(
      homedir,
      "Library",
      "Application Support",
      "WeConnect",
      "config",
      ".env.local",
    );
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "WeConnect", "config", ".env.local");
  }
  return path.join(
    env.XDG_CONFIG_HOME ?? path.join(homedir, ".config"),
    "weconnect",
    ".env.local",
  );
}

export function localEnvCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.WECHAT2ALL_ENV_FILE?.trim();
  if (explicit) return [path.resolve(explicit)];
  return [...new Set([
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "../..", ".env.local"),
    path.resolve(import.meta.dirname, "../../../.env.local"),
    persistentLocalEnvPath(env),
  ])];
}

export function resolveLocalEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = localEnvCandidates(env);
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) return existing;
  const projectRoot = candidates.find((candidate) =>
    fs.existsSync(path.join(path.dirname(candidate), ".env.example"))
  );
  return projectRoot ?? candidates.at(-1) ?? candidates[0];
}

export function loadLocalEnv(
  trace?: TraceFn,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = resolveLocalEnvPath(env);
  // The Config UI reads the saved file as authoritative. Apply the same
  // precedence at startup so runtime, health checks, and route packages see
  // exactly the values that the UI reported as saved.
  const loaded = loadEnvFile(filePath, trace, { env, override: true });
  if (!loaded) {
    trace?.("info", "env", `Local config will be created at ${filePath}`);
  }
  env.WECHAT2ALL_ENV_FILE = filePath;
  return filePath;
}

export function envNumber(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function readRouterAddress(env: NodeJS.ProcessEnv = process.env): RouterAddress {
  return {
    host: env.WECHAT2ALL_ROUTER_HOST ?? "127.0.0.1",
    port: envNumber("WECHAT2ALL_ROUTER_PORT", env) ?? 39787,
  };
}
