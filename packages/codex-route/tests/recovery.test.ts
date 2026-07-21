import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryMemoryStore,
  RuntimeRouteRegistry,
  type RuntimeHandlerContext,
  type RuntimeMessage,
} from "@wechat2all/runtime";

import { createCodexConnector } from "../src/index.js";

function testContext(): RuntimeHandlerContext {
  return {
    profileId: "main",
    connectorId: "codex-bridge",
    client: {} as RuntimeHandlerContext["client"],
    memory: new InMemoryMemoryStore(),
    memoryScope: {
      profileId: "main",
      connectorId: "codex-bridge",
      conversationId: "user-1",
    },
    route: { id: "codex", profileId: "main", connectorId: "codex-bridge" },
    routes: new RuntimeRouteRegistry(),
  };
}

function message(id: string, text: string): RuntimeMessage {
  return {
    id,
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: Date.now(),
    kind: "text",
    text,
    attachments: [],
    raw: {},
  };
}

function firstText(actions: Awaited<ReturnType<ReturnType<typeof createCodexConnector>["handleMessage"]>>): string {
  return "text" in actions[0] ? String(actions[0].text) : "";
}

test("/recover bypasses a stuck conversation queue and keeps later prompts usable", async () => {
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let recoverCalls = 0;
  const connector = createCodexConnector({
    id: "codex-bridge",
    operationTimeoutMs: 5_000,
    client: {
      async getStatus() {
        return { state: "working" };
      },
      async getCurrentBinding() {
        return { threadId: "thread-1" };
      },
      async sendPrompt(prompt) {
        if (prompt.text === "stuck") {
          firstStarted();
          return new Promise(() => undefined);
        }
        return { id: prompt.id, threadId: "thread-1", finalText: `${prompt.text} done` };
      },
      async recover() {
        recoverCalls += 1;
        return { recovered: true, threadId: "thread-1", detail: "restarted" };
      },
    },
  });
  const context = testContext();

  void connector.handleMessage(message("m1", "stuck"), context);
  await started;
  const recovered = await connector.handleMessage(message("m2", "/recover"), context);
  const usable = await connector.handleMessage(message("m3", "next"), context);

  assert.equal(recoverCalls, 1);
  assert.match(firstText(recovered), /Recovered/);
  assert.match(firstText(usable), /next done/);
});

test("route watchdog releases a request that never settles and triggers recovery", async () => {
  let recoverCalls = 0;
  let sends = 0;
  const connector = createCodexConnector({
    id: "codex-bridge",
    operationTimeoutMs: 20,
    client: {
      async getStatus() {
        return { state: "working" };
      },
      async getCurrentBinding() {
        return { threadId: "thread-1" };
      },
      async sendPrompt(prompt) {
        sends += 1;
        if (sends === 1) return new Promise(() => undefined);
        return { id: prompt.id, threadId: "thread-1", finalText: "second done" };
      },
      async recover() {
        recoverCalls += 1;
        return { recovered: true, threadId: "thread-1", detail: "restarted" };
      },
    },
  });
  const context = testContext();

  const timedOut = await connector.handleMessage(message("m1", "first"), context);
  const next = await connector.handleMessage(message("m2", "second"), context);

  assert.match(firstText(timedOut), /watchdog/);
  assert.match(firstText(timedOut), /重新发送/);
  assert.equal(recoverCalls, 1);
  assert.match(firstText(next), /second done/);
});
