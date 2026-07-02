import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodexGuiAlarmState {
  enabled: boolean;
  timeText?: string;
  nextFireAt?: number;
  updatedAt?: number;
  lastFiredAt?: number;
  lastError?: string;
}

export interface CodexGuiAlarmPathOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

function stripEnvQuotes(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function stateBaseDir(env: NodeJS.ProcessEnv): string {
  return stripEnvQuotes(env.WECHAT2ALL_STATE_DIR) ??
    path.join(os.homedir(), ".wechat2all-runtime-bot");
}

export function codexGuiAlarmConfigPath(opts: CodexGuiAlarmPathOptions = {}): string {
  const env = opts.env ?? process.env;
  return opts.configPath ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_ALARM_FILE) ??
    path.join(stateBaseDir(env), "codex-gui-bridge", "alarm.json");
}

export function parseCodexGuiAlarmTime(value: string): {
  hour: number;
  minute: number;
  timeText: string;
} {
  const normalized = value.trim();
  const match = normalized.match(/^([01]?\d|2[0-3])(?::([0-5]\d))?$/);
  if (!match) {
    throw new Error("Use 24-hour time, for example /alarm 09:30 or /alarm 21:00.");
  }
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  return {
    hour,
    minute,
    timeText: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function nextAlarmFireAt(params: {
  hour: number;
  minute: number;
  now?: number;
}): number {
  const nowMs = params.now ?? Date.now();
  const next = new Date(nowMs);
  next.setHours(params.hour, params.minute, 0, 0);
  if (next.getTime() <= nowMs) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

export async function readCodexGuiAlarm(
  opts: CodexGuiAlarmPathOptions = {},
): Promise<CodexGuiAlarmState> {
  const configPath = codexGuiAlarmConfigPath(opts);
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CodexGuiAlarmState>;
    return {
      enabled: parsed.enabled === true,
      timeText: typeof parsed.timeText === "string" ? parsed.timeText : undefined,
      nextFireAt: typeof parsed.nextFireAt === "number" ? parsed.nextFireAt : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
      lastFiredAt: typeof parsed.lastFiredAt === "number" ? parsed.lastFiredAt : undefined,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { enabled: false };
    throw error;
  }
}

export async function writeCodexGuiAlarm(
  state: CodexGuiAlarmState,
  opts: CodexGuiAlarmPathOptions = {},
): Promise<CodexGuiAlarmState> {
  const configPath = codexGuiAlarmConfigPath(opts);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  return state;
}

export function disabledCodexGuiAlarmState(): CodexGuiAlarmState {
  return {
    enabled: false,
    updatedAt: Date.now(),
  };
}

export function scheduledCodexGuiAlarmState(params: {
  timeText: string;
  now?: number;
  lastFiredAt?: number;
  lastError?: string;
}): CodexGuiAlarmState {
  const parsed = parseCodexGuiAlarmTime(params.timeText);
  return {
    enabled: true,
    timeText: parsed.timeText,
    nextFireAt: nextAlarmFireAt({
      hour: parsed.hour,
      minute: parsed.minute,
      now: params.now,
    }),
    updatedAt: Date.now(),
    lastFiredAt: params.lastFiredAt,
    lastError: params.lastError,
  };
}
