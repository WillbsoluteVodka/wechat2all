import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ENV_FILE_NAME = ".env";
const ENV_TEMPLATE_NAME = ".env.example";
const MANAGED_KEYS = ["LLM_ENDPOINT", "LLM_MODEL", "LLM_API_KEY"] as const;
const MAX_API_KEY_LENGTH = 8_192;

export const UPOCHI_LLM_PRESETS = {
  "deepseek-chat": {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
  },
  "gpt-4.1-mini": {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
  },
} as const;

export type UpochiLlmPresetModel = keyof typeof UPOCHI_LLM_PRESETS;
export type UpochiConfigField = typeof MANAGED_KEYS[number];

export interface UpochiConfigSnapshot {
  projectPath: string;
  envPath: string;
  envExists: boolean;
  restartRequired: boolean;
  llm: {
    endpoint: string | null;
    model: string | null;
    apiKey: {
      configured: boolean;
      masked: string | null;
    };
  };
}

export interface UpochiConfigUpdateResult {
  changed: boolean;
  changedFields: UpochiConfigField[];
  config: UpochiConfigSnapshot;
}

export interface UpochiConfigStoreOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
}

export class UpochiConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpochiConfigValidationError";
  }
}

export class UpochiProjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpochiProjectNotFoundError";
  }
}

function parseEnvDocument(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match?.[1]) continue;
    const value = match[2] ?? "";
    result[match[1]] = value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_all, double, single) =>
      double ?? single ?? ""
    );
  }
  return result;
}

function updateEnvDocument(raw: string, updates: ReadonlyMap<string, string>): string {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw ? raw.split(/\r?\n/) : [];
  const pending = new Map(updates);
  const next = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key) ?? "";
    pending.delete(key);
    return `${key}=${value}`;
  });

  if (pending.size > 0) {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    if (next.length > 0) next.push("");
    next.push("# Managed by WeConnect for Upochi");
    for (const [key, value] of pending) next.push(`${key}=${value}`);
  }
  return `${next.join(newline)}${newline}`;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function isUpochiProject(candidate: string): Promise<boolean> {
  const templatePath = path.join(candidate, ENV_TEMPLATE_NAME);
  const template = await readFileOrNull(templatePath);
  if (!template || !/^LLM_ENDPOINT=/m.test(template) || !/^LLM_MODEL=/m.test(template)) {
    return false;
  }
  const markerPaths = [
    path.join(candidate, "pyproject.toml"),
    path.join(candidate, "apps", "desktop", "src", "config", "worker_config.py"),
    path.join(candidate, "LOCAL_API_README.md"),
  ];
  const markers = await Promise.all(markerPaths.map(async (markerPath) =>
    (await fs.stat(markerPath).catch(() => null))?.isFile() ?? false
  ));
  return markers.some(Boolean);
}

function ancestors(start: string): string[] {
  const result: string[] = [];
  let current = path.resolve(start);
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

async function upochiNamedChildren(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes("upochi"))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

async function discoverUpochiProject(options: Required<UpochiConfigStoreOptions>): Promise<string> {
  const explicit = options.env.WECHAT2ALL_UPOCHI_PROJECT_DIR
    ?? options.env.UPOCHI_PROJECT_DIR;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (await isUpochiProject(resolved)) return resolved;
    throw new UpochiProjectNotFoundError(
      `Configured Upochi project directory is invalid: ${resolved}`,
    );
  }

  const candidateSet = new Set<string>();
  const cwdAncestors = ancestors(options.cwd);
  for (const candidate of cwdAncestors) candidateSet.add(candidate);

  const searchParents = new Set<string>([
    ...cwdAncestors.map((candidate) => path.dirname(candidate)),
    options.homeDir,
    path.join(options.homeDir, "Desktop"),
    path.join(options.homeDir, "Documents"),
    path.join(options.homeDir, "Downloads"),
  ]);
  for (const parent of searchParents) {
    for (const child of await upochiNamedChildren(parent)) candidateSet.add(child);
  }

  for (const candidate of candidateSet) {
    if (await isUpochiProject(candidate)) return path.resolve(candidate);
  }
  throw new UpochiProjectNotFoundError(
    "Upochi project was not found. Set WECHAT2ALL_UPOCHI_PROJECT_DIR or keep it beside the WeConnect project.",
  );
}

function maskSecret(value: string | undefined): UpochiConfigSnapshot["llm"]["apiKey"] {
  if (!value) return { configured: false, masked: null };
  if (value.length < 8) return { configured: true, masked: "********" };
  return { configured: true, masked: `${value.slice(0, 3)}...${value.slice(-4)}` };
}

