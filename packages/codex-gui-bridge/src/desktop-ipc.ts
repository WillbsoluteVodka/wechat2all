import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { CodexDesktopIpcTransport } from "./types.js";

const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const INITIAL_CLIENT_ID = "initializing-client";

const METHOD_VERSIONS: Readonly<Record<string, number>> = {
  "thread-follower-load-complete-history": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-steer-turn": 1,
};

interface IpcResponse {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  result?: unknown;
  error?: string;
}

interface IpcInitializeResult {
  clientId?: string;
}

interface IpcMessage {
  type?: string;
  requestId?: string;
  resultType?: string;
  method?: string;
  result?: unknown;
  error?: string;
}

export interface CodexDesktopIpcRpcOptions {
  socketPath?: string;
  timeoutMs?: number;
  clientType?: string;
  socketFactory?: () => net.Socket;
}

export function resolveCodexDesktopIpcSocketPath(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\codex-ipc";
  const fileName = typeof process.getuid === "function"
    ? `ipc-${process.getuid()}.sock`
    : "ipc.sock";
  return path.join(os.tmpdir(), "codex-ipc", fileName);
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new Error(`Invalid Codex Desktop IPC frame size: ${payload.length}.`);
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class CodexDesktopIpcRpc implements CodexDesktopIpcTransport {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly clientType: string;
  private readonly socketFactory: () => net.Socket;
  private disposed = false;

  constructor(opts: CodexDesktopIpcRpcOptions = {}) {
    this.socketPath = opts.socketPath ?? resolveCodexDesktopIpcSocketPath();
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.clientType = opts.clientType ?? "wechat2all-codex-gui-bridge";
    this.socketFactory = opts.socketFactory ?? (() => net.connect(this.socketPath));
  }

  request<T>(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex Desktop IPC transport is already closed."));
    }

    return new Promise<T>((resolve, reject) => {
      const socket = this.socketFactory();
      let buffered = Buffer.alloc(0);
      let clientId = INITIAL_CLIENT_ID;
      let targetRequestId: string | undefined;
      let settled = false;

      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };

      const send = (message: unknown): void => {
        try {
          socket.write(encodeFrame(message));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const sendRequest = (
        requestMethod: string,
        requestParams: unknown,
        version: number,
      ): string => {
        const requestId = randomUUID();
        send({
          type: "request",
          requestId,
          sourceClientId: clientId,
          version,
          method: requestMethod,
          params: requestParams,
          timeoutMs,
        });
        return requestId;
      };

      const handleResponse = (message: IpcResponse): void => {
        if (
          message.resultType === "success" &&
          message.method === "initialize"
        ) {
          const initialized = message.result as IpcInitializeResult | undefined;
          if (!initialized?.clientId) {
            finish(new Error("Codex Desktop IPC initialize response has no client id."));
            return;
          }
          clientId = initialized.clientId;
          targetRequestId = sendRequest(
            method,
            params,
            METHOD_VERSIONS[method] ?? 0,
          );
          return;
        }
        if (message.requestId !== targetRequestId) return;
        if (message.resultType === "success") {
          finish(undefined, message.result as T);
          return;
        }
        finish(new Error(
          `Codex Desktop IPC ${method} failed: ${message.error ?? "unknown error"}.`,
        ));
      };

      const handleMessage = (message: IpcMessage): void => {
        if (message.type === "client-discovery-request" && message.requestId) {
          send({
            type: "client-discovery-response",
            requestId: message.requestId,
            response: { canHandle: false },
          });
          return;
        }
        if (message.type === "response" && message.requestId) {
          handleResponse(message as IpcResponse);
        }
      };

      const timer = setTimeout(() => {
        finish(new Error(
          `Timed out waiting for Codex Desktop IPC ${method} after ${timeoutMs}ms.`,
        ));
      }, timeoutMs);

      socket.on("connect", () => {
        sendRequest("initialize", { clientType: this.clientType }, 0);
      });
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4) {
          const length = buffered.readUInt32LE(0);
          if (length === 0 || length > MAX_FRAME_BYTES) {
            finish(new Error(`Invalid Codex Desktop IPC frame length: ${length}.`));
            return;
          }
          if (buffered.length < length + 4) return;
          const payload = buffered.subarray(4, length + 4);
          buffered = buffered.subarray(length + 4);
          try {
            handleMessage(JSON.parse(payload.toString("utf8")) as IpcMessage);
          } catch (error) {
            finish(new Error(
              `Invalid Codex Desktop IPC payload: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ));
            return;
          }
        }
      });
      socket.on("error", (error) => {
        finish(new Error(
          `Cannot connect to Codex Desktop IPC at ${this.socketPath}: ${error.message}`,
        ));
      });
      socket.on("close", () => {
        if (!settled) {
          finish(new Error(`Codex Desktop IPC closed before ${method} completed.`));
        }
      });
    });
  }

  close(): void {
    this.disposed = true;
  }
}
