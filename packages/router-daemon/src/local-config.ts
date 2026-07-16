import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MANAGED_COMMENT = "# Managed by the wechat2all local config API";
const MAX_STRING_LENGTH = 8_192;

const FIELD_ENV_NAMES = {
  "llm.provider": "WECHAT2ALL_LLM_PROVIDER",
  "llm.apiKey": "WECHAT2ALL_LLM_API_KEY",
  "llm.model": "WECHAT2ALL_LLM_MODEL",
  "llm.baseUrl": "WECHAT2ALL_LLM_BASE_URL",
  "llm.temperature": "WECHAT2ALL_LLM_TEMPERATURE",
  "llm.maxTokens": "WECHAT2ALL_LLM_MAX_TOKENS",
  "llm.timeoutMs": "WECHAT2ALL_LLM_TIMEOUT_MS",
  "memory.provider": "WECHAT2ALL_MEMORY_PROVIDER",
  "memory.apiKey": "WECHAT2ALL_MEM0_API_KEY",
  "memory.baseUrl": "WECHAT2ALL_MEM0_BASE_URL",
  "memory.timeoutMs": "WECHAT2ALL_MEM0_TIMEOUT_MS",
  "memory.localMaxSearchRows": "WECHAT2ALL_MEMORY_LOCAL_MAX_SEARCH_ROWS",
  "claude.apiKey": "ANTHROPIC_API_KEY",
  "claude.workdir": "WECHAT2ALL_CLAUDE_WORKDIR",
  "claude.promptFile": "WECHAT2ALL_CLAUDE_PROMPT_FILE",
  "claude.model": "WECHAT2ALL_CLAUDE_MODEL",
  "claude.language": "WECHAT2ALL_CLAUDE_LANGUAGE",
  "claude.sessionWindowMinutes": "WECHAT2ALL_CLAUDE_SESSION_WINDOW_MINUTES",
  "claude.maxMediaMb": "WECHAT2ALL_CLAUDE_MAX_MEDIA_MB",
  "claude.maxTurns": "WECHAT2ALL_CLAUDE_MAX_TURNS",
  "claude.maxBudgetUsd": "WECHAT2ALL_CLAUDE_MAX_BUDGET_USD",
  "claude.timeoutMs": "WECHAT2ALL_CLAUDE_TIMEOUT_MS",
  "claude.allowCliAuth": "WECHAT2ALL_CLAUDE_ALLOW_CLI_AUTH",
  "claude.executable": "WECHAT2ALL_CLAUDE_EXECUTABLE",
} as const;

export type ConfigField = keyof typeof FIELD_ENV_NAMES;
type EnvUpdate = string | null;

export interface SecretStatus {
  configured: boolean;
  masked: string | null;
}

export interface LlmConfigSnapshot {
  provider: string;
  apiKey: SecretStatus;
  model: string | null;
  baseUrl: string;
  temperature: number | null;
  maxTokens: number | null;
  timeoutMs: number | null;
}

export interface MemoryConfigSnapshot {
  provider: string;
  apiKey: SecretStatus;
  baseUrl: string;
  timeoutMs: number;
  localMaxSearchRows: number | null;
}

export interface ClaudeConfigSnapshot {
  apiKey: SecretStatus;
  workdir: string | null;
  promptFile: string | null;
  model: string | null;
  language: "zh" | "en";
  sessionWindowMinutes: number;
  maxMediaMb: number;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  allowCliAuth: boolean;
  executable: string | null;
}

export interface LocalConfigSnapshot {
  configPath: string;
  runtimeApplied: boolean;
  restartRequired: boolean;
  llm: LlmConfigSnapshot;
  memory: MemoryConfigSnapshot;
  claude: ClaudeConfigSnapshot;
}

export interface LocalConfigUpdateResult {
  changed: boolean;
  changedFields: ConfigField[];
  config: LocalConfigSnapshot;
}

export interface LocalConfigStoreOptions {
  filePath: string;
  env?: NodeJS.ProcessEnv;
}

export class LocalConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConfigValidationError";
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalConfigValidationError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new LocalConfigValidationError(
      `${label} contains unsupported field(s): ${unknown.join(", ")}.`,
    );
  }
}

