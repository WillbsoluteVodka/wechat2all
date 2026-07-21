import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  CodexGuiAppServerBridge,
  type CodexAppServerTransport,
  type CodexDesktopIpcTransport,
} from "../src/index.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function tempImagePath(fileName = "image.png"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-image-test-"));
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));
  return filePath;
}

async function tempFilePath(fileName = "report.pdf", content = "file"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-file-test-"));
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content);
  return filePath;
}

class FakeTransport implements CodexAppServerTransport {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  readonly guiInjectedTextByThread = new Map<string, string>();
  readonly guiTurnReadCounts = new Map<string, number>();
  readonly appServerTurnsByThread = new Map<string, Array<Record<string, unknown>>>();
  readonly unmaterializedThreadIds = new Set<string>();
  guiNewThreadId?: string;
  threadStatus: { type: string; activeFlags?: unknown[] } = { type: "idle" };
  activeTurn?: Record<string, unknown>;
  turnStartTurn: Record<string, unknown> = { id: "turn-1" };
  threadStartError?: Error;
  turnStartError?: Error;
  generation = 0;
  resetCalls = 0;

  getGeneration(): number {
    return this.generation;
  }

  reset(): void {
    this.resetCalls += 1;
    this.generation += 1;
  }

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
          data: [
            ...(this.guiNewThreadId
              ? [{
                  id: this.guiNewThreadId,
                  name: "GUI new chat",
                  preview: "first GUI message",
                  cwd: "/tmp/wechat2all",
                  status: this.threadStatus,
                  createdAt: 1_785_000_002,
                  recencyAt: 1_785_000_002,
                  modelProvider: "openai",
                }]
              : []),
            {
              id: "thread-1",
              name: "Bridge work",
              preview: "first message",
              cwd: "/tmp/wechat2all",
              status: this.threadStatus,
              recencyAt: 1_785_000_000,
              modelProvider: "openai",
            },
          ],
        } as T;
      case "thread/read":
        const readParams = params as { threadId: string; includeTurns?: boolean };
        if (
          readParams.includeTurns &&
          this.unmaterializedThreadIds.has(readParams.threadId)
        ) {
          throw new Error(
            `thread ${readParams.threadId} is not materialized yet; ` +
              "includeTurns is unavailable before first user message",
          );
        }
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
              ? [
                  ...(this.activeTurn ? [this.activeTurn] : []),
                  ...(this.appServerTurnsByThread.get(readParams.threadId) ?? []),
                  ...(this.guiInjectedTextByThread.has(readParams.threadId)
                    ? [this.guiTurn(readParams.threadId)]
                    : []),
                ]
              : undefined,
          },
        } as T;
      case "thread/resume":
        if (this.unmaterializedThreadIds.has((params as { threadId: string }).threadId)) {
          throw new Error(
            `thread ${(params as { threadId: string }).threadId} is not materialized yet`,
          );
        }
        return {
          thread: {
            id: (params as { threadId: string }).threadId,
            name: "Bridge work",
            cwd: "/tmp/wechat2all",
            status: this.threadStatus,
            turns: this.activeTurn ? [this.activeTurn] : undefined,
          },
        } as T;
      case "thread/start":
        if (this.threadStartError) throw this.threadStartError;
        this.unmaterializedThreadIds.add("thread-new");
        return {
          thread: {
            id: "thread-new",
            name: null,
            preview: "",
            cwd: (params as { cwd?: string }).cwd,
            status: { type: "idle" },
            createdAt: 1_785_000_001,
            updatedAt: 1_785_000_001,
            recencyAt: 1_785_000_001,
            modelProvider: "openai",
          },
          cwd: (params as { cwd?: string }).cwd,
        } as T;
      case "turn/start":
        if (this.turnStartError) throw this.turnStartError;
        this.unmaterializedThreadIds.delete((params as { threadId: string }).threadId);
        return { turn: this.turnStartTurn } as T;
      case "turn/steer":
        return { turnId: (params as { expectedTurnId: string }).expectedTurnId } as T;
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

class FakeDesktopIpcTransport implements CodexDesktopIpcTransport {
  readonly calls: Array<{ method: string; params?: unknown }> = [];

  constructor(
    private readonly appServer: FakeTransport,
    private noClientFailures = 0,
  ) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (this.noClientFailures > 0) {
      this.noClientFailures -= 1;
      throw new Error(
        "Codex Desktop IPC thread-follower-start-turn failed: no-client-found.",
      );
    }
    const request = params as {
      conversationId: string;
      turnStartParams: { input: unknown[] };
    };
    this.appServer.appServerTurnsByThread.set(request.conversationId, [{
      id: "desktop-ipc-turn-1",
      status: "completed",
      error: null,
      items: [
        {
          type: "userMessage",
          id: "desktop-ipc-user-1",
          content: request.turnStartParams.input,
        },
        {
          type: "agentMessage",
          id: "desktop-ipc-agent-1",
          text: "Desktop IPC final answer.",
          phase: "final_answer",
        },
      ],
    }]);
    return {
      result: {
        turn: {
          id: "desktop-ipc-turn-1",
          status: "inProgress",
          items: [],
        },
      },
    } as T;
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

test("reinitializes app-server after the transport session changes", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });

  await bridge.bindThread("thread-1");
  assert.equal(transport.calls.filter((call) => call.method === "initialize").length, 1);

  transport.reset();
  await bridge.listChats();

  assert.equal(transport.calls.filter((call) => call.method === "initialize").length, 2);
});

