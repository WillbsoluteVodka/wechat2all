import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CodexGuiBinding } from "./types.js";

export interface CodexGuiBindingPathOptions {
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

export function codexGuiBindingConfigPath(
  opts: CodexGuiBindingPathOptions = {},
): string {
  const env = opts.env ?? process.env;
  return opts.configPath ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_GUI_BINDING_FILE) ??
    path.join(stateBaseDir(env), "codex-gui-bridge", "binding.json");
}

export async function readCodexGuiBinding(
  opts: CodexGuiBindingPathOptions = {},
): Promise<CodexGuiBinding | null> {
  const configPath = codexGuiBindingConfigPath(opts);
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as
      Partial<CodexGuiBinding>;
    const threadId = parsed.threadId?.trim();
    if (!threadId) return null;
    return {
      threadId,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      project: typeof parsed.project === "string" ? parsed.project : undefined,
      boundAt: typeof parsed.boundAt === "number" ? parsed.boundAt : Date.now(),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeCodexGuiBinding(
  binding: CodexGuiBinding,
  opts: CodexGuiBindingPathOptions = {},
): Promise<CodexGuiBinding> {
  const configPath = codexGuiBindingConfigPath(opts);
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const tmpPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(binding, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(tmpPath, configPath);
    await fs.chmod(configPath, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
  return binding;
}
