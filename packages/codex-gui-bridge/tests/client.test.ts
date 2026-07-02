import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodexGuiAppServerBridge,
  type CodexAppServerTransport,
} from "../src/index.js";

class FakeTransport implements CodexAppServerTransport {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  readonly guiInjectedTextByThread = new Map<string, string>();
  readonly guiTurnReadCounts = new Map<string, number>();

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "initialize":
        return {
          userAgent: "fake-codex",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "macos",
        } as T;
      case "thread/list":
        return {
          data: [{
            id: "thread-1",
            name: "Bridge work",
            preview: "first message",
            cwd: "/tmp/wechat2all",
            status: { type: "idle" },
            recencyAt: 1_785_000_000,
            modelProvider: "openai",
          }],
        } as T;
      case "thread/read":
        const readParams = params as { threadId: string; includeTurns?: boolean };
        return {
          thread: {
            id: readParams.threadId,
            name: "Bridge work",
            preview: "first message",
            cwd: "/tmp/wechat2all",
            status: { type: "idle" },
            recencyAt: 1_785_000_000,
            modelProvider: "openai",
            turns: readParams.includeTurns
              ? this.guiInjectedTextByThread.has(readParams.threadId)
                ? [this.guiTurn(readParams.threadId)]
                : []
              : undefined,
          },
        } as T;
      case "thread/resume":
        return {
          thread: {
            id: (params as { threadId: string }).threadId,
            name: "Bridge work",
            cwd: "/tmp/wechat2all",
            status: { type: "idle" },
          },
        } as T;
      case "turn/start":
        return { turn: { id: "turn-1" } } as T;
      case "account/rateLimits/read":
        return {
          rateLimits: {
            primary: {
              usedPercent: 3,
              windowDurationMins: 300,
              resetsAt: 1_785_003_307,
            },
            secondary: {
              usedPercent: 7,
              windowDurationMins: 10080,
              resetsAt: 1_785_600_000,
            },
          },
          rateLimitResetCredits: { availableCount: 1 },
        } as T;
      default:
        throw new Error(`unexpected method ${method}`);
    }
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  emitNotification(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) {
      handler(method, params);
    }
  }

  private guiTurn(threadId: string): unknown {
    const count = (this.guiTurnReadCounts.get(threadId) ?? 0) + 1;
    this.guiTurnReadCounts.set(threadId, count);
    const completed = count > 1;
    return {
      id: "gui-turn-1",
      status: completed ? "completed" : "interrupted",
      error: null,
      items: [
        {
          type: "userMessage",
          id: "gui-user-1",
          content: [{
            type: "text",
            text: this.guiInjectedTextByThread.get(threadId),
            text_elements: [],
          }],
        },
        ...(completed
          ? [{
              type: "agentMessage",
              id: "gui-agent-1",
              text: "GUI final answer.",
              phase: "final_answer",
            }]
          : []),
      ],
    };
  }
}

test("lists chats and binds a thread through app-server protocol", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });

  const chats = await bridge.listChats();
  assert.equal(chats[0].id, "thread-1");
  assert.equal(chats[0].title, "Bridge work");
  assert.equal(chats[0].project, "wechat2all");

  const binding = await bridge.bindThread("thread-1");
  assert.equal(binding.threadId, "thread-1");
  assert.equal(binding.project, "wechat2all");
  assert.equal(transport.calls[0].method, "initialize");
  assert.deepEqual(transport.notifications, [{ method: "initialized", params: {} }]);
});

test("starts a turn with standardized text input on the bound thread", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-1",
    text: "continue from WeChat",
  });
  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-1",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    replyMode: "final",
    error: undefined,
  });
  assert.deepEqual(
    transport.calls.filter((call) => call.method === "thread/resume").map((call) => call.params),
    [{ threadId: "thread-1" }],
  );
  assert.deepEqual(
    transport.calls.find((call) => call.method === "turn/start")?.params,
    {
      threadId: "thread-1",
      clientUserMessageId: "wechat-message-1",
      input: [{
        type: "text",
        text: "continue from WeChat",
        text_elements: [],
      }],
    },
  );
});

