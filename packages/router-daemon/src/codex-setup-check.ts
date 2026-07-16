import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

const CHECK_RELATIVE_PATH = path.join(
  "packages",
  "codex-gui-bridge",
  "scripts",
  "check.sh",
);

export interface CodexSetupCheckLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface CodexSetupCheckOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  scriptPath?: string;
  logger?: CodexSetupCheckLogger;
  onItem?: (item: CodexSetupCheckItem) => void;
}

export interface CodexSetupCheckResult {
  started: boolean;
  scriptPath?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  items: CodexSetupCheckItem[];
  error?: string;
}

export type CodexSetupCheckItemStatus = "pass" | "missing" | "warn" | "unknown" | "info";

export interface CodexSetupCheckItem {
  status: CodexSetupCheckItemStatus;
  message: string;
  section: string | null;
}

function defaultLogger(): CodexSetupCheckLogger {
  return {
    info(message) {
      console.log(`[codex-route/setup-check] ${message}`);
    },
    warn(message) {
      console.warn(`[codex-route/setup-check] ${message}`);
    },
  };
}

function checkEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.WECHAT2ALL_CODEX_SETUP_CHECK?.trim().toLowerCase();
  return !value || !["0", "false", "no", "off"].includes(value);
}

export function resolveCodexSetupCheckPath(
  opts: Pick<CodexSetupCheckOptions, "env" | "cwd" | "scriptPath"> = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.scriptPath ?? env.WECHAT2ALL_CODEX_SETUP_CHECK_PATH?.trim();
  const candidates = [
    explicit ? path.resolve(cwd, explicit) : undefined,
    path.resolve(cwd, CHECK_RELATIVE_PATH),
    path.resolve(cwd, "../..", CHECK_RELATIVE_PATH),
    path.resolve(import.meta.dirname, "../../..", CHECK_RELATIVE_PATH),
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && fs.existsSync(candidate))
  );
}

function forwardLines(
  stream: Readable | null,
  write: (line: string) => void,
): void {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf-8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) write(line);
  });
  stream.on("end", () => {
    if (pending) write(pending);
  });
}

function parseChecklistLine(
  line: string,
  section: string | null,
): CodexSetupCheckItem | undefined {
  const match = line.match(/^\s{2}(PASS|MISSING|WARN|UNKNOWN|INFO)\s+(.+)$/);
  if (!match) return undefined;
  return {
    status: match[1].toLowerCase() as CodexSetupCheckItemStatus,
    message: match[2].trim(),
    section,
  };
}

export async function runCodexSetupCheck(
  opts: CodexSetupCheckOptions = {},
): Promise<CodexSetupCheckResult> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? defaultLogger();
  if (!checkEnabled(env)) {
    logger.info("startup probe disabled by WECHAT2ALL_CODEX_SETUP_CHECK=0");
    return { started: false, items: [], error: "Codex setup check is disabled." };
  }

  const scriptPath = resolveCodexSetupCheckPath(opts);
  if (!scriptPath) {
    logger.warn(`Codex setup checker not found: ${CHECK_RELATIVE_PATH}`);
    return { started: false, items: [], error: "Codex setup checker was not found." };
  }

  const repoRoot = path.resolve(path.dirname(scriptPath), "../../..");
  logger.info(`starting ./${CHECK_RELATIVE_PATH} --probe`);

  return new Promise<CodexSetupCheckResult>((resolve) => {
    let settled = false;
    let currentSection: string | null = null;
    const items: CodexSetupCheckItem[] = [];
    const finish = (result: CodexSetupCheckResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(scriptPath, ["--probe"], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    forwardLines(child.stdout, (line) => {
      logger.info(line);
      const item = parseChecklistLine(line, currentSection);
      if (item) {
        items.push(item);
        opts.onItem?.({ ...item });
      } else if (
        line.trim()
        && !line.startsWith(" ")
        && line !== "Codex route setup check"
        && line !== "汇总"
      ) {
        currentSection = line.trim();
      }
    });
    forwardLines(child.stderr, (line) => logger.warn(line));
    child.once("error", (error) => {
      logger.warn(`could not start setup probe: ${error.message}`);
      finish({ started: false, scriptPath, items, error: error.message });
    });
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        logger.info("startup probe completed without missing conditions");
      } else {
        logger.warn(
          `startup probe completed with exit=${exitCode ?? signal ?? "unknown"}; ` +
            "WeConnect will continue starting",
        );
      }
      finish({ started: true, scriptPath, exitCode, signal, items });
    });
  });
}