test("manual recovery resets app-server without losing the bound chat", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });
  await bridge.bindThread("thread-1");

  const recovery = await bridge.recover("test fault");

  assert.equal(recovery.recovered, true);
  assert.equal(recovery.threadId, "thread-1");
  assert.equal(transport.resetCalls, 1);
  assert.equal((await bridge.getCurrentBinding())?.threadId, "thread-1");
  assert.equal(transport.calls.filter((call) => call.method === "initialize").length, 2);
});

test("persists a bound thread and restores it in a new bridge instance", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-binding-"));
  const bindingConfigPath = path.join(stateDir, "private", "binding.json");
  const first = new CodexGuiAppServerBridge({
    transport: new FakeTransport(),
    bindingConfigPath,
  });

  const binding = await first.bindThread("thread-1");
  first.close();

  const secondTransport = new FakeTransport();
  const second = new CodexGuiAppServerBridge({
    transport: secondTransport,
    bindingConfigPath,
  });
  assert.deepEqual(await second.getCurrentBinding(), binding);
  assert.equal(secondTransport.calls.length, 0);
  assert.equal((await fs.stat(bindingConfigPath)).mode & 0o077, 0);
  assert.equal((await fs.stat(path.dirname(bindingConfigPath))).mode & 0o077, 0);
  second.close();
});

test("initializes app-server before /new uses a restored project path", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-init-new-"));
  const bindingConfigPath = path.join(stateDir, "private", "binding.json");
  const first = new CodexGuiAppServerBridge({
    transport: new FakeTransport(),
    bindingConfigPath,
  });
  await first.bindThread("thread-1");
  first.close();

  const transport = new FakeTransport();
  const second = new CodexGuiAppServerBridge({ transport, bindingConfigPath });
  await second.startThread();

  assert.deepEqual(
    transport.calls.slice(0, 2).map((call) => call.method),
    ["initialize", "thread/start"],
  );
  second.close();
});

test("starts a fresh thread in the bound chat project and binds it", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });

  await bridge.bindThread("thread-1");
  const binding = await bridge.startThread();

  assert.equal(binding.threadId, "thread-new");
  assert.equal(binding.project, "wechat2all");
  assert.equal(binding.projectPath, "/tmp/wechat2all");
  assert.equal(binding.pendingFirstMessage, true);
  assert.deepEqual(
    transport.calls.find((call) => call.method === "thread/start")?.params,
    {
      cwd: "/tmp/wechat2all",
      serviceName: "wechat2all-codex-gui-bridge",
    },
  );
  assert.deepEqual(await bridge.getCurrentBinding(), binding);
});

test("restores a pending fresh thread without trying GUI history first", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-new-chat-"));
  const bindingConfigPath = path.join(stateDir, "private", "binding.json");
  const first = new CodexGuiAppServerBridge({
    transport: new FakeTransport(),
    bindingConfigPath,
  });
  await first.bindThread("thread-1");
  await first.startThread();
  first.close();

  const transport = new FakeTransport();
  let guiInjectionCount = 0;
  const second = new CodexGuiAppServerBridge({
    transport,
    bindingConfigPath,
    deliveryMode: "gui-automation",
    guiPromptInjector: async () => {
      guiInjectionCount += 1;
    },
  });
  const pending = second.sendPrompt({
    id: "wechat-restored-first-message",
    text: "first message after restart",
  });
  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-new",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [],
    },
  });

  assert.equal((await pending).status, "completed");
  assert.equal(guiInjectionCount, 0);
  const turnStartIndex = transport.calls.findIndex((call) => call.method === "turn/start");
  const historyReadIndex = transport.calls.findIndex((call) =>
      call.method === "thread/read" &&
      (call.params as { includeTurns?: boolean })?.includeTurns === true
  );
  assert.notEqual(turnStartIndex, -1);
  assert.equal(historyReadIndex === -1 || turnStartIndex < historyReadIndex, true);
  assert.equal(
    transport.calls.some((call) => call.method === "thread/resume"),
    false,
  );
  assert.equal((await second.getCurrentBinding())?.pendingFirstMessage, undefined);
  const persisted = JSON.parse(await fs.readFile(bindingConfigPath, "utf-8")) as
    Record<string, unknown>;
  assert.equal("pendingFirstMessage" in persisted, false);
  second.close();
});

test("does not change the binding when starting a fresh thread fails", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });
  const originalBinding = await bridge.bindThread("thread-1");
  transport.threadStartError = new Error("thread start failed");

  await assert.rejects(bridge.startThread(), /thread start failed/);

  assert.deepEqual(await bridge.getCurrentBinding(), originalBinding);
});

test("creates a new app-server thread without requiring GUI availability", async () => {
  const transport = new FakeTransport();
  let newChatMenuClicks = 0;
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiThreadOpener: async () => {
      throw new Error("Codex URL open failed");
    },
    guiNewChatStarter: async () => {
      newChatMenuClicks += 1;
    },
  });
  await bridge.bindThread("thread-1");

  const binding = await bridge.startThread();

  assert.equal(newChatMenuClicks, 0);
  assert.equal(binding.threadId, "thread-new");
  assert.equal(binding.pendingFirstMessage, true);
  assert.equal(
    transport.calls.filter((call) => call.method === "thread/start").length,
    1,
  );
});

test("requires an existing binding before starting a fresh thread", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });

  await assert.rejects(bridge.startThread(), /not bound/i);
  assert.equal(
    transport.calls.some((call) => call.method === "thread\/start"),
    false,
  );
});

