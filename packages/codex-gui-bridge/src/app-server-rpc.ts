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
  onServerRequest?: (request: CodexAppServerRequest) => void;
}

export interface CodexAppServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
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

  const bundledPaths = [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    `${env.HOME ?? ""}/Applications/Codex.app/Contents/Resources/codex`,
    `${env.HOME ?? ""}/Applications/ChatGPT.app/Contents/Resources/codex`,
  ];
  const bundledPath = bundledPaths.find((candidate) => candidate && existsSync(candidate));
  if (bundledPath) return bundledPath;

  return "codex";
}

export class CodexAppServerRpc implements CodexAppServerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private readonly command: string;
  private readonly args: string[];
  private readonly defaultTimeoutMs: number;
  private readonly onServerRequest?: (request: CodexAppServerRequest) => void;
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
  private disposed = false;

  constructor(opts: CodexAppServerRpcOptions = {}) {
    this.command = opts.command ?? resolveCodexExecutable();
    this.args = opts.socketPath
      ? ["app-server", "proxy", "--sock", opts.socketPath]
      : ["app-server", "--stdio"];
    this.defaultTimeoutMs = opts.timeoutMs ?? 8_000;
    this.onServerRequest = opts.onServerRequest;
  }

  private spawnChild(): ChildProcessWithoutNullStreams {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-16_384);
    });
    child.on("error", (error) => {
      if (this.child === child) this.child = undefined;
      this.rejectAll(
        new Error(`${this.command} ${this.args.join(" ")} spawn failed: ${error.message}`),
      );
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (this.pending.size > 0) {
        this.rejectAll(
          new Error(
            `${this.command} ${this.args.join(" ")} exited before responding: ` +
              `code=${code ?? "null"} signal=${signal ?? "null"} ${this.stderrSummary()}`,
          ),
        );
      }
    });
    return child;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new Error("Codex app-server transport is already closed.");
    const child = this.child;
    if (child && !child.stdin.destroyed && child.stdin.writable) return child;
    return this.spawnChild();
  }

  request<T>(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex app-server transport is already closed."));
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensureChild();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
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

      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          if (this.child === child) this.child = undefined;
          reject(new Error(
            `Failed to write ${method} to Codex app-server: ${error.message}. ` +
              this.stderrSummary(),
          ));
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (this.child === child) this.child = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    const message: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) message.params = params;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensureChild();
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error && this.child === child) this.child = undefined;
      });
    } catch {
      // The next request will report a detailed transport error and retry.
    }
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.rejectAll(new Error("Codex app-server transport was closed."));
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
      this.onServerRequest?.({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      this.child?.stdin.write(`${JSON.stringify({
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
