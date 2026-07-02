import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CodexBridgePrompt } from "@wechat2all/codex-mcp/bridge";

export type CodexExecutionMode =
  | "resume-last"
  | "resume-session"
  | "exec"
  | "echo";

export interface CodexExecutionResult {
  finalText: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  mode: CodexExecutionMode;
}

export interface CodexPromptExecutor {
  run(prompt: CodexBridgePrompt): Promise<CodexExecutionResult>;
}

export interface CodexCliExecutorOptions {
  command?: string;
  mode?: Exclude<CodexExecutionMode, "echo">;
  sessionId?: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  extraArgs?: string[];
  bypassApprovalsAndSandbox?: boolean;
  env?: NodeJS.ProcessEnv;
}

function truncateOutput(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  return `${value.slice(0, Math.max(0, maxBytes - 128))}\n[output truncated]`;
}

export function formatCodexPrompt(prompt: CodexBridgePrompt): string {
  return [
    "你正在通过 wechat2all 的微信 codex route 接收用户消息。",
    "请把下面的微信消息当作当前 Codex 会话里的用户 prompt 继续处理。",
    "处理完成后，请给出适合转发回微信的简洁最终回复。",
    "",
    `<wechat_prompt id="${prompt.id}" conversationId="${prompt.conversationId}" senderId="${prompt.senderId}">`,
    prompt.text,
    "</wechat_prompt>",
  ].join("\n");
}

export function buildCodexArgs(params: {
  mode: Exclude<CodexExecutionMode, "echo">;
  outputLastMessagePath: string;
  sessionId?: string;
  model?: string;
  bypassApprovalsAndSandbox?: boolean;
  extraArgs?: string[];
}): string[] {
  const common = [
    ...(params.model ? ["--model", params.model] : []),
    ...(params.bypassApprovalsAndSandbox ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
    ...(params.extraArgs ?? []),
    "--output-last-message",
    params.outputLastMessagePath,
  ];

  if (params.mode === "resume-last") {
    return ["exec", "resume", "--last", ...common, "-"];
  }
  if (params.mode === "resume-session") {
    if (!params.sessionId) {
      throw new Error("resume-session mode requires --session-id or WECHAT2ALL_CODEX_SESSION_ID.");
    }
    return ["exec", "resume", ...common, params.sessionId, "-"];
  }
  return ["exec", ...common, "-"];
}

export class CodexCliExecutor implements CodexPromptExecutor {
  private command: string;
  private mode: Exclude<CodexExecutionMode, "echo">;
  private sessionId?: string;
  private cwd?: string;
  private model?: string;
  private timeoutMs: number;
  private maxOutputBytes: number;
  private extraArgs: string[];
  private bypassApprovalsAndSandbox: boolean;
  private env?: NodeJS.ProcessEnv;

  constructor(opts: CodexCliExecutorOptions = {}) {
    this.command = opts.command ?? "codex";
    this.mode = opts.mode ?? "resume-last";
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    this.maxOutputBytes = opts.maxOutputBytes ?? 1024 * 1024;
    this.extraArgs = opts.extraArgs ?? [];
    this.bypassApprovalsAndSandbox = opts.bypassApprovalsAndSandbox ?? false;
    this.env = opts.env;
  }

  async run(prompt: CodexBridgePrompt): Promise<CodexExecutionResult> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-run-"));
    const outputLastMessagePath = path.join(tempDir, "last-message.txt");
    const args = buildCodexArgs({
      mode: this.mode,
      outputLastMessagePath,
      sessionId: this.sessionId,
      model: this.model,
      bypassApprovalsAndSandbox: this.bypassApprovalsAndSandbox,
      extraArgs: this.extraArgs,
    });
    const promptText = formatCodexPrompt(prompt);

    try {
      const { stdout, stderr, exitCode } = await this.spawnCodex(args, promptText);
      let finalText = "";
      try {
        finalText = (await fs.readFile(outputLastMessagePath, "utf-8")).trim();
      } catch {
        finalText = stdout.trim();
      }
      return {
        finalText,
        stdout,
        stderr,
        exitCode,
        mode: this.mode,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private spawnCodex(args: string[], input: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 5000).unref();
      }, this.timeoutMs);
      timeout.unref();

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdout = truncateOutput(stdout + chunk, this.maxOutputBytes);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = truncateOutput(stderr + chunk, this.maxOutputBytes);
      });
      child.on("error", (err) => {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
      child.on("close", (code, signal) => {
        settled = true;
        clearTimeout(timeout);
        const exitCode = code ?? (signal ? 128 : 1);
        if (exitCode !== 0) {
          reject(new Error(
            `codex exited with code ${exitCode}${signal ? ` (${signal})` : ""}: ${stderr || stdout}`,
          ));
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
      child.stdin.end(input);
    });
  }
}

export class EchoCodexExecutor implements CodexPromptExecutor {
  async run(prompt: CodexBridgePrompt): Promise<CodexExecutionResult> {
    const finalText = `Echo from Codex watcher:\n${prompt.text}`;
    return {
      finalText,
      stdout: finalText,
      stderr: "",
      exitCode: 0,
      mode: "echo",
    };
  }
}