test("creates a fresh app-server chat and opens it in GUI after the first prompt", async () => {
  const transport = new FakeTransport();
  let guiInjectionCount = 0;
  let guiNewChatCount = 0;
  let openedThreadId: string | undefined;
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiNewChatStarter: async () => {
      guiNewChatCount += 1;
    },
    guiThreadOpener: async (threadId) => {
      openedThreadId = threadId;
    },
    guiPromptInjector: async () => {
      guiInjectionCount += 1;
    },
  });

  await bridge.bindThread("thread-1");
  const newBinding = await bridge.startThread();
  assert.equal(newBinding.pendingFirstMessage, true);
  assert.equal(newBinding.threadId, "thread-new");
  const pending = bridge.sendPrompt({
    id: "wechat-new-chat-first-message",
    text: "first message",
  });
  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-new",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [{
        type: "agentMessage",
        id: "assistant-new-chat-1",
        text: "New chat completed.",
        phase: "final_answer",
      }],
    },
  });
  const result = await pending;

  assert.equal(guiNewChatCount, 0);
  assert.equal(openedThreadId, "thread-new");
  assert.equal(guiInjectionCount, 0);
  assert.equal(result.threadId, "thread-new");
  assert.equal(result.finalText, "New chat completed.");
  assert.equal((await bridge.getCurrentBinding())?.threadId, "thread-new");
  assert.equal((await bridge.getCurrentBinding())?.pendingGuiNewChat, undefined);
  assert.equal((await bridge.getCurrentBinding())?.pendingFirstMessage, undefined);
  assert.equal(
    transport.calls.some((call) => call.method === "thread/start"),
    true,
  );
  assert.equal(
    transport.calls.some((call) => call.method === "turn/start"),
    true,
  );
});

test("restores a pending app-server new chat and opens it after completion", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-gui-new-"));
  const bindingConfigPath = path.join(stateDir, "binding.json");
  const first = new CodexGuiAppServerBridge({
    transport: new FakeTransport(),
    bindingConfigPath,
    deliveryMode: "gui-automation",
    guiThreadOpener: async () => undefined,
    guiNewChatStarter: async () => undefined,
    guiThreadOpenDelayMs: 1,
  });
  await first.bindThread("thread-1");
  await first.startThread();
  first.close();

  const transport = new FakeTransport();
  let restoredOpenCount = 0;
  let restoredNewChatCount = 0;
  const second = new CodexGuiAppServerBridge({
    transport,
    bindingConfigPath,
    deliveryMode: "gui-automation",
    guiThreadOpener: async (threadId) => {
      assert.equal(threadId, "thread-new");
      restoredOpenCount += 1;
    },
    guiNewChatStarter: async () => {
      restoredNewChatCount += 1;
    },
    guiPromptInjector: async () => {
      throw new Error("GUI prompt injection must not be used");
    },
  });

  const pending = second.sendPrompt({ text: "first message after restart" });
  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-new",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [],
    },
  });
  const result = await pending;

  assert.equal(restoredOpenCount, 1);
  assert.equal(restoredNewChatCount, 0);
  assert.equal(result.threadId, "thread-new");
  assert.equal((await second.getCurrentBinding())?.threadId, "thread-new");
  second.close();
});

test("recovers when an unmaterialized GUI thread was not marked as fresh locally", async () => {
  const transport = new FakeTransport();
  transport.unmaterializedThreadIds.add("thread-new");
  let guiInjectionCount = 0;
  const bridge = new CodexGuiAppServerBridge({
    transport,
    defaultThreadId: "thread-new",
    deliveryMode: "gui-automation",
    guiThreadOpener: async () => undefined,
    guiPromptInjector: async () => {
      guiInjectionCount += 1;
    },
  });

  const pending = bridge.sendPrompt({
    id: "wechat-recovered-first-message",
    text: "recover first message",
  });
  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-new",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [],
    },
  });

  assert.equal((await pending).status, "completed");
  assert.equal(guiInjectionCount, 0);
  assert.equal(
    transport.calls.some((call) =>
      call.method === "thread/read" &&
      (call.params as { includeTurns?: boolean })?.includeTurns === true
    ),
    true,
  );
});