test("waits for turn completion and returns final answer text", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-2",
    text: "answer me",
  });

  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      type: "agentMessage",
      id: "assistant-1",
      text: "Working...",
      phase: "commentary",
    },
  });
  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [
        {
          type: "agentMessage",
          id: "assistant-2",
          text: "Done from Codex.",
          phase: "final_answer",
        },
      ],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-2",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: "Done from Codex.",
    replyMode: "final",
    error: undefined,
  });
});

test("final reply mode ignores non-final agent messages", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-final-mode",
    text: "answer me",
  });

  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [{
        type: "agentMessage",
        id: "assistant-thinking-1",
        text: "Thinking-only text should stay out of WeChat.",
        phase: "commentary",
      }],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-final-mode",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    replyMode: "final",
    error: undefined,
  });
});

test("silent reply mode waits for completion but suppresses assistant text", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-silent-mode",
    text: "answer me",
    replyMode: "silent",
  });

  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [{
        type: "agentMessage",
        id: "assistant-final-1",
        text: "Done from Codex.",
        phase: "final_answer",
      }],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-silent-mode",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    replyMode: "silent",
    error: undefined,
  });
});

test("stream reply mode returns all completed assistant text parts", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-stream-mode",
    text: "answer me",
    replyMode: "stream",
  });

  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      type: "agentMessage",
      id: "assistant-commentary-1",
      text: "Working...",
      phase: "commentary",
    },
  });
  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [{
        type: "agentMessage",
        id: "assistant-final-1",
        text: "Done from Codex.",
        phase: "final_answer",
      }],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-stream-mode",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: "Working...\n\nDone from Codex.",
    replyParts: ["Working...", "Done from Codex."],
    replyMode: "stream",
    error: undefined,
  });
});

test("gui-automation mode injects into Codex GUI and polls bound thread", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1000,
    guiPromptInjector: async (text, context) => {
      assert.equal(context?.threadId, "thread-1");
      assert.equal(context?.threadOpenDelayMs, 900);
      transport.guiInjectedTextByThread.set(context?.threadId ?? "frontmost-thread", text);
    },
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({
    id: "wechat-message-3",
    text: "show up in GUI",
  });

  assert.equal(transport.guiInjectedTextByThread.get("thread-1"), "show up in GUI");
  assert.deepEqual(result, {
    id: "wechat-message-3",
    threadId: "thread-1",
    turnId: "gui-turn-1",
    status: "completed",
    finalText: "GUI final answer.",
    replyParts: undefined,
    replyMode: "final",
    error: undefined,
  });
  assert.equal(
    transport.calls.some((call) => call.method === "turn/start"),
    false,
  );
});

test("gui-automation opens and polls the explicitly bound thread, not the frontmost chat", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1000,
    guiThreadOpenDelayMs: 1234,
    guiPromptInjector: async (text, context) => {
      transport.guiInjectedTextByThread.set(context?.threadId ?? "frontmost-thread", text);
    },
  });

  await bridge.bindThread("thread-2");
  transport.guiInjectedTextByThread.set("frontmost-thread", "wrong chat prompt");
  const result = await bridge.sendPrompt({
    id: "wechat-message-4",
    text: "send to bound chat",
  });

  assert.equal(transport.guiInjectedTextByThread.get("thread-2"), "send to bound chat");
  assert.equal(transport.guiInjectedTextByThread.get("frontmost-thread"), "wrong chat prompt");
  assert.deepEqual(result, {
    id: "wechat-message-4",
    threadId: "thread-2",
    turnId: "gui-turn-1",
    status: "completed",
    finalText: "GUI final answer.",
    replyParts: undefined,
    replyMode: "final",
    error: undefined,
  });
});

test("refuses to send before a thread is bound", async () => {
  const bridge = new CodexGuiAppServerBridge({ transport: new FakeTransport() });

  await assert.rejects(
    bridge.sendPrompt({ text: "no target" }),
    /not bound/,
  );
});

test("reads token usage from top-level account rate limits", async () => {
  const bridge = new CodexGuiAppServerBridge({ transport: new FakeTransport() });

  const usage = await bridge.getTokenUsage();
  assert.equal(usage.windows[0].label, "5h");
  assert.equal(usage.windows[0].remainingText, "97%");
  assert.equal(usage.windows[1].label, "Weekly");
  assert.equal(usage.windows[1].remainingText, "93%");
  assert.equal(usage.resetCreditsText, "1 reset available");
});