function optionalString(
  value: unknown,
  label: string,
  opts: { secret?: boolean } = {},
): EnvUpdate | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new LocalConfigValidationError(`${label} must be a string or null.`);
  }
  const normalized = value.trim();
  if (!normalized) return opts.secret ? undefined : null;
  if (normalized.length > MAX_STRING_LENGTH) {
    throw new LocalConfigValidationError(`${label} is too long.`);
  }
  if (/\r|\n|\0/.test(normalized)) {
    throw new LocalConfigValidationError(`${label} cannot contain line breaks or NUL bytes.`);
  }
  if (opts.secret && /\s/.test(normalized)) {
    throw new LocalConfigValidationError(`${label} cannot contain whitespace.`);
  }
  return normalized;
}

function optionalEnum(
  value: unknown,
  label: string,
  allowed: readonly string[],
): EnvUpdate | undefined {
  const parsed = optionalString(value, label);
  if (parsed === undefined || parsed === null) return parsed;
  if (!allowed.includes(parsed)) {
    throw new LocalConfigValidationError(
      `${label} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return parsed;
}

function optionalUrl(value: unknown, label: string): EnvUpdate | undefined {
  const parsed = optionalString(value, label);
  if (parsed === undefined || parsed === null) return parsed;
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new LocalConfigValidationError(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalConfigValidationError(`${label} must use http or https.`);
  }
  return parsed.replace(/\/+$/, "");
}

function optionalNumber(
  value: unknown,
  label: string,
  opts: { min: number; max: number; integer?: boolean },
): EnvUpdate | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value.trim())
      : Number.NaN;
  if (
    !Number.isFinite(parsed) ||
    parsed < opts.min ||
    parsed > opts.max ||
    (opts.integer && !Number.isInteger(parsed))
  ) {
    const kind = opts.integer ? "integer" : "number";
    throw new LocalConfigValidationError(
      `${label} must be a ${kind} between ${opts.min} and ${opts.max}.`,
    );
  }
  return String(parsed);
}

function optionalBoolean(value: unknown, label: string): EnvUpdate | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return "1";
    if (["0", "false", "no", "off"].includes(normalized)) return "0";
  }
  throw new LocalConfigValidationError(`${label} must be a boolean or null.`);
}

function setUpdate(
  updates: Map<string, EnvUpdate>,
  field: ConfigField,
  value: EnvUpdate | undefined,
): void {
  if (value !== undefined) updates.set(FIELD_ENV_NAMES[field], value);
}

function parsePatch(value: unknown): Map<string, EnvUpdate> {
  const root = asObject(value, "config");
  assertAllowedKeys(root, ["llm", "memory", "claude"], "config");
  const updates = new Map<string, EnvUpdate>();

  if (root.llm !== undefined) {
    const llm = asObject(root.llm, "llm");
    assertAllowedKeys(
      llm,
      ["provider", "apiKey", "model", "baseUrl", "temperature", "maxTokens", "timeoutMs"],
      "llm",
    );
    setUpdate(updates, "llm.provider", optionalEnum(
      llm.provider,
      "llm.provider",
      ["openai-compatible", "mock"],
    ));
    setUpdate(updates, "llm.apiKey", optionalString(
      llm.apiKey,
      "llm.apiKey",
      { secret: true },
    ));
    setUpdate(updates, "llm.model", optionalString(llm.model, "llm.model"));
    setUpdate(updates, "llm.baseUrl", optionalUrl(llm.baseUrl, "llm.baseUrl"));
    setUpdate(updates, "llm.temperature", optionalNumber(
      llm.temperature,
      "llm.temperature",
      { min: 0, max: 2 },
    ));
    setUpdate(updates, "llm.maxTokens", optionalNumber(
      llm.maxTokens,
      "llm.maxTokens",
      { min: 1, max: 1_000_000, integer: true },
    ));
    setUpdate(updates, "llm.timeoutMs", optionalNumber(
      llm.timeoutMs,
      "llm.timeoutMs",
      { min: 100, max: 600_000, integer: true },
    ));
  }

  if (root.memory !== undefined) {
    const memory = asObject(root.memory, "memory");
    assertAllowedKeys(
      memory,
      ["provider", "apiKey", "baseUrl", "timeoutMs", "localMaxSearchRows"],
      "memory",
    );
    setUpdate(updates, "memory.provider", optionalEnum(
      memory.provider,
      "memory.provider",
      ["local", "mem0", "none"],
    ));
    setUpdate(updates, "memory.apiKey", optionalString(
      memory.apiKey,
      "memory.apiKey",
      { secret: true },
    ));
    setUpdate(updates, "memory.baseUrl", optionalUrl(memory.baseUrl, "memory.baseUrl"));
    setUpdate(updates, "memory.timeoutMs", optionalNumber(
      memory.timeoutMs,
      "memory.timeoutMs",
      { min: 100, max: 600_000, integer: true },
    ));
    setUpdate(updates, "memory.localMaxSearchRows", optionalNumber(
      memory.localMaxSearchRows,
      "memory.localMaxSearchRows",
      { min: 1, max: 1_000_000, integer: true },
    ));
  }

  if (root.claude !== undefined) {
    const claude = asObject(root.claude, "claude");
    assertAllowedKeys(
      claude,
      [
        "apiKey",
        "workdir",
        "promptFile",
        "model",
        "language",
        "sessionWindowMinutes",
        "maxMediaMb",
        "maxTurns",
        "maxBudgetUsd",
        "timeoutMs",
        "allowCliAuth",
        "executable",
      ],
      "claude",
    );
    setUpdate(updates, "claude.apiKey", optionalString(
      claude.apiKey,
      "claude.apiKey",
      { secret: true },
    ));
    setUpdate(updates, "claude.workdir", optionalString(claude.workdir, "claude.workdir"));
    setUpdate(updates, "claude.promptFile", optionalString(
      claude.promptFile,
      "claude.promptFile",
    ));
    setUpdate(updates, "claude.model", optionalString(claude.model, "claude.model"));
    setUpdate(updates, "claude.language", optionalEnum(
      claude.language,
      "claude.language",
      ["zh", "en"],
    ));
    setUpdate(updates, "claude.sessionWindowMinutes", optionalNumber(
      claude.sessionWindowMinutes,
      "claude.sessionWindowMinutes",
      { min: 0, max: 24 * 60 },
    ));
    setUpdate(updates, "claude.maxMediaMb", optionalNumber(
      claude.maxMediaMb,
      "claude.maxMediaMb",
      { min: 1, max: 1_024 },
    ));
    setUpdate(updates, "claude.maxTurns", optionalNumber(
      claude.maxTurns,
      "claude.maxTurns",
      { min: 1, max: 1_000, integer: true },
    ));
    setUpdate(updates, "claude.maxBudgetUsd", optionalNumber(
      claude.maxBudgetUsd,
      "claude.maxBudgetUsd",
      { min: 0.01, max: 10_000 },
    ));
    setUpdate(updates, "claude.timeoutMs", optionalNumber(
      claude.timeoutMs,
      "claude.timeoutMs",
      { min: 1_000, max: 24 * 60 * 60_000, integer: true },
    ));
    setUpdate(updates, "claude.allowCliAuth", optionalBoolean(
      claude.allowCliAuth,
      "claude.allowCliAuth",
    ));
    setUpdate(updates, "claude.executable", optionalString(
      claude.executable,
      "claude.executable",
    ));
  }

  return updates;
}

function envLineKey(line: string): string | undefined {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1];
}

function updateEnvDocument(raw: string, updates: ReadonlyMap<string, EnvUpdate>): string {
  if (updates.size === 0) return raw;
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/).flatMap((line) => {
    const key = envLineKey(line);
    if (!key || !updates.has(key)) return [line];
    if (seen.has(key)) return [];
    seen.add(key);
    const value = updates.get(key);
    return value === null ? [] : [`${key}=${value}`];
  });

  const additions = [...updates.entries()]
    .filter(([key, value]) => !seen.has(key) && value !== null)
    .map(([key, value]) => `${key}=${value}`);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (additions.length > 0) {
    if (lines.length > 0) lines.push("");
    if (!lines.includes(MANAGED_COMMENT)) lines.push(MANAGED_COMMENT);
    lines.push(...additions);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function parseEnvDocument(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim().replace(/^export\s+/, "");
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function nullableNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOr(value: string | undefined, fallback: number): number {
  return nullableNumber(value) ?? fallback;
}

function booleanOr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function maskSecret(value: string | undefined): SecretStatus {
  if (!value) return { configured: false, masked: null };
  if (value.length < 8) return { configured: true, masked: "********" };
  return {
    configured: true,
    masked: `${value.slice(0, 3)}...${value.slice(-4)}`,
  };
}

function fieldForEnvName(envName: string): ConfigField {
  const entry = Object.entries(FIELD_ENV_NAMES)
    .find(([, candidate]) => candidate === envName);
  if (!entry) throw new Error(`Unknown managed environment field: ${envName}`);
  return entry[0] as ConfigField;
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function atomicWritePrivate(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export class LocalConfigStore {
  readonly filePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private operation: Promise<void> = Promise.resolve();
  private restartRequired = false;

  constructor(opts: LocalConfigStoreOptions) {
    this.filePath = path.resolve(opts.filePath);
    this.env = opts.env ?? process.env;
  }

  async snapshot(): Promise<LocalConfigSnapshot> {
    await this.operation;
    return this.readSnapshot();
  }

  async update(value: unknown): Promise<LocalConfigUpdateResult> {
    const updates = parsePatch(value);
    const next = this.operation.then(() => this.applyUpdates(updates));
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async effectiveEnv(): Promise<Record<string, string | undefined>> {
    const persisted = parseEnvDocument(await readFileOrEmpty(this.filePath));
    return { ...this.env, ...persisted };
  }

  private async readSnapshot(): Promise<LocalConfigSnapshot> {
    const env = await this.effectiveEnv();
    const llmApiKey = env.WECHAT2ALL_LLM_API_KEY;
    const llmModel = env.WECHAT2ALL_LLM_MODEL;
    const llmProvider = env.WECHAT2ALL_LLM_PROVIDER ??
      (llmApiKey && llmModel ? "openai-compatible" : "mock");

    return {
      configPath: this.filePath,
      runtimeApplied: !this.restartRequired,
      restartRequired: this.restartRequired,
      llm: {
        provider: llmProvider,
        apiKey: maskSecret(llmApiKey),
        model: llmModel ?? null,
        baseUrl: env.WECHAT2ALL_LLM_BASE_URL ?? "https://api.openai.com/v1",
        temperature: nullableNumber(env.WECHAT2ALL_LLM_TEMPERATURE),
        maxTokens: nullableNumber(env.WECHAT2ALL_LLM_MAX_TOKENS),
        timeoutMs: nullableNumber(env.WECHAT2ALL_LLM_TIMEOUT_MS),
      },
      memory: {
        provider: env.WECHAT2ALL_MEMORY_PROVIDER ?? "local",
        apiKey: maskSecret(env.WECHAT2ALL_MEM0_API_KEY),
        baseUrl: env.WECHAT2ALL_MEM0_BASE_URL ?? "https://api.mem0.ai",
        timeoutMs: numberOr(env.WECHAT2ALL_MEM0_TIMEOUT_MS, 15_000),
        localMaxSearchRows: nullableNumber(env.WECHAT2ALL_MEMORY_LOCAL_MAX_SEARCH_ROWS),
      },
      claude: {
        apiKey: maskSecret(env.ANTHROPIC_API_KEY),
        workdir: env.WECHAT2ALL_CLAUDE_WORKDIR ?? env.WECHAT2ALL_CLAUDE_VAULT ?? null,
        promptFile: env.WECHAT2ALL_CLAUDE_PROMPT_FILE ?? null,
        model: env.WECHAT2ALL_CLAUDE_MODEL ?? null,
        language: env.WECHAT2ALL_CLAUDE_LANGUAGE === "en" ? "en" : "zh",
        sessionWindowMinutes: numberOr(env.WECHAT2ALL_CLAUDE_SESSION_WINDOW_MINUTES, 15),
        maxMediaMb: numberOr(env.WECHAT2ALL_CLAUDE_MAX_MEDIA_MB, 50),
        maxTurns: numberOr(env.WECHAT2ALL_CLAUDE_MAX_TURNS, 40),
        maxBudgetUsd: numberOr(env.WECHAT2ALL_CLAUDE_MAX_BUDGET_USD, 1),
        timeoutMs: numberOr(env.WECHAT2ALL_CLAUDE_TIMEOUT_MS, 10 * 60_000),
        allowCliAuth: booleanOr(env.WECHAT2ALL_CLAUDE_ALLOW_CLI_AUTH, false),
        executable: env.WECHAT2ALL_CLAUDE_EXECUTABLE ?? null,
      },
    };
  }

  private async applyUpdates(
    updates: ReadonlyMap<string, EnvUpdate>,
  ): Promise<LocalConfigUpdateResult> {
    const raw = await readFileOrEmpty(this.filePath);
    const current = parseEnvDocument(raw);
    const changedEntries = [...updates.entries()].filter(([key, value]) => {
      const previous = current[key];
      return value === null ? previous !== undefined : previous !== value;
    });

    if (changedEntries.length > 0) {
      const changedUpdates = new Map(changedEntries);
      await atomicWritePrivate(this.filePath, updateEnvDocument(raw, changedUpdates));
      this.restartRequired = true;
    }

    return {
      changed: changedEntries.length > 0,
      changedFields: changedEntries.map(([envName]) => fieldForEnvName(envName)),
      config: await this.readSnapshot(),
    };
  }
}