test("reports status from App Server turns without reading Desktop IPC", async () => {
  const transport = new FakeTransport();
  let desktopSnapshotReads = 0;
  transport.appServerTurnsByThread.set("thread-1", [{
    id: "active-turn-1",
    status: "inProgress",
    items: [{ id: "user-1", type: "userMessage" }],
  }]);
  const bridge = new CodexGuiAppServerBridge({
    transport,
    desktopIpcTransport: {
      async request<T>(): Promise<T> {
        throw new Error("unexpected desktop IPC request");
      },
      async readThreadSnapshot() {
        desktopSnapshotReads += 1;
        throw new Error("Desktop IPC must not be used by /status");
      },
    },
  });

  await bridge.bindThread("thread-1");
  const working = await bridge.getStatus();

  assert.equal(working.state, "working");
  assert.match(working.summary ?? "", /App Server.*active-turn-1.*in progress/);
  assert.equal(desktopSnapshotReads, 0);

  transport.appServerTurnsByThread.set("thread-1", [{
    id: "active-turn-1",
    status: "inProgress",
    items: [{
      id: "assistant-1",
      type: "agentMessage",
      phase: "final_answer",
      text: "Done.",
    }],
  }]);
  const completed = await bridge.getStatus();
  assert.equal(completed.state, "completed");
  assert.match(completed.summary ?? "", /App Server.*active-turn-1.*completed/);
  assert.equal(desktopSnapshotReads, 0);

  transport.appServerTurnsByThread.set("thread-1", [{
    id: "failed-turn-1",
    status: "failed",
    error: { message: "model unavailable" },
    items: [],
  }]);
  const blocked = await bridge.getStatus();
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.summary ?? "", /App Server.*failed-turn-1.*model unavailable/);
  assert.equal(desktopSnapshotReads, 0);
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

test("desktop-ipc mode sends text to the exact owning GUI thread", async () => {
  const transport = new FakeTransport();
  const desktopIpcTransport = new FakeDesktopIpcTransport(transport);
  const bridge = new CodexGuiAppServerBridge({
    transport,
    desktopIpcTransport,
    deliveryMode: "desktop-ipc",
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({
    id: "wechat-desktop-ipc-text",
    text: "continue in the bound GUI task",
  });

  assert.equal(result.turnId, "desktop-ipc-turn-1");
  assert.equal(result.finalText, "Desktop IPC final answer.");
  assert.equal(
    transport.calls.some((call) => call.method === "turn/start"),
    false,
  );
  assert.deepEqual(desktopIpcTransport.calls, [{
    method: "thread-follower-start-turn",
    params: {
      conversationId: "thread-1",
      turnStartParams: {
        input: [{
          type: "text",
          text: "continue in the bound GUI task",
          text_elements: [],
        }],
        attachments: [],
        clientUserMessageId: "wechat-desktop-ipc-text",
        runtimeWorkspaceRoots: ["/tmp/wechat2all"],
      },
    },
  }]);
});

test("desktop-ipc mode opens an unloaded GUI thread and retries once", async () => {
  const transport = new FakeTransport();
  const desktopIpcTransport = new FakeDesktopIpcTransport(transport, 1);
  const openedThreads: string[] = [];
  const bridge = new CodexGuiAppServerBridge({
    transport,
    desktopIpcTransport,
    deliveryMode: "desktop-ipc",
    desktopIpcThreadOpenDelayMs: 1,
    guiThreadOpener: async (threadId) => {
      openedThreads.push(threadId);
    },
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({
    id: "wechat-desktop-ipc-open-thread",
    text: "continue in an unloaded GUI task",
  });

  assert.equal(result.finalText, "Desktop IPC final answer.");
  assert.deepEqual(openedThreads, ["thread-1"]);
  assert.equal(desktopIpcTransport.calls.length, 2);
  assert.deepEqual(desktopIpcTransport.calls[0], desktopIpcTransport.calls[1]);
});

test("desktop-ipc mode sends localImage input through the exact GUI thread", async () => {
  const imagePath = await tempImagePath("wechat-image.png");
  const transport = new FakeTransport();
  const desktopIpcTransport = new FakeDesktopIpcTransport(transport);
  const bridge = new CodexGuiAppServerBridge({
    transport,
    desktopIpcTransport,
    deliveryMode: "desktop-ipc",
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({
    id: "wechat-desktop-ipc-image",
    text: "describe this image",
    attachments: [{ kind: "image", filePath: imagePath, mimeType: "image/png" }],
  });

  assert.equal(result.finalText, "Desktop IPC final answer.");
  const params = desktopIpcTransport.calls[0]?.params as {
    conversationId: string;
    turnStartParams: { input: unknown[]; runtimeWorkspaceRoots: string[] };
  };
  assert.equal(params.conversationId, "thread-1");
  assert.deepEqual(params.turnStartParams.input, [
    { type: "text", text: "describe this image", text_elements: [] },
    { type: "localImage", path: imagePath },
  ]);
  assert.deepEqual(params.turnStartParams.runtimeWorkspaceRoots, [
    "/tmp/wechat2all",
    path.dirname(imagePath),
  ]);
});

test("starts a turn with image attachments on the bound thread", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-image-message-1",
    text: "",
    attachments: [{
      kind: "image",
      filePath: "/tmp/wechat-image.jpg",
      fileName: "wechat-image.jpg",
      mimeType: "image/jpeg",
    }],
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
      items: [
        {
          type: "userMessage",
          id: "user-image-1",
          content: [{
            type: "localImage",
            path: "/tmp/wechat-image.jpg",
          }],
        },
        {
          type: "agentMessage",
          id: "assistant-1",
          text: "I can see the image.",
          phase: "final_answer",
        },
      ],
    },
  });

  const result = await pending;
  assert.equal(result.finalText, "I can see the image.");
  assert.equal(result.outputFiles, undefined);
  assert.deepEqual(
    transport.calls.find((call) => call.method === "turn/start")?.params,
    {
      threadId: "thread-1",
      clientUserMessageId: "wechat-image-message-1",
      input: [
        {
          type: "localImage",
          path: "/tmp/wechat-image.jpg",
        },
      ],
      runtimeWorkspaceRoots: ["/tmp/wechat2all", "/tmp"],
    },
  );
  assert.deepEqual(
    transport.calls.find((call) => call.method === "thread/resume")?.params,
    {
      threadId: "thread-1",
      runtimeWorkspaceRoots: ["/tmp/wechat2all", "/tmp"],
    },
  );
});

test("steers image prompts into an active bound turn instead of starting another turn", async () => {
  const transport = new FakeTransport();
  transport.threadStatus = { type: "active", activeFlags: [] };
  transport.activeTurn = {
    id: "active-turn-1",
    status: "inProgress",
    items: [],
  };
  const bridge = new CodexGuiAppServerBridge({
    transport,
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1000,
  });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-active-image",
    text: "用一句话描述图中主体",
    attachments: [{
      kind: "image",
      filePath: "/tmp/wechat-image.jpg",
      fileName: "wechat-image.jpg",
      mimeType: "image/jpeg",
    }],
  });
  while (!transport.calls.some((call) => call.method === "turn/steer")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "active-turn-1",
      status: "completed",
      error: null,
      items: [{
        type: "agentMessage",
        id: "assistant-active-image",
        text: "图中主体是一座白色建筑。",
        phase: "final_answer",
      }],
    },
  });

  const result = await pending;
  assert.equal(result.finalText, "图中主体是一座白色建筑。");
  assert.equal(transport.calls.some((call) => call.method === "turn/start"), false);
  assert.deepEqual(
    transport.calls.find((call) => call.method === "thread/resume")?.params,
    {
      threadId: "thread-1",
      runtimeWorkspaceRoots: ["/tmp/wechat2all", "/tmp"],
    },
  );
  assert.deepEqual(
    transport.calls.find((call) => call.method === "turn/steer")?.params,
    {
      threadId: "thread-1",
      clientUserMessageId: "wechat-active-image",
      input: [
        {
          type: "text",
          text: "用一句话描述图中主体",
          text_elements: [],
        },
        {
          type: "localImage",
          path: "/tmp/wechat-image.jpg",
        },
      ],
      expectedTurnId: "active-turn-1",
    },
  );
});

