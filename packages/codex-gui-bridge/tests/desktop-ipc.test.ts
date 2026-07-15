import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { test } from "node:test";

import { CodexDesktopIpcRpc } from "../src/index.js";

function encode(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function duplexPair(): { client: Socket; server: Duplex } {
  let client!: Duplex;
  let server!: Duplex;
  client = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const copy = Buffer.from(chunk);
      queueMicrotask(() => server.push(copy));
      callback();
    },
  });
  server = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const copy = Buffer.from(chunk);
      queueMicrotask(() => client.push(copy));
      callback();
    },
  });
  queueMicrotask(() => client.emit("connect"));
  return { client: client as unknown as Socket, server };
}

test(
  "Codex Desktop IPC initializes, rejects discovery, and routes a versioned request",
  { skip: process.platform === "win32" },
  async () => {
    const received: Array<Record<string, unknown>> = [];
    const { client, server } = duplexPair();
    let buffered = Buffer.alloc(0);
    let targetRequest: Record<string, unknown> | undefined;
    server.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < length + 4) return;
        const message = JSON.parse(
          buffered.subarray(4, length + 4).toString("utf8"),
        ) as Record<string, unknown>;
        buffered = buffered.subarray(length + 4);
        received.push(message);

        if (message.method === "initialize") {
          server.write(encode({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            handledByClientId: "router",
            result: { clientId: "wechat2all-client" },
          }));
          continue;
        }
        if (message.method === "thread-follower-start-turn") {
          targetRequest = message;
          server.write(encode({
            type: "client-discovery-request",
            requestId: "discovery-1",
            request: { method: "ide-context", version: 0, params: {} },
          }));
          continue;
        }
        if (message.type === "client-discovery-response" && targetRequest) {
          server.write(encode({
            type: "response",
            requestId: targetRequest.requestId,
            resultType: "success",
            method: "thread-follower-start-turn",
            handledByClientId: "desktop-owner",
            result: { result: { turn: { id: "turn-ipc-1" } } },
          }));
        }
      }
    });

    const rpc = new CodexDesktopIpcRpc({
      timeoutMs: 2_000,
      socketFactory: () => client,
    });
    const result = await rpc.request<{ result: { turn: { id: string } } }>(
      "thread-follower-start-turn",
      { conversationId: "thread-1", turnStartParams: { input: [] } },
    );
    assert.equal(result.result.turn.id, "turn-ipc-1");
    assert.equal(received[0]?.method, "initialize");
    assert.deepEqual(received[0]?.params, {
      clientType: "wechat2all-codex-gui-bridge",
    });
    assert.equal(received[1]?.method, "thread-follower-start-turn");
    assert.equal(received[1]?.version, 1);
    assert.equal(received[1]?.sourceClientId, "wechat2all-client");
    assert.deepEqual(received[2], {
      type: "client-discovery-response",
      requestId: "discovery-1",
      response: { canHandle: false },
    });
    rpc.close();
    server.destroy();
  },
);

test(
  "reads the live runtime status from the Codex Desktop thread snapshot",
  { skip: process.platform === "win32" },
  async () => {
    const { client, server } = duplexPair();
    let buffered = Buffer.alloc(0);
    server.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < length + 4) return;
        const message = JSON.parse(
          buffered.subarray(4, length + 4).toString("utf8"),
        ) as Record<string, unknown>;
        buffered = buffered.subarray(length + 4);

        if (message.method === "initialize") {
          server.write(encode({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            result: { clientId: "wechat2all-client" },
          }));
          continue;
        }
        if (message.method !== "thread-follower-load-complete-history") continue;
        server.write(encode({
          type: "broadcast",
          method: "thread-stream-state-changed",
          params: {
            conversationId: "thread-live-1",
            hostId: "local",
            change: {
              type: "snapshot",
              revision: 12,
              conversationState: {
                title: "Live work",
                cwd: "/tmp/wechat2all",
                updatedAt: 1_785_000_123_000,
                threadRuntimeStatus: { type: "active", activeFlags: [] },
                turnHistory: {
                  history: {
                    entitiesByKey: {
                      "turn:latest": {
                        turnStartedAtMs: 1_785_000_122_000,
                        status: "inProgress",
                      },
                    },
                  },
                },
              },
            },
          },
        }));
        server.write(encode({
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "thread-follower-load-complete-history",
          result: { revision: 12 },
        }));
      }
    });

    const rpc = new CodexDesktopIpcRpc({
      timeoutMs: 2_000,
      socketFactory: () => client,
    });
    const snapshot = await rpc.readThreadSnapshot("thread-live-1");

    assert.deepEqual(snapshot, {
      threadId: "thread-live-1",
      title: "Live work",
      projectPath: "/tmp/wechat2all",
      updatedAt: 1_785_000_123_000,
      runtimeStatus: { type: "active", activeFlags: [] },
      latestTurnStatus: "inProgress",
    });
    rpc.close();
    server.destroy();
  },
);
