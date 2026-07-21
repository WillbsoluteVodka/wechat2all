import { spawn } from "node:child_process";

import type {
  OfficeCliRunRequest,
  OfficeCliRunResult,
  OfficeCliRunner,
} from "./types.js";

export interface SpawnOfficeCliRunnerOptions {
  executable?: string;
  env?: Readonly<Record<string, string | undefined>>;
  maxOutputBytes?: number;
}

function appendChunk(current: string, chunk: Buffer, maxBytes: number): string {
  if (Buffer.byteLength(current) >= maxBytes) return current;
  const available = maxBytes - Buffer.byteLength(current);
  return current + chunk.subarray(0, available).toString("utf8");
}

export function createOfficeCliRunner(
  opts: SpawnOfficeCliRunnerOptions = {},
): OfficeCliRunner {
  const executable = opts.executable?.trim() || "officecli";
  const maxOutputBytes = opts.maxOutputBytes ?? 512 * 1024;
  const env = {
    ...process.env,
    ...opts.env,
    OFFICECLI_SKIP_UPDATE: "1",
  };

  async function run(request: OfficeCliRunRequest): Promise<OfficeCliRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, request.args, {
        cwd: request.cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: OfficeCliRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          exitCode: 124,
          stdout,
          stderr: `${stderr}\nOfficeCLI command timed out after ${request.timeoutMs}ms.`.trim(),
        });
      }, request.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendChunk(stdout, chunk, maxOutputBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendChunk(stderr, chunk, maxOutputBytes);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        finish({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }

  return {
    run,
    version() {
      return run({ args: ["--version"], cwd: process.cwd(), timeoutMs: 10_000 });
    },
  };
}