test("polls the bound thread when the completion notification is missed", async () => {
  const transport = new FakeTransport();
  transport.appServerTurnsByThread.set("thread-1", [{
    id: "turn-1",
    status: "completed",
    error: null,
    items: [{
      type: "agentMessage",
      id: "assistant-polled",
      text: "Recovered from thread polling.",
      phase: "final_answer",
    }],
  }]);
  const bridge = new CodexGuiAppServerBridge({
    transport,
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1000,
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({
    id: "wechat-missed-notification",
    text: "recover this reply",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "Recovered from thread polling.");
});

test("extends the turn deadline while a long thread is compacting context", async () => {
  const transport = new FakeTransport();
  transport.appServerTurnsByThread.set("thread-1", [{
    id: "turn-1",
    status: "inProgress",
    error: null,
    items: [{
      id: "compaction-1",
      type: "contextCompaction",
    }],
  }]);
  const bridge = new CodexGuiAppServerBridge({
    transport,
    guiPollIntervalMs: 1,
    turnTimeoutMs: 20,
    compactionGraceMs: 100,
  });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-image-after-long-chat",
    text: "describe this image",
    attachments: [{
      kind: "image",
      filePath: "/tmp/wechat-image.jpg",
      mimeType: "image/jpeg",
    }],
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  transport.appServerTurnsByThread.set("thread-1", [{
    id: "turn-1",
    status: "completed",
    error: null,
    items: [
      { id: "compaction-1", type: "contextCompaction" },
      {
        id: "assistant-after-compaction",
        type: "agentMessage",
        text: "A gray cat is standing beside a window.",
        phase: "final_answer",
      },
    ],
  }]);

  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "A gray cat is standing beside a window.");
});

test("keeps listening after the configured timeout while work is active", async () => {
  const transport = new FakeTransport();
  transport.appServerTurnsByThread.set("thread-1", [{
    id: "turn-1",
    status: "inProgress",
    error: null,
    items: [{ id: "user-1", type: "userMessage" }],
  }]);
  const bridge = new CodexGuiAppServerBridge({
    transport,
    guiPollIntervalMs: 1,
    turnTimeoutMs: 20,
    inProgressGraceMs: 100,
  });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-active-work",
    text: "finish this active request",
  });

  await new Promise((resolve) => setTimeout(resolve, 140));
  transport.appServerTurnsByThread.set("thread-1", [{
    id: "turn-1",
    status: "completed",
    error: null,
    items: [{
      id: "assistant-active-work",
      type: "agentMessage",
      text: "The active request finished after the observation deadline.",
      phase: "final_answer",
    }],
  }]);

  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "The active request finished after the observation deadline.");
});

test("starts a turn with file attachments as local path references", async () => {
  const filePath = await tempFilePath("report.pdf", "pdf-content");
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-file-message-1",
    text: "总结这个文件",
    attachments: [{
      kind: "file",
      filePath,
      fileName: "report.pdf",
      mimeType: "application/pdf",
      size: 11,
    }],
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
        id: "assistant-1",
        text: "File summary.",
        phase: "final_answer",
      }],
    },
  });

  const result = await pending;
  assert.equal(result.finalText, "File summary.");
  assert.deepEqual(
    transport.calls.find((call) => call.method === "turn/start")?.params,
    {
      threadId: "thread-1",
      clientUserMessageId: "wechat-file-message-1",
      input: [{
        type: "text",
        text:
          "总结这个文件\n\n" +
          "WeChat attachments for this request are cached on this computer.\n" +
          "Use these local paths directly when answering:\n" +
          `- file 1: report.pdf: ${filePath} [application/pdf] (11 bytes)`,
        text_elements: [],
      }],
      runtimeWorkspaceRoots: ["/tmp/wechat2all", path.dirname(filePath)],
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

test("ignores a transient interrupted completion until the same turn has a final answer", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1000,
  });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-transient-interrupted",
    text: "finish even if App Server briefly reports interrupted",
  });

  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "interrupted",
      error: null,
      completedAt: null,
      items: [],
    },
  });

  // A bare interrupted event is a transient Codex App Server snapshot. The
  // bridge must remain subscribed instead of returning `No Final Reply`.
  assert.equal(transport.notificationHandlers.size, 1);

  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      error: null,
      completedAt: 1_785_000_100,
      items: [{
        type: "agentMessage",
        id: "assistant-after-transient-interrupted",
        text: "The turn completed after the transient interruption.",
        phase: "final_answer",
      }],
    },
  });

  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(
    result.finalText,
    "The turn completed after the transient interruption.",
  );
});

