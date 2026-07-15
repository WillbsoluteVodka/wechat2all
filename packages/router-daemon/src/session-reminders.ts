import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { RuntimeMessage } from "@wechat2all/runtime";

export interface SessionReminderTarget {
  userId: string;
  contextToken: string;
  updatedAt: number;
}

export interface SessionReminderEvent {
  target: SessionReminderTarget;
  loginAt: number;
  expiresAt: number;
  remainingMs: number;
  scheduledAt: number;
}

export interface SessionReminderServiceOptions {
  statePath: string;
  sessionDurationMs?: number;
  reminderIntervalMs?: number;
  now?: () => number;
  onReminder: (event: SessionReminderEvent) => void | Promise<void>;
  onError?: (error: Error) => void;
  onSkipped?: (reason: string) => void;
}

interface ActiveSession {
  loginAt: number;
  expiresAt: number;
  ownerUserId?: string;
}

interface PersistedReminderState {
  version: 1;
  target?: SessionReminderTarget;
}

const DEFAULT_SESSION_DURATION_MS = 24 * 60 * 60_000;
const DEFAULT_REMINDER_INTERVAL_MS = 60 * 60_000;

function positiveMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function isReminderTarget(value: unknown): value is SessionReminderTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SessionReminderTarget>;
  return (
    typeof candidate.userId === "string" && candidate.userId.length > 0 &&
    typeof candidate.contextToken === "string" && candidate.contextToken.length > 0 &&
    typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
  );
}

async function readState(filePath: string): Promise<PersistedReminderState> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      version?: unknown;
      target?: unknown;
    };
    return {
      version: 1,
      target: isReminderTarget(parsed.target) ? parsed.target : undefined,
    };
  } catch {
    return { version: 1 };
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function sessionExpiresAt(loginAt: number, durationMs: number): number {
  return loginAt + positiveMs(durationMs, DEFAULT_SESSION_DURATION_MS);
}

export function nextSessionReminderAt(params: {
  loginAt: number;
  now: number;
  sessionDurationMs?: number;
  reminderIntervalMs?: number;
}): number | undefined {
  const durationMs = positiveMs(
    params.sessionDurationMs,
    DEFAULT_SESSION_DURATION_MS,
  );
  const intervalMs = positiveMs(
    params.reminderIntervalMs,
    DEFAULT_REMINDER_INTERVAL_MS,
  );
  const expiresAt = params.loginAt + durationMs;
  if (params.now >= expiresAt) return undefined;
  const elapsedMs = Math.max(0, params.now - params.loginAt);
  const nextSlot = Math.floor(elapsedMs / intervalMs) + 1;
  const nextAt = params.loginAt + nextSlot * intervalMs;
  return nextAt < expiresAt ? nextAt : undefined;
}

export async function readSessionReminderTarget(
  statePath: string,
): Promise<SessionReminderTarget | undefined> {
  return (await readState(statePath)).target;
}

export class SessionReminderService {
  readonly statePath: string;
  private readonly sessionDurationMs: number;
  private readonly reminderIntervalMs: number;
  private readonly now: () => number;
  private readonly onReminder: SessionReminderServiceOptions["onReminder"];
  private readonly onError?: SessionReminderServiceOptions["onError"];
  private readonly onSkipped?: SessionReminderServiceOptions["onSkipped"];
  private activeSession?: ActiveSession;
  private target?: SessionReminderTarget;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private stateWrite: Promise<void> = Promise.resolve();

  constructor(opts: SessionReminderServiceOptions) {
    this.statePath = path.resolve(opts.statePath);
    this.sessionDurationMs = positiveMs(
      opts.sessionDurationMs,
      DEFAULT_SESSION_DURATION_MS,
    );
    this.reminderIntervalMs = positiveMs(
      opts.reminderIntervalMs,
      DEFAULT_REMINDER_INTERVAL_MS,
    );
    this.now = opts.now ?? Date.now;
    this.onReminder = opts.onReminder;
    this.onError = opts.onError;
    this.onSkipped = opts.onSkipped;
  }

  async initialize(): Promise<void> {
    this.target = await readSessionReminderTarget(this.statePath);
  }

  async startSession(params: {
    loginAt: number;
    ownerUserId?: string;
    resetTarget?: boolean;
  }): Promise<void> {
    if (!Number.isFinite(params.loginAt) || params.loginAt <= 0) {
      throw new Error("Session loginAt must be a positive epoch timestamp.");
    }
    this.stopTimer();
    this.generation += 1;
    this.activeSession = {
      loginAt: params.loginAt,
      expiresAt: sessionExpiresAt(params.loginAt, this.sessionDurationMs),
      ownerUserId: params.ownerUserId,
    };

    if (
      params.resetTarget ||
      (params.ownerUserId && this.target?.userId !== params.ownerUserId)
    ) {
      await this.clearTarget();
    }
    this.scheduleNext();
  }

  stopSession(): void {
    this.generation += 1;
    this.activeSession = undefined;
    this.stopTimer();
  }

  close(): void {
    this.stopSession();
  }

  async clearTarget(): Promise<void> {
    this.target = undefined;
    await this.queueStateWrite(undefined);
  }

  async captureMessage(message: RuntimeMessage): Promise<boolean> {
    const replyToken = message.replyToken;
    if (!replyToken || !this.activeSession) return false;
    if (
      this.activeSession.ownerUserId &&
      replyToken.userId !== this.activeSession.ownerUserId
    ) {
      return false;
    }
    if (
      this.target?.userId === replyToken.userId &&
      this.target.contextToken === replyToken.contextToken
    ) {
      return false;
    }

    this.target = {
      userId: replyToken.userId,
      contextToken: replyToken.contextToken,
      updatedAt: this.now(),
    };
    await this.queueStateWrite(this.target);
    return true;
  }

  private queueStateWrite(target: SessionReminderTarget | undefined): Promise<void> {
    const run = this.stateWrite.then(async () => {
      if (!target) {
        await fs.rm(this.statePath, { force: true });
        return;
      }
      await writePrivateJson(this.statePath, { version: 1, target });
    });
    this.stateWrite = run.catch(() => undefined);
    return run;
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNext(referenceNow = this.now()): void {
    const session = this.activeSession;
    if (!session) return;
    const nextAt = nextSessionReminderAt({
      loginAt: session.loginAt,
      now: referenceNow,
      sessionDurationMs: this.sessionDurationMs,
      reminderIntervalMs: this.reminderIntervalMs,
    });
    if (nextAt === undefined) return;

    const generation = this.generation;
    this.timer = setTimeout(() => {
      void this.fire(generation, nextAt);
    }, Math.max(0, nextAt - this.now()));
    this.timer.unref?.();
  }

  private async fire(generation: number, scheduledAt: number): Promise<void> {
    if (generation !== this.generation || !this.activeSession) return;
    this.timer = undefined;
    const session = this.activeSession;
    const now = this.now();
    const remainingMs = session.expiresAt - now;
    if (remainingMs <= 0) return;

    if (!this.target) {
      this.onSkipped?.("No WeChat context token is available for the session owner.");
    } else {
      try {
        await this.onReminder({
          target: this.target,
          loginAt: session.loginAt,
          expiresAt: session.expiresAt,
          remainingMs,
          scheduledAt,
        });
      } catch (error) {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (generation === this.generation) {
      this.scheduleNext(Math.max(this.now(), scheduledAt));
    }
  }
}