function parseUpdate(value: unknown): { model?: UpochiLlmPresetModel; apiKey?: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UpochiConfigValidationError("Upochi config update must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== "model" && key !== "apiKey");
  if (unknown.length > 0) {
    throw new UpochiConfigValidationError(
      `Upochi config contains unsupported field(s): ${unknown.join(", ")}.`,
    );
  }

  let model: UpochiLlmPresetModel | undefined;
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || !(input.model in UPOCHI_LLM_PRESETS)) {
      throw new UpochiConfigValidationError(
        `model must be one of: ${Object.keys(UPOCHI_LLM_PRESETS).join(", ")}.`,
      );
    }
    model = input.model as UpochiLlmPresetModel;
  }

  let apiKey: string | null | undefined;
  if (input.apiKey === null) {
    apiKey = null;
  } else if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== "string") {
      throw new UpochiConfigValidationError("apiKey must be a string or null.");
    }
    const normalized = input.apiKey.trim();
    if (normalized) {
      if (normalized.length > MAX_API_KEY_LENGTH) {
        throw new UpochiConfigValidationError("apiKey is too long.");
      }
      if (/\s|\r|\n|\0/.test(normalized)) {
        throw new UpochiConfigValidationError("apiKey cannot contain whitespace or NUL bytes.");
      }
      apiKey = normalized;
    }
  }
  return { model, apiKey };
}

async function atomicWritePrivate(filePath: string, content: string): Promise<void> {
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

export class UpochiConfigStore {
  private readonly options: Required<UpochiConfigStoreOptions>;
  private operation: Promise<void> = Promise.resolve();
  private projectPathPromise: Promise<string> | null = null;
  private restartRequired = false;

  constructor(options: UpochiConfigStoreOptions = {}) {
    this.options = {
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
      homeDir: options.homeDir ?? os.homedir(),
    };
  }

  async snapshot(): Promise<UpochiConfigSnapshot> {
    await this.operation;
    return this.readSnapshot();
  }

  async update(value: unknown): Promise<UpochiConfigUpdateResult> {
    const patch = parseUpdate(value);
    const next = this.operation.then(() => this.applyUpdate(patch));
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  private projectPath(): Promise<string> {
    this.projectPathPromise ??= discoverUpochiProject(this.options);
    return this.projectPathPromise;
  }

  private async readSource(): Promise<{
    projectPath: string;
    envPath: string;
    envExists: boolean;
    raw: string;
  }> {
    const projectPath = await this.projectPath();
    const envPath = path.join(projectPath, ENV_FILE_NAME);
    const persisted = await readFileOrNull(envPath);
    if (persisted !== null) return { projectPath, envPath, envExists: true, raw: persisted };
    const template = await readFileOrNull(path.join(projectPath, ENV_TEMPLATE_NAME));
    if (template === null) {
      throw new UpochiProjectNotFoundError(`Upochi env template is missing in ${projectPath}.`);
    }
    return { projectPath, envPath, envExists: false, raw: template };
  }

  private async readSnapshot(): Promise<UpochiConfigSnapshot> {
    const source = await this.readSource();
    const env = parseEnvDocument(source.raw);
    return {
      projectPath: source.projectPath,
      envPath: source.envPath,
      envExists: source.envExists,
      restartRequired: this.restartRequired,
      llm: {
        endpoint: env.LLM_ENDPOINT || null,
        model: env.LLM_MODEL || null,
        apiKey: maskSecret(env.LLM_API_KEY),
      },
    };
  }

  private async applyUpdate(
    patch: { model?: UpochiLlmPresetModel; apiKey?: string | null },
  ): Promise<UpochiConfigUpdateResult> {
    const source = await this.readSource();
    const current = parseEnvDocument(source.raw);
    const updates = new Map<string, string>();
    if (patch.model !== undefined) {
      updates.set("LLM_MODEL", patch.model);
      updates.set("LLM_ENDPOINT", UPOCHI_LLM_PRESETS[patch.model].endpoint);
    }
    if (patch.apiKey !== undefined) updates.set("LLM_API_KEY", patch.apiKey ?? "");

    const changedFields = MANAGED_KEYS.filter((key) =>
      updates.has(key) && (current[key] ?? "") !== updates.get(key)
    );
    if (changedFields.length > 0 || !source.envExists) {
      await atomicWritePrivate(source.envPath, updateEnvDocument(source.raw, updates));
      this.restartRequired = true;
    }

    return {
      changed: changedFields.length > 0 || !source.envExists,
      changedFields,
      config: await this.readSnapshot(),
    };
  }
}