test("keeps polling while thread/read exposes a bare interrupted snapshot", async () => {
  const transport = new FakeTransport();
  transport.turnStartTurn = {
    id: "turn-1",
    status: "interrupted",
    error: null,
    completedAt: null,
    items: [],
  };
  transport.appServerTurnsByThread.set("thread-1", [{
    id: "turn-1",
    status: "interrupted",
    error: null,
    completedAt: null,
    items: [],
  }]);
  const bridge = new CodexGuiAppServerBridge({
    transport,
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1000,
  });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-polled-transient-interrupted",
    text: "keep polling this interrupted snapshot",
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  transport.appServerTurnsByThread.set("thread-1", [{
    id: "turn-1",
    status: "completed",
    error: null,
    completedAt: 1_785_000_100,
    items: [{
      type: "agentMessage",
      id: "assistant-after-polled-interruption",
      text: "Polling recovered the final answer.",
      phase: "final_answer",
    }],
  }]);

  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "Polling recovered the final answer.");
});

test("returns an interrupted turn once App Server reports a real error", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-real-interruption",
    text: "surface a real interruption",
  });
  while (transport.notificationHandlers.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "interrupted",
      error: { message: "The turn was cancelled." },
      completedAt: 1_785_000_100,
      items: [],
    },
  });

  const result = await pending;
  assert.equal(result.status, "interrupted");
  assert.equal(result.error, "The turn was cancelled.");
});

test("returns local image files mentioned by Codex output", async () => {
  const outputImagePath = await tempImagePath("codex-output.png");
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-with-output-image",
    text: "make an image",
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
      items: [
        {
          type: "agentMessage",
          id: "assistant-1",
          text: `Done.\n\n![chart](file://${outputImagePath})`,
          phase: "final_answer",
        },
      ],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-with-output-image",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: `Done.\n\n![chart](file://${outputImagePath})`,
    outputFiles: [{
      kind: "image",
      filePath: outputImagePath,
      source: "markdown",
    }],
    replyMode: "final",
    error: undefined,
  });
});

test("returns structured local image files produced by Codex tools", async () => {
  const outputImagePath = await tempImagePath("codex-generated.png");
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-with-structured-output-image",
    text: "generate an image",
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
      items: [
        {
          type: "toolResult",
          id: "tool-image-1",
          content: [{
            type: "image",
            path: outputImagePath,
          }],
        },
        {
          type: "agentMessage",
          id: "assistant-1",
          text: "Generated.",
          phase: "final_answer",
        },
      ],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-with-structured-output-image",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: "Generated.",
    outputFiles: [{
      kind: "image",
      filePath: outputImagePath,
      source: "toolResult",
    }],
    replyMode: "final",
    error: undefined,
  });
});

test("returns structured local files produced by Codex tools", async () => {
  const outputFilePath = await tempFilePath("analysis.csv", "name,value\napple,1\n");
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-with-structured-output-file",
    text: "generate a csv",
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
      items: [
        {
          type: "toolResult",
          id: "tool-file-1",
          content: [{
            type: "file",
            path: outputFilePath,
          }],
        },
        {
          type: "agentMessage",
          id: "assistant-1",
          text: `Generated [analysis.csv](file://${outputFilePath}).`,
          phase: "final_answer",
        },
      ],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-with-structured-output-file",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: `Generated [analysis.csv](file://${outputFilePath}).`,
    outputFiles: [{
      kind: "file",
      filePath: outputFilePath,
      source: "toolResult",
    }],
    replyMode: "final",
    error: undefined,
  });
});

test("returns local files from encoded file URLs with spaces", async () => {
  const outputFilePath = await tempFilePath("My Report.pdf", "pdf bytes");
  const outputFileUrl = pathToFileURL(outputFilePath).href;
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-with-spaced-output-file",
    text: "generate a report",
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
        id: "assistant-1",
        text: `Generated [My Report.pdf](${outputFileUrl}).`,
        phase: "final_answer",
      }],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-with-spaced-output-file",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: `Generated [My Report.pdf](${outputFileUrl}).`,
    outputFiles: [{
      kind: "file",
      filePath: outputFilePath,
      source: "markdown",
    }],
    replyMode: "final",
    error: undefined,
  });
});

test("returns plain absolute paths for generated source-code files", async () => {
  const outputFilePath = await tempFilePath("automation.py", "print('done')\n");
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-with-source-output-file",
    text: "generate a Python script",
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
        id: "assistant-1",
        text: `Saved script at ${outputFilePath}.`,
        phase: "final_answer",
      }],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-with-source-output-file",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: `Saved script at ${outputFilePath}.`,
    outputFiles: [{
      kind: "file",
      filePath: outputFilePath,
      source: "agentMessage",
    }],
    replyMode: "final",
    error: undefined,
  });
});

test("returns local audio files mentioned by Codex output", async () => {
  const outputFilePath = await tempFilePath("answer.silk", "voice bytes");
  const outputFileUrl = pathToFileURL(outputFilePath).href;
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-with-output-audio",
    text: "generate voice",
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
        id: "assistant-1",
        text: `Generated [answer.silk](${outputFileUrl}).`,
        phase: "final_answer",
      }],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-with-output-audio",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: `Generated [answer.silk](${outputFileUrl}).`,
    outputFiles: [{
      kind: "file",
      filePath: outputFilePath,
      source: "markdown",
    }],
    replyMode: "final",
    error: undefined,
  });
});

