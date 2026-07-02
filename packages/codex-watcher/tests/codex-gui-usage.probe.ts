import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";

interface ProbeOptions {
  json: boolean;
  timeoutMs: number;
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
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

interface AppServerRateLimitResetCredits {
  availableCount?: number | string;
}

interface AppServerRateLimitsResponse {
  rateLimits?: AppServerRateLimits | null;
  rateLimitResetCredits?: AppServerRateLimitResetCredits | null;
}

interface UsageWindow {
  label: string;
  remainingText: string | null;
  resetText: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

interface UsagePanel {
  title: "Usage remaining";
  sourceLimitId: string | null;
  sourceLimitName: string | null;
  windows: UsageWindow[];
  upgradeText: string | null;
  resetCreditsText: string | null;
  learnMoreText: "Learn more";
}

interface ProbeResult {
  generatedAt: string;
  source: {
    command: string;
    method: "account/rateLimits/read";
    selectedField: "result.rateLimits";
    userAgent: string | null;
    codexHome: string | null;
  };
  usagePanel: UsagePanel | null;
  topLevelRateLimits: AppServerRateLimits | null;
  rateLimitResetCredits: {
    availableCount: number | null;
  } | null;
}

function parseArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = {
    json: false,
    timeoutMs: 8_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms requires a positive number");
      options.timeoutMs = value;
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
    "Usage: pnpm codex-gui-usage-probe [--json] [--timeout-ms <ms>]",
    "",
    "Reads Codex app-server account/rateLimits/read once and formats only the",
    "top-level result.rateLimits field as the Usage remaining panel.",
    "",
    "This probe does not use macOS Accessibility, does not inspect the GUI,",
    "does not wait for the profile menu, and does not fall back to rollout logs",
    "or model-specific rateLimitsByLimitId buckets.",
  ].join("\n"));
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
        this.rejectAll(new Error(`${this.command} app-server exited before responding: code=${code ?? "null"} signal=${signal ?? "null"}`));
      }
    });
  }

  get executable(): string {
    return this.command;
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

    const message: Record<string, unknown> = {
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
          message: `wechat2all usage probe does not implement ${message.method}`,
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

async function readTopLevelRateLimits(timeoutMs: number): Promise<{
  command: string;
  initialize: AppServerInitializeResult;
  response: AppServerRateLimitsResponse;
  stderr: string;
}> {
  const rpc = new AppServerRpc();
  try {
    const initialize = await rpc.request<AppServerInitializeResult>("initialize", {
      clientInfo: {
        name: "wechat2all-codex-usage-probe",
        title: "wechat2all Codex usage probe",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    }, timeoutMs);
    const response = await rpc.request<AppServerRateLimitsResponse>("account/rateLimits/read", undefined, timeoutMs);
    return {
      command: rpc.executable,
      initialize,
      response,
      stderr: rpc.stderr,
    };
  } finally {
    rpc.close();
  }
}

async function buildProbeResult(options: ProbeOptions): Promise<ProbeResult> {
  const appServer = await readTopLevelRateLimits(options.timeoutMs);
  const topLevelRateLimits = appServer.response.rateLimits ?? null;

  return {
    generatedAt: new Date().toISOString(),
    source: {
      command: appServer.command,
      method: "account/rateLimits/read",
      selectedField: "result.rateLimits",
      userAgent: appServer.initialize.userAgent ?? null,
      codexHome: appServer.initialize.codexHome ?? null,
    },
    usagePanel: buildUsagePanel(topLevelRateLimits, appServer.response.rateLimitResetCredits),
    topLevelRateLimits,
    rateLimitResetCredits: normalizeResetCredits(appServer.response.rateLimitResetCredits),
  };
}

function buildUsagePanel(
  rateLimits: AppServerRateLimits | null,
  resetCredits: AppServerRateLimitResetCredits | null | undefined,
): UsagePanel | null {
  if (!rateLimits) return null;
  const windows = [
    buildUsageWindow(rateLimits.primary ?? null, "5h"),
    buildUsageWindow(rateLimits.secondary ?? null, "Weekly"),
  ].filter((window): window is UsageWindow => window != null);

  return {
    title: "Usage remaining",
    sourceLimitId: rateLimits.limitId ?? null,
    sourceLimitName: rateLimits.limitName ?? null,
    windows,
    upgradeText: upgradeTextForPlan(rateLimits.planType ?? null),
    resetCreditsText: resetCreditsText(resetCredits),
    learnMoreText: "Learn more",
  };
}

function buildUsageWindow(window: AppServerRateLimitWindow | null, fallbackLabel: string): UsageWindow | null {
  if (!window) return null;
  const usedPercent = finiteNumber(window.usedPercent);
  const remainingPercent = usedPercent == null ? null : Math.max(0, 100 - usedPercent);
  const windowDurationMins = finiteNumber(window.windowDurationMins);
  const resetsAt = finiteNumber(window.resetsAt);

  return {
    label: labelForMinutes(windowDurationMins, fallbackLabel),
    remainingText: remainingPercent == null ? null : `${Math.round(remainingPercent)}%`,
    resetText: resetsAt == null ? null : formatGuiResetText(resetsAt * 1000, windowDurationMins),
    usedPercent,
    remainingPercent,
    windowDurationMins,
    resetsAt: resetsAt == null ? null : new Date(resetsAt * 1000).toISOString(),
  };
}

function labelForMinutes(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "Weekly";
  if (minutes == null) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatGuiResetText(ms: number, windowDurationMins: number | null): string {
  const reset = new Date(ms);
  if ((windowDurationMins ?? 0) >= 1440) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(reset);
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(reset);
}

function upgradeTextForPlan(planType: string | null): string | null {
  switch (planType) {
    case "free":
    case "go":
      return "Upgrade to Plus";
    case "plus":
      return "Upgrade to Pro";
    case "prolite":
      return "Upgrade for more usage";
    case "team":
    case "self_serve_business_usage_based":
    case "business":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "education":
    case "edu_plus":
    case "edu_pro":
    case "quorum":
    case "sci":
    case "enterprise":
    case "edu":
    case "hc":
    case "finserv":
      return "To get more access, contact your admin";
    default:
      return null;
  }
}

function resetCreditsText(resetCredits: AppServerRateLimitResetCredits | null | undefined): string | null {
  const count = resetCreditsCount(resetCredits);
  if (count == null || count <= 0) return null;
  return count === 1 ? "1 reset available" : `${count} resets available`;
}

function normalizeResetCredits(resetCredits: AppServerRateLimitResetCredits | null | undefined): { availableCount: number | null } | null {
  if (!resetCredits) return null;
  return {
    availableCount: resetCreditsCount(resetCredits),
  };
}

function resetCreditsCount(resetCredits: AppServerRateLimitResetCredits | null | undefined): number | null {
  const count = typeof resetCredits?.availableCount === "string"
    ? Number(resetCredits.availableCount)
    : resetCredits?.availableCount;
  return Number.isFinite(count) ? count ?? null : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function printSummary(result: ProbeResult): void {
  console.log("Codex usage probe");
  console.log(`Source: ${result.source.method} -> ${result.source.selectedField}`);
  console.log(`Command: ${result.source.command}`);
  if (result.source.userAgent) console.log(`App server: ${result.source.userAgent}`);
  if (result.source.codexHome) console.log(`CODEX_HOME: ${result.source.codexHome}`);

  if (!result.usagePanel) {
    console.log("\nUsage remaining: unavailable");
    console.log("Top-level result.rateLimits was missing.");
    return;
  }

  console.log(`\n${result.usagePanel.title}`);
  console.log(`Display bucket: ${result.usagePanel.sourceLimitName ?? result.usagePanel.sourceLimitId ?? "unknown"}`);
  for (const window of result.usagePanel.windows) {
    console.log(`- ${window.label}: ${window.remainingText ?? "unknown"} ${window.resetText ?? "unknown"}`);
  }
  if (result.usagePanel.upgradeText) {
    console.log(`- ${result.usagePanel.upgradeText}`);
  }
  if (result.usagePanel.resetCreditsText) {
    console.log(`- ${result.usagePanel.resetCreditsText}`);
  }
  console.log(`- ${result.usagePanel.learnMoreText}`);
  console.log("\nUse --json for the structured top-level rateLimits payload.");
}

const options = parseArgs(process.argv.slice(2));
const result = await buildProbeResult(options);

if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printSummary(result);
}
