import fs from "node:fs";
import path from "node:path";

import type { TraceFn } from "./trace.js";

export interface RouterAddress {
  host: string;
  port: number;
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

export function loadEnvFile(filePath: string, trace?: TraceFn): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = stripEnvQuotes(trimmed.slice(index + 1).trim());
    if (process.env[key] === undefined) process.env[key] = value;
  }
  trace?.("info", "env", `Loaded ${filePath}`);
  return true;
}

export function loadLocalEnv(trace?: TraceFn): void {
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "../..", ".env.local"),
    path.resolve(import.meta.dirname, "../../../.env.local"),
  ];
  for (const candidate of [...new Set(candidates)]) {
    loadEnvFile(candidate, trace);
  }
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