test("ignores output paths that are directories", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-dir-output-"));
  const directoryPath = path.join(dir, "not-a-file.png");
  await fs.mkdir(directoryPath);
  const directoryUrl = pathToFileURL(directoryPath).href;
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-with-directory-output",
    text: "generate an image",
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
        id: "assistant-1",
        text: `Generated [not-a-file.png](${directoryUrl}).`,
        phase: "final_answer",
      }],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-with-directory-output",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: `Generated [not-a-file.png](${directoryUrl}).`,
    replyMode: "final",
    error: undefined,
  });
});

test("returns Codex image generation saved paths", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-generated-test-"));
  const placeholderPath = path.join(outputDir, "_image_id_.png");
  const materializedPath = path.join(outputDir, "ig_apple.png");
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({ transport, turnTimeoutMs: 1000 });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-message-with-generated-image",
    text: "generate an apple image",
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
      items: [
        {
          type: "imageGeneration",
          id: "ig_apple",
          status: "generating",
          revisedPrompt: "A red apple on a white background.",
          result: TINY_PNG_BASE64,
          savedPath: placeholderPath,
        },
      ],
    },
  });

  assert.deepEqual(await pending, {
    id: "wechat-message-with-generated-image",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    outputFiles: [{
      kind: "image",
      filePath: materializedPath,
      source: "imageGeneration",
    }],
    replyMode: "final",
    error: undefined,
  });
  assert.equal(await fs.readFile(materializedPath, "base64"), TINY_PNG_BASE64);
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

test("gui-automation mode injects into Codex GUI and polls the bound thread", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1_000,
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
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.turnId, "gui-turn-1");
  assert.equal(result.finalText, "GUI final answer.");
  assert.equal(
    transport.calls.filter((call) => call.method === "turn/start").length,
    0,
  );
  const status = await bridge.getStatus();
  assert.match(status.summary ?? "", /Last delivery: gui-automation/);
});

test("gui-automation falls back to app-server when GUI injection fails", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    guiFallbackReconcileMs: 1,
    guiPromptInjector: async () => {
      throw new Error("display is asleep");
    },
  });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-screen-asleep",
    text: "continue while the display is asleep",
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
        type: "agentMessage", id: "assistant-asleep-1", text: "Still completed.",
        phase: "final_answer",
      }],
    },
  });
  const result = await pending;

  assert.equal(result.finalText, "Still completed.");
  assert.equal(
    transport.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
  const status = await bridge.getStatus();
  assert.match(status.summary ?? "", /Last delivery: app-server-fallback/);
});

test("gui-automation falls back when a locked display silently accepts injection but creates no turn", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    guiFallbackReconcileMs: 2,
    guiTurnObservationMs: 5,
    guiPromptInjector: async () => {
      // macOS may let osascript exit successfully while the locked UI ignores
      // the paste/Return events. Deliberately do not publish a GUI turn.
    },
  });

  await bridge.bindThread("thread-1");
  const pending = bridge.sendPrompt({
    id: "wechat-locked-display",
    text: "continue while the Mac is locked",
  });
  while (
    !transport.calls.some((call) => call.method === "turn/start")
    || transport.notificationHandlers.size === 0
  ) {
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
        id: "assistant-locked-display",
        text: "Completed through app-server.",
        phase: "final_answer",
      }],
    },
  });

  const result = await pending;
  assert.equal(result.finalText, "Completed through app-server.");
  assert.equal(
    transport.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
  const status = await bridge.getStatus();
  assert.match(status.summary ?? "", /Last delivery: app-server-fallback/);
});

test("gui-automation does not duplicate a GUI prompt that appears during final reconciliation", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    guiTurnObservationMs: 2,
    guiFallbackReconcileMs: 20,
    guiPromptInjector: async (text, context) => {
      setTimeout(() => {
        transport.guiInjectedTextByThread.set(context?.threadId ?? "thread-1", text);
      }, 5);
    },
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({ text: "slow GUI publication" });

  assert.equal(result.finalText, "GUI final answer.");
  assert.equal(transport.calls.some((call) => call.method === "turn/start"), false);
  const status = await bridge.getStatus();
  assert.match(status.summary ?? "", /Last delivery: gui-automation/);
});

test("gui-automation reports both GUI and fallback errors when delivery fails", async () => {
  const transport = new FakeTransport();
  transport.turnStartError = new Error("app-server is unavailable");
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    guiFallbackReconcileMs: 1,
    guiPromptInjector: async () => {
      throw new Error("display has no accessible Codex window");
    },
  });

  await bridge.bindThread("thread-1");
  await assert.rejects(
    bridge.sendPrompt({ text: "try delivery" }),
    (error: unknown) => {
      assert.match(String(error), /display has no accessible Codex window/);
      assert.match(String(error), /app-server is unavailable/);
      return true;
    },
  );
});

test("gui-automation mode injects regular-file references through the GUI", async () => {
  const transport = new FakeTransport();
  const filePath = await tempFilePath("gui-report.pdf", "pdf-content");
  let attachmentPaths: string[] | undefined;
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1_000,
    guiPromptInjector: async (text, context) => {
      attachmentPaths = context?.attachmentPaths;
      transport.guiInjectedTextByThread.set(context?.threadId ?? "frontmost-thread", text);
    },
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({
    id: "wechat-gui-file",
    text: "summarize this PDF",
    attachments: [{
      kind: "file",
      filePath,
      fileName: "gui-report.pdf",
      mimeType: "application/pdf",
    }],
  });

  assert.equal(result.finalText, "GUI final answer.");
  assert.deepEqual(attachmentPaths, [filePath]);
  const injected = transport.guiInjectedTextByThread.get("thread-1") ?? "";
  assert.match(injected, /summarize this PDF/);
  assert.match(injected, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(transport.calls.some((call) => call.method === "turn/start"), false);
});

test("gui-automation suppresses fallback when a GUI turn appears before injector error", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    guiFallbackReconcileMs: 10,
    turnTimeoutMs: 1_000,
    guiPromptInjector: async (text, context) => {
      transport.guiInjectedTextByThread.set(context?.threadId ?? "frontmost-thread", text);
      throw new Error("clipboard restoration failed after Return");
    },
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({ text: "already submitted" });

  assert.equal(result.finalText, "GUI final answer.");
  assert.equal(transport.calls.some((call) => call.method === "turn/start"), false);
});

