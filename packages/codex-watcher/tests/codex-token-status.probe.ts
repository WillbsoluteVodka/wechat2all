import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type JsonRecord = Record<string, unknown>;
type SourceMode = "auto" | "app-server" | "rollout";
type SourceKind = "app-server-rate-limits" | "rollout-token-count";

interface ProbeOptions {
  codexHome: string;
  json: boolean;
  source: SourceMode;
  timeoutMs: number;
  threadId?: string;
  rolloutPath?: string;
}

interface ThreadRow {
  id: string;
  title: string | null;
  cwd: string | null;
  rolloutPath: string;
  recencyAt: string | null;
  updatedAt: string | null;
}

interface RawTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface RawRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface RawRateLimits {
  limit_id?: string;
  limit_name?: string;
  primary?: RawRateLimitWindow;
  secondary?: RawRateLimitWindow;
  credits?: unknown;
  individual_limit?: unknown;
  plan_type?: unknown;
  rate_limit_reached_type?: string | null;
}

interface RawTokenCountPayload {
  type?: string;
  info?: {
    total_token_usage?: RawTokenUsage;
    last_token_usage?: RawTokenUsage;
    model_context_window?: number;
  };
  rate_limits?: RawRateLimits;
}

interface RawTokenCountEvent {
  timestamp?: string;
  type?: string;
  payload?: RawTokenCountPayload;
}

