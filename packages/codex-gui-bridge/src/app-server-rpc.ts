import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

import type { CodexAppServerTransport } from "./types.js";

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

export interface CodexAppServerRpcOptions {
  command?: string;
  socketPath?: string;
  timeoutMs?: number;
}

function stripEnvQuotes(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]|['"]$/g, "");
}

export function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const envPath = stripEnvQuotes(env.CODEX_CLI_PATH) ??
    stripEnvQuotes(env.WECHAT2ALL_CODEX_BIN);
  if (envPath && existsSync(envPath)) return envPath;

  const bundledPath = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(bundledPath)) return bundledPath;

  return "codex";
}

export class CodexAppServerRpc implements CodexAppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly defaultTimeoutMs: number;
  private readonly notificationHandlers = new Set<
    (method: string, params: unknown) => void
  >();
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;

  constructor(opts: CodexAppServerRpcOptions = {}) {
    const command = opts.command ?? resolveCodexExecutable();
    const args = opts.socketPath
      ? ["app-server", "proxy", "--sock", opts.socketPath]
      : ["app-server", "--stdio"];
    this.defaultTimeoutMs = opts.timeoutMs ?? 8_000;
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.stdout.setEncoding("utf-8");
    this.child.stderr.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-16_384);
    });
    this.child.on("error", (error) => {
      this.rejectAll(new Error(`${command} ${args.join(" ")} spawn failed: ${error.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.rejectAll(
          new Error(
            `${command} ${args.join(" ")} exited before responding: ` +
              `code=${code ?? "null"} signal=${signal ?? "null"} ${this.stderrSummary()}`,
          ),
        );
      }
    });
  }

  request<T>(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server transport is already closed."));
    }

    const id = this.nextId;
    this.nextId += 1;
    const message: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) message.params = params;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. ${this.stderrSummary()}`));
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

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) message.params = params;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
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
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `wechat2all-codex-gui-bridge does not implement ${message.method}`,
        },
      })}\n`);
      return;
    }

    if (message.id == null && message.method) {
      for (const handler of this.notificationHandlers) {
        handler(message.method, message.params);
      }
      return;
    }

    const numericId = typeof message.id === "number" ? message.id : null;
    if (numericId == null) return;

    const pending = this.pending.get(numericId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(numericId);

    if (message.error) {
      pending.reject(
        new Error(message.error.message ?? `RPC error ${message.error.code ?? "unknown"}`),
      );
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

  private stderrSummary(): string {
    const stderr = this.stderrBuffer.trim();
    return stderr ? `stderr: ${stderr}` : "";
  }
}