test("does not classify user-role image input as Codex output", async () => {
  const transport = new FakeTransport();
  const imagePath = await tempImagePath("wechat-input.png");
  const bridge = new CodexGuiAppServerBridge({ transport });
  await bridge.bindThread("thread-1");

  const pending = bridge.sendPrompt({
    id: "wechat-user-role-image",
    text: "analyze the image",
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
      items: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: `<image path=${imagePath}>` },
            { type: "input_image", image_url: pathToFileURL(imagePath).href },
          ],
        },
        {
          type: "agentMessage",
          id: "assistant-user-image-1",
          text: "Input image analyzed.",
          phase: "final_answer",
        },
      ],
    },
  });

  const result = await pending;
  assert.equal(result.finalText, "Input image analyzed.");
  assert.equal(result.outputFiles, undefined);
});

test("never returns the original prompt attachment as an output file", async () => {
  const transport = new FakeTransport();
  const imagePath = await tempImagePath("same-input-output.png");
  const bridge = new CodexGuiAppServerBridge({ transport });
  await bridge.bindThread("thread-1");

  const pending = bridge.sendPrompt({
    id: "wechat-input-output-defense",
    text: "analyze this",
    attachments: [{ kind: "image", filePath: imagePath }],
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
        id: "assistant-echoed-path-1",
        text: `Done. ${imagePath}`,
        phase: "final_answer",
      }],
    },
  });

  const result = await pending;
  assert.equal(result.outputFiles, undefined);
});

test("gui-automation mode pastes image attachments and prompt through the GUI", async () => {
  const transport = new FakeTransport();
  let injectedText = "";
  let attachmentPaths: string[] | undefined;
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1_000,
    guiPromptInjector: async (text, context) => {
      injectedText = text;
      attachmentPaths = context?.attachmentPaths;
      transport.guiInjectedTextByThread.set(context?.threadId ?? "frontmost-thread", text);
    },
  });

  await bridge.bindThread("thread-1");
  const result = await bridge.sendPrompt({
    id: "wechat-image-gui-mode",
    text: "请分析这张微信图片。",
    attachments: [{
      kind: "image",
      filePath: "/tmp/wechat-image.jpg",
      fileName: "wechat-image.jpg",
      mimeType: "image/jpeg",
    }],
  });

  assert.equal(result.finalText, "GUI final answer.");
  assert.deepEqual(attachmentPaths, ["/tmp/wechat-image.jpg"]);
  assert.match(injectedText, /请分析这张微信图片。/);
  assert.match(injectedText, /image 1: wechat-image\.jpg: \/tmp\/wechat-image\.jpg/);
  assert.equal(transport.calls.some((call) => call.method === "turn/start"), false);
});

test("GUI opening failure does not block app-server localImage delivery", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    guiFallbackReconcileMs: 1,
    guiPromptInjector: async () => {
      throw new Error("Accessibility is unavailable");
    },
  });
  await bridge.bindThread("thread-1");

  const pending = bridge.sendPrompt({
    id: "wechat-image-gui-fallback",
    text: "analyze image",
    attachments: [{
      kind: "image",
      filePath: "/tmp/wechat-fallback-image.jpg",
    }],
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
        id: "assistant-image-fallback-1",
        text: "Fallback image analyzed.",
        phase: "final_answer",
      }],
    },
  });

  const result = await pending;
  assert.equal(result.finalText, "Fallback image analyzed.");
  assert.deepEqual(
    transport.calls.find((call) => call.method === "turn/start")?.params,
    {
      threadId: "thread-1",
      clientUserMessageId: "wechat-image-gui-fallback",
      input: [
        { type: "text", text: "analyze image", text_elements: [] },
        { type: "localImage", path: "/tmp/wechat-fallback-image.jpg" },
      ],
      runtimeWorkspaceRoots: ["/tmp/wechat2all", "/tmp"],
    },
  );
});

test("gui-automation injects into the explicitly bound thread", async () => {
  const transport = new FakeTransport();
  const bridge = new CodexGuiAppServerBridge({
    transport,
    deliveryMode: "gui-automation",
    guiPollIntervalMs: 1,
    turnTimeoutMs: 1_000,
    guiPromptInjector: async (text, context) => {
      transport.guiInjectedTextByThread.set(context?.threadId ?? "frontmost-thread", text);
    },
  });

  await bridge.bindThread("thread-2");
  transport.guiInjectedTextByThread.set("frontmost-thread", "wrong prompt");
  const result = await bridge.sendPrompt({
    id: "wechat-message-4",
    text: "send to bound chat",
  });

  assert.equal(transport.guiInjectedTextByThread.get("thread-2"), "send to bound chat");
  assert.equal(transport.guiInjectedTextByThread.get("frontmost-thread"), "wrong prompt");
  assert.equal(result.threadId, "thread-2");
  assert.equal(result.finalText, "GUI final answer.");
  assert.equal(transport.calls.some((call) => call.method === "turn/start"), false);
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