interface AppServerInitializeResult {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

interface AppServerRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface AppServerRateLimits {
  limitId?: string;
  limitName?: string | null;
  primary?: AppServerRateLimitWindow | null;
  secondary?: AppServerRateLimitWindow | null;
  credits?: unknown;
  individualLimit?: unknown;
  planType?: unknown;
  rateLimitReachedType?: string | null;
}

interface AppServerRateLimitResetCredits {
  availableCount?: number | string;
}

interface AppServerRateLimitsResponse {
  rateLimits?: AppServerRateLimits | null;
  rateLimitsByLimitId?: Record<string, AppServerRateLimits | null> | null;
  rateLimitResetCredits?: AppServerRateLimitResetCredits | null;
}

interface JsonRpcErrorPayload {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

interface RateLimitWindowStatus {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  resetsAtLocal: string | null;
  resetsInMs: number | null;
  resetsIn: string | null;
}

interface RateLimitSummary {
  limitId: string | null;
  limitName: string | null;
  rateLimitReachedType: string | null;
  primary: RateLimitWindowStatus | null;
  secondary: RateLimitWindowStatus | null;
  credits: unknown;
  planType: unknown;
  individualLimit: unknown;
}

interface CodexTokenStatus {
  generatedAt: string;
  codexHome: string;
  sourceKind: SourceKind;
  note: string;
  source: {
    stateDb: string;
    rolloutPath: string | null;
    appServer: {
      command: string;
      method: string;
      userAgent: string | null;
    } | null;
  };
  diagnostics: string[];
  thread: ThreadRow | null;
  tokenEvent: {
    timestamp: string | null;
    modelContextWindow: number | null;
    totalTokenUsage: RawTokenUsage | null;
    lastTokenUsage: RawTokenUsage | null;
  } | null;
  rateLimits: RateLimitSummary | null;
  rateLimitsByLimitId: Record<string, RateLimitSummary> | null;
  rateLimitResetCredits: {
    availableCount: number | null;
  } | null;
}

function parseArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = {
    codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    json: false,
    source: "auto",
    timeoutMs: 8_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--source") {
      const value = argv[index + 1];
      if (!value) throw new Error("--source requires app-server, rollout, or auto");
      if (value !== "app-server" && value !== "rollout" && value !== "auto") {
        throw new Error("--source must be app-server, rollout, or auto");
      }
      options.source = value;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms requires a positive number");
      options.timeoutMs = value;
      index += 1;
      continue;
    }
    if (arg === "--codex-home") {
      const value = argv[index + 1];
      if (!value) throw new Error("--codex-home requires a path");
      options.codexHome = expandHome(value);
      index += 1;
      continue;
    }
    if (arg === "--thread-id") {
      const value = argv[index + 1];
      if (!value) throw new Error("--thread-id requires an id");
      options.threadId = value;
      index += 1;
      continue;
    }
    if (arg === "--rollout-path") {
      const value = argv[index + 1];
      if (!value) throw new Error("--rollout-path requires a path");
      options.rolloutPath = expandHome(value);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  console.log([
    "Usage: pnpm codex-token-probe [--json] [--source auto|app-server|rollout] [--thread-id <id>] [--rollout-path <path>] [--codex-home <path>]",
    "",
    "Default source is auto: read Codex app-server account/rateLimits/read first, then",
    "fall back to the latest local rollout token_count event if app-server is unavailable.",
    "",
    "The app-server source is the one that matches the Codex GUI Usage remaining panel.",
    "The rollout source is useful for debugging a thread, but it can show a per-model bucket",
    "such as codex_bengalfox and should not be treated as the GUI account usage source.",
  ].join("\n"));
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sqliteJson<T extends JsonRecord>(dbPath: string, sql: string, diagnostics: string[]): T[] {
  if (!fs.existsSync(dbPath)) {
    diagnostics.push(`missing sqlite db: ${dbPath}`);
    return [];
  }

  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    diagnostics.push(`sqlite3 failed for ${dbPath}: ${result.error.message}`);
    return [];
  }
  if (result.status !== 0) {
    diagnostics.push(`sqlite3 failed for ${dbPath}: ${result.stderr.trim()}`);
    return [];
  }

  const text = result.stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text) as T[];
  } catch (error) {
    diagnostics.push(`failed to parse sqlite json from ${dbPath}: ${String(error)}`);
    return [];
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function msToIso(value: unknown): string | null {
  const ms = asNumber(value);
  return ms && ms > 0 ? new Date(ms).toISOString() : null;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function resolveThread(options: ProbeOptions, stateDb: string, diagnostics: string[]): ThreadRow | null {
  if (options.rolloutPath) {
    return {
      id: options.threadId ?? path.basename(options.rolloutPath).replace(/^rollout-[^-]+-[^-]+-/, "").replace(/\.jsonl$/, ""),
      title: null,
      cwd: null,
      rolloutPath: options.rolloutPath,
      recencyAt: null,
      updatedAt: null,
    };
  }

  const where = options.threadId ? `where id = '${escapeSqlLiteral(options.threadId)}'` : "where archived = 0";
  const rows = sqliteJson(stateDb, [
    "select",
    "id,",
    "substr(title, 1, 300) as title,",
    "cwd,",
    "rollout_path,",
    "updated_at_ms,",
    "recency_at_ms",
    "from threads",
    where,
    "order by recency_at_ms desc, updated_at_ms desc",
    "limit 1",
  ].join(" "), diagnostics);

  const row = rows[0];
  if (!row) {
    diagnostics.push(options.threadId ? `thread not found: ${options.threadId}` : "no active Codex threads found");
    return null;
  }

  const rolloutPath = asString(row.rollout_path);
  if (!rolloutPath) {
    diagnostics.push(`thread ${asString(row.id) ?? "(unknown)"} has no rollout_path`);
    return null;
  }

  return {
    id: asString(row.id) ?? "(unknown)",
    title: asString(row.title),
    cwd: asString(row.cwd),
    rolloutPath,
    recencyAt: msToIso(row.recency_at_ms),
    updatedAt: msToIso(row.updated_at_ms),
  };
}

function readLatestTokenEvent(rolloutPath: string, diagnostics: string[]): RawTokenCountEvent | null {
  if (!fs.existsSync(rolloutPath)) {
    diagnostics.push(`missing rollout file: ${rolloutPath}`);
    return null;
  }

  let latest: RawTokenCountEvent | null = null;
  let count = 0;
  const raw = fs.readFileSync(rolloutPath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes("\"token_count\"")) continue;
    try {
      const event = JSON.parse(line) as RawTokenCountEvent;
      if (event.type === "event_msg" && event.payload?.type === "token_count") {
        latest = event;
        count += 1;
      }
    } catch {
      diagnostics.push(`skipped malformed token_count line in ${rolloutPath}`);
    }
  }

  if (!latest) {
    diagnostics.push(`no token_count events found in ${rolloutPath}`);
  } else {
    diagnostics.push(`token_count events scanned: ${count}`);
  }
  return latest;
}

class AppServerRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly command: string;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;

  constructor() {
    this.command = resolveCodexExecutable();
    this.child = spawn(this.command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.stdout.setEncoding("utf-8");
    this.child.stderr.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });
    this.child.on("error", (error) => {
      this.rejectAll(new Error(`${this.command} app-server spawn failed: ${error.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`codex app-server exited before responding: code=${code ?? "null"} signal=${signal ?? "null"}`));
      }
    });
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server is already closed"));
    }

    const id = this.nextId;
    this.nextId += 1;

    const message: JsonRecord = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGTERM");
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id != null && message.method) {
      this.child.stdin.write(`${JSON.stringify({
        id: message.id,
        error: {
          code: -32601,
          message: `wechat2all probe does not implement ${message.method}`,
        },
      })}\n`);
      return;
    }

    const numericId = typeof message.id === "number" ? message.id : null;
    if (numericId == null) return;

    const pending = this.pending.get(numericId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(numericId);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? `RPC error ${message.error.code ?? "unknown"}`));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function resolveCodexExecutable(): string {
  const envPath = process.env.CODEX_CLI_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;

  const bundledPath = "/Applications/Codex.app/Contents/Resources/codex";
  if (fs.existsSync(bundledPath)) return bundledPath;

  return "codex";
}

async function readAppServerRateLimits(options: ProbeOptions, diagnostics: string[]): Promise<{
  initialize: AppServerInitializeResult;
  response: AppServerRateLimitsResponse;
} | null> {
  const rpc = new AppServerRpc();
  try {
    const initialize = await rpc.request<AppServerInitializeResult>("initialize", {
      clientInfo: {
        name: "wechat2all-codex-token-probe",
        title: "wechat2all Codex token probe",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    }, options.timeoutMs);

    const response = await rpc.request<AppServerRateLimitsResponse>("account/rateLimits/read", undefined, options.timeoutMs);
    return { initialize, response };
  } catch (error) {
    diagnostics.push(`app-server account/rateLimits/read failed: ${error instanceof Error ? error.message : String(error)}`);
    const stderr = rpc.stderr.trim().split(/\r?\n/).slice(0, 3).join(" | ");
    if (stderr) diagnostics.push(`app-server stderr: ${stderr}`);
    return null;
  } finally {
    rpc.close();
  }
}

function labelForMinutes(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  if (typeof minutes === "number" && Number.isFinite(minutes)) {
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return fallback;
}

function summarizeWindowFromParts(
  usedPercent: number | null,
  windowMinutes: number | null,
  resetsAtSeconds: number | null,
  fallbackLabel: string,
  nowMs: number,
): RateLimitWindowStatus {
  const resetsInMs = resetsAtSeconds ? resetsAtSeconds * 1000 - nowMs : null;

  return {
    label: labelForMinutes(windowMinutes, fallbackLabel),
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt: resetsAtSeconds ? new Date(resetsAtSeconds * 1000).toISOString() : null,
    resetsAtLocal: resetsAtSeconds ? formatLocalDate(resetsAtSeconds * 1000) : null,
    resetsInMs,
    resetsIn: resetsInMs == null ? null : formatDuration(resetsInMs),
  };
}

function summarizeRolloutWindow(
  window: RawRateLimitWindow | undefined,
  fallbackLabel: string,
  nowMs: number,
): RateLimitWindowStatus | null {
  if (!window) return null;
  return summarizeWindowFromParts(
    asNumber(window.used_percent),
    asNumber(window.window_minutes),
    asNumber(window.resets_at),
    fallbackLabel,
    nowMs,
  );
}

function summarizeAppWindow(
  window: AppServerRateLimitWindow | null | undefined,
  fallbackLabel: string,
  nowMs: number,
): RateLimitWindowStatus | null {
  if (!window) return null;
  return summarizeWindowFromParts(
    asNumber(window.usedPercent),
    asNumber(window.windowDurationMins),
    asNumber(window.resetsAt),
    fallbackLabel,
    nowMs,
  );
}

function summarizeRolloutRateLimits(rateLimits: RawRateLimits, nowMs: number): RateLimitSummary {
  return {
    limitId: rateLimits.limit_id ?? null,
    limitName: rateLimits.limit_name ?? null,
    rateLimitReachedType: rateLimits.rate_limit_reached_type ?? null,
    primary: summarizeRolloutWindow(rateLimits.primary, "primary", nowMs),
    secondary: summarizeRolloutWindow(rateLimits.secondary, "secondary", nowMs),
    credits: rateLimits.credits ?? null,
    planType: rateLimits.plan_type ?? null,
    individualLimit: rateLimits.individual_limit ?? null,
  };
}

function summarizeAppRateLimits(rateLimits: AppServerRateLimits | null | undefined, nowMs: number): RateLimitSummary | null {
  if (!rateLimits) return null;
  return {
    limitId: rateLimits.limitId ?? null,
    limitName: rateLimits.limitName ?? null,
    rateLimitReachedType: rateLimits.rateLimitReachedType ?? null,
    primary: summarizeAppWindow(rateLimits.primary, "primary", nowMs),
    secondary: summarizeAppWindow(rateLimits.secondary, "secondary", nowMs),
    credits: rateLimits.credits ?? null,
    planType: rateLimits.planType ?? null,
    individualLimit: rateLimits.individualLimit ?? null,
  };
}

function summarizeAppBuckets(
  buckets: Record<string, AppServerRateLimits | null> | null | undefined,
  nowMs: number,
): Record<string, RateLimitSummary> | null {
  if (!buckets) return null;
  const result: Record<string, RateLimitSummary> = {};
  for (const [limitId, value] of Object.entries(buckets)) {
    const summary = summarizeAppRateLimits(value, nowMs);
    if (summary) result[limitId] = summary;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeResetCredits(value: AppServerRateLimitResetCredits | null | undefined): { availableCount: number | null } | null {
  if (!value) return null;
  const parsed = typeof value.availableCount === "string" ? Number(value.availableCount) : value.availableCount;
  return {
    availableCount: Number.isFinite(parsed) ? parsed ?? null : null,
  };
}

function formatLocalDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms));
}

function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let seconds = Math.round(Math.abs(ms) / 1000);
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return `${sign}${parts.join(" ")}`;
}

async function buildStatus(options: ProbeOptions): Promise<CodexTokenStatus> {
  const codexHome = expandHome(options.codexHome);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const diagnostics: string[] = [];

  if (options.source !== "rollout") {
    const appServer = await readAppServerRateLimits(options, diagnostics);
    if (appServer) {
      return buildAppServerStatus(codexHome, stateDb, diagnostics, appServer);
    }
    if (options.source === "app-server") {
      return emptyAppServerStatus(codexHome, stateDb, diagnostics);
    }
    diagnostics.push("falling back to rollout token_count source");
  }

  return buildRolloutStatus(options, codexHome, stateDb, diagnostics);
}

function buildAppServerStatus(
  codexHome: string,
  stateDb: string,
  diagnostics: string[],
  appServer: {
    initialize: AppServerInitializeResult;
    response: AppServerRateLimitsResponse;
  },
): CodexTokenStatus {
  const nowMs = Date.now();
  return {
    generatedAt: new Date(nowMs).toISOString(),
    codexHome: appServer.initialize.codexHome ?? codexHome,
    sourceKind: "app-server-rate-limits",
    note: "Reads Codex app-server account/rateLimits/read. This is the account-level source that corresponds to the Codex GUI Usage remaining panel.",
    source: {
      stateDb,
      rolloutPath: null,
      appServer: {
        command: "codex app-server --stdio",
        method: "account/rateLimits/read",
        userAgent: appServer.initialize.userAgent ?? null,
      },
    },
    diagnostics,
    thread: null,
    tokenEvent: null,
    rateLimits: summarizeAppRateLimits(appServer.response.rateLimits, nowMs),
    rateLimitsByLimitId: summarizeAppBuckets(appServer.response.rateLimitsByLimitId, nowMs),
    rateLimitResetCredits: normalizeResetCredits(appServer.response.rateLimitResetCredits),
  };
}

function emptyAppServerStatus(
  codexHome: string,
  stateDb: string,
  diagnostics: string[],
): CodexTokenStatus {
  return {
    generatedAt: new Date().toISOString(),
    codexHome,
    sourceKind: "app-server-rate-limits",
    note: "Tried Codex app-server account/rateLimits/read, but no response was available.",
    source: {
      stateDb,
      rolloutPath: null,
      appServer: {
        command: "codex app-server --stdio",
        method: "account/rateLimits/read",
        userAgent: null,
      },
    },
    diagnostics,
    thread: null,
    tokenEvent: null,
    rateLimits: null,
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
  };
}

function buildRolloutStatus(
  options: ProbeOptions,
  codexHome: string,
  stateDb: string,
  diagnostics: string[],
): CodexTokenStatus {
  const thread = resolveThread(options, stateDb, diagnostics);
  const latest = thread ? readLatestTokenEvent(thread.rolloutPath, diagnostics) : null;
  const payload = latest?.payload ?? null;
  const rateLimits = payload?.rate_limits ?? null;
  const nowMs = Date.now();

  return {
    generatedAt: new Date(nowMs).toISOString(),
    codexHome,
    sourceKind: "rollout-token-count",
    note: "Reads local rollout token_count events. This can expose a per-thread/per-model bucket and may not match the Codex GUI Usage remaining panel.",
    source: {
      stateDb,
      rolloutPath: thread?.rolloutPath ?? null,
      appServer: null,
    },
    diagnostics,
    thread,
    tokenEvent: payload ? {
      timestamp: latest?.timestamp ?? null,
      modelContextWindow: payload.info?.model_context_window ?? null,
      totalTokenUsage: payload.info?.total_token_usage ?? null,
      lastTokenUsage: payload.info?.last_token_usage ?? null,
    } : null,
    rateLimits: rateLimits ? summarizeRolloutRateLimits(rateLimits, nowMs) : null,
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
  };
}

function pct(value: number | null): string {
  if (value == null) return "unknown";
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
}

function tokenCount(value: number | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "unknown";
}

function printWindow(window: RateLimitWindowStatus | null): void {
  if (!window) {
    console.log("- unavailable");
    return;
  }
  console.log([
    `- ${window.label}`,
    `used=${pct(window.usedPercent)}`,
    `remaining=${pct(window.remainingPercent)}`,
    `resetsIn=${window.resetsIn ?? "unknown"}`,
    `resetsAt=${window.resetsAtLocal ?? window.resetsAt ?? "unknown"}`,
  ].join(" | "));
}

function printSummary(status: CodexTokenStatus): void {
  console.log("Codex token/rate-limit probe");
  if (status.sourceKind === "app-server-rate-limits") {
    console.log("Source: Codex app-server account/rateLimits/read (GUI account-level source)");
  } else {
    console.log("Source: local rollout token_count event (debug fallback; not GUI account usage)");
  }
  console.log(`CODEX_HOME: ${status.codexHome}`);
  if (status.source.appServer?.userAgent) console.log(`App server: ${status.source.appServer.userAgent}`);
  if (status.thread) {
    console.log(`Thread: ${status.thread.id}`);
    if (status.thread.title) console.log(`Title: ${status.thread.title.replace(/\s+/g, " ").trim()}`);
    if (status.thread.cwd) console.log(`Project: ${status.thread.cwd}`);
    console.log(`Rollout: ${status.source.rolloutPath ?? "unknown"}`);
    console.log(`Token event: ${status.tokenEvent?.timestamp ?? "not found"}`);
  }

  if (status.rateLimits?.limitName || status.rateLimits?.limitId) {
    console.log(`Display bucket: ${status.rateLimits.limitName ?? status.rateLimits.limitId ?? "unknown"}`);
  }
  if (status.rateLimits?.rateLimitReachedType) {
    console.log(`Reached: ${status.rateLimits.rateLimitReachedType}`);
  }
  if (status.rateLimitResetCredits) {
    console.log(`Reset credits: ${status.rateLimitResetCredits.availableCount ?? "unknown"} available`);
  }

  console.log("\nUsage Windows");
  printWindow(status.rateLimits?.primary ?? null);
  printWindow(status.rateLimits?.secondary ?? null);

  if (status.rateLimitsByLimitId) {
    console.log("\nBuckets By limitId");
    for (const [limitId, summary] of Object.entries(status.rateLimitsByLimitId)) {
      const label = summary.limitName ? `${limitId} (${summary.limitName})` : limitId;
      console.log([
        `- ${label}`,
        `5h remaining=${pct(summary.primary?.remainingPercent ?? null)}`,
        `weekly remaining=${pct(summary.secondary?.remainingPercent ?? null)}`,
      ].join(" | "));
    }
  }

  if (status.tokenEvent) {
    console.log("\nToken Usage");
    console.log([
      `last=${tokenCount(status.tokenEvent.lastTokenUsage?.total_tokens)}`,
      `total=${tokenCount(status.tokenEvent.totalTokenUsage?.total_tokens)}`,
      `contextWindow=${tokenCount(status.tokenEvent.modelContextWindow ?? undefined)}`,
    ].join(" | "));
  }

  if (status.diagnostics.length > 0) {
    console.log(`\nDiagnostics: ${status.diagnostics.join(" | ")}`);
  }
  console.log("\nUse --json for the structured payload.");
}

const options = parseArgs(process.argv.slice(2));
const status = await buildStatus(options);

if (options.json) {
  console.log(JSON.stringify(status, null, 2));
} else {
  printSummary(status);
}
