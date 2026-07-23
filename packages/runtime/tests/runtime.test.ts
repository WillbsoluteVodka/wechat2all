import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  InMemoryMemoryStore,
  RuntimeActionQueue,
  RuntimeMediaPipeline,
  RuntimeRouteRegistry,
  WeChatRuntime,
  cliError,
  cliPanel,
  createAgentConnector,
  createDummyTTSProvider,
  createMcpConnector,
  createStateStoreMessageDeduper,
  FileRuntimeStateStore,
  createLocalJsonlAgentMemoryProvider,
  createLocalConnector,
  createMainAssistantConnector,
  createMainAssistantSessionReminderAction,
  createMem0AgentMemoryProvider,
  createMockLLMProvider,
  createRouteAssistantConnector,
  executeRuntimeActions,
  findMatchingRoutes,
  normalizeWeixinMessage,
} from "../src/index.js";
import type {
  AgentMemoryAppendTurnParams,
  AgentMemoryProvider,
  RuntimeAction,
  RuntimeMessage,
  RuntimeRoute,
} from "../src/index.js";

import { MessageItemType, MessageType } from "wechat2all";
import type { WeChatClient } from "wechat2all";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertRuntimeActions(
  actual: RuntimeAction[],
  expected: RuntimeAction[],
): void {
  const withoutPerformance = actual.map((action) => {
    const metadata = action.metadata;
    if (!metadata || !("performance" in metadata)) return action;

    const performance = metadata.performance as Record<string, unknown> | undefined;
    if (performance) {
      for (const value of Object.values(performance)) {
        if (value === undefined) continue;
        assert.equal(typeof value, "number");
        assert.ok((value as number) >= 0);
      }
    }

    const { performance: _performance, ...remainingMetadata } = metadata;
    const { metadata: _metadata, ...remainingAction } = action;
    return Object.keys(remainingMetadata).length
      ? { ...remainingAction, metadata: remainingMetadata } as RuntimeAction
      : remainingAction as RuntimeAction;
  });

  assert.deepEqual(withoutPerformance, expected);
}

test("cliPanel uses a tight ASCII header", () => {
  assert.equal(
    cliPanel("route / status", ["state: idle"]),
    [
      "+----------------+",
      "| route / status |",
      "+----------------+",
      "state: idle",
    ].join("\n"),
  );
});

test("cliError uses a tight ASCII header and leaves body lines unpadded", () => {
  assert.equal(
    cliError("llm unavailable", [
      "我现在连不上 LLM，所以这条消息暂时没法生成智能回复。",
      "  indented line stays indented",
    ]),
    [
      "+------------------------+",
      "| error: llm unavailable |",
      "+------------------------+",
      "我现在连不上 LLM，所以这条消息暂时没法生成智能回复。",
      "  indented line stays indented",
    ].join("\n"),
  );
});

test("normalizes text and media Weixin messages", () => {
  const message = normalizeWeixinMessage({
    profileId: "sales",
    msg: {
      message_id: 123,
      from_user_id: "user-1",
      to_user_id: "bot-1",
      message_type: MessageType.USER,
      create_time_ms: 42,
      context_token: "ctx",
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: "hello" } },
        {
          type: MessageItemType.FILE,
          file_item: { file_name: "a.pdf", len: "12" },
        },
      ],
    },
  });

  assert.equal(message.id, "123");
  assert.equal(message.profileId, "sales");
  assert.equal(message.conversationId, "user-1");
  assert.equal(message.kind, "mixed");
  assert.equal(message.text, "hello");
  assert.equal(message.attachments[0].kind, "file");
  assert.equal(message.replyToken?.contextToken, "ctx");
});

test("normalizes SDK voice transcription as runtime text", () => {
  const message = normalizeWeixinMessage({
    profileId: "main",
    msg: {
      message_id: 126,
      from_user_id: "user-1",
      context_token: "ctx",
      item_list: [{
        type: MessageItemType.VOICE,
        msg_id: "voice-1",
        voice_item: {
          text: "帮我看一下路由状态",
          playtime: 1200,
        },
      }],
    },
  });

  assert.equal(message.kind, "mixed");
  assert.equal(message.text, "帮我看一下路由状态");
  assert.equal(message.attachments[0].kind, "voice");
  assert.equal(message.attachments[0].durationMs, 1200);
});

test("normalization ignores empty protocol identifiers", () => {
  const message = normalizeWeixinMessage({
    profileId: "sales",
    msg: {
      message_id: 124,
      from_user_id: "user-1",
      session_id: "",
      group_id: "",
      context_token: "ctx",
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
    },
  });

  assert.equal(message.senderId, "user-1");
  assert.equal(message.conversationId, "user-1");
  assert.deepEqual(message.replyToken, {
    userId: "user-1",
    contextToken: "ctx",
  });

  const sessionOnlyMessage = normalizeWeixinMessage({
    profileId: "sales",
    msg: {
      message_id: 125,
      from_user_id: "",
      session_id: "session-user-1",
      group_id: "",
      context_token: "session-ctx",
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hi" } }],
    },
  });

  assert.equal(sessionOnlyMessage.senderId, "session-user-1");
  assert.equal(sessionOnlyMessage.conversationId, "session-user-1");
  assert.deepEqual(sessionOnlyMessage.replyToken, {
    userId: "session-user-1",
    contextToken: "session-ctx",
  });
});

test("routes messages by profile, kind, and text", () => {
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "sales",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "text",
    text: "need pricing",
    attachments: [],
    raw: {},
  };
  const routes: RuntimeRoute[] = [
    { id: "low", connectorId: "ignored", priority: 1, match: { textIncludes: "nope" } },
    { id: "high", connectorId: "sales", priority: 10, profileId: "sales", match: { kind: "text", textIncludes: "pricing" } },
  ];

  const matched = findMatchingRoutes(routes, message);
  assert.deepEqual(matched.map((route) => route.id), ["high"]);
});

test("command routes can be hidden from automatic matching", () => {
  const routes: RuntimeRoute[] = [
    {
      id: "fallback",
      connectorId: "main",
      priority: -100,
      terminal: true,
    },
    {
      id: "workspace",
      connectorId: "workspace-connector",
      priority: 900,
      terminal: true,
      match: { kind: "text", textCommands: [] },
    },
    {
      id: "status",
      connectorId: "status",
      priority: 800,
      terminal: true,
      match: { kind: "text", textCommands: "/status" },
    },
  ];
  const baseMessage: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "text",
    attachments: [],
    raw: {},
  };

  assert.deepEqual(
    findMatchingRoutes(routes, { ...baseMessage, text: "/status" }).map((route) => route.id),
    ["status"],
  );
  assert.deepEqual(
    findMatchingRoutes(routes, { ...baseMessage, text: "/workspace status" }).map((route) => route.id),
    ["fallback"],
  );
  assert.deepEqual(
    findMatchingRoutes(routes, { ...baseMessage, text: "是不是多了一个 workspaceroute" }).map((route) => route.id),
    ["fallback"],
  );
});

test("terminal routes stop lower-priority fallback routes", () => {
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "text",
    text: "报价",
    attachments: [],
    raw: {},
  };
  const routes: RuntimeRoute[] = [
    { id: "fallback", connectorId: "echo", priority: 1 },
    {
      id: "sales",
      connectorId: "sales",
      profileId: "main",
      priority: 100,
      terminal: true,
      match: { textIncludes: "报价" },
    },
  ];

  const matched = findMatchingRoutes(routes, message);
  assert.deepEqual(matched.map((route) => route.id), ["sales"]);
});

test("runtime route registry validates, clones, and replaces routes", () => {
  const registry = new RuntimeRouteRegistry({
    routes: [{ id: "fallback", connectorId: "main", priority: -1 }],
  });
  assert.throws(
    () => registry.addRoute({ id: "fallback", connectorId: "main" }),
    /already registered/,
  );

  const listed = registry.listRoutes();
  listed[0].connectorId = "mutated";
  assert.equal(registry.listRoutes()[0].connectorId, "main");

  registry.upsertRoute({ id: "fallback", connectorId: "other", enabled: false });
  assert.equal(registry.listRoutes()[0].connectorId, "other");
  assert.equal(registry.listRoutes()[0].enabled, false);

  assert.throws(
    () => registry.replaceRoutes([
      { id: "a", connectorId: "c" },
      { id: "a", connectorId: "c" },
    ]),
    /Duplicate route id/,
  );
});

test("file runtime state store persists credentials, routes, sync buf, and processed messages", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-state-"));
  const store = new FileRuntimeStateStore({ baseDir });
  await store.saveCredentials("default", {
    accountId: "abc@im.bot",
    token: "token",
    baseUrl: "https://example.test",
  });
  await store.saveSyncBuf("default", "sync-buf");
  await store.saveRoutes("default", [{ id: "r1", connectorId: "c1" }]);

  assert.equal((await store.loadCredentials("default"))?.token, "token");
  assert.equal(await store.loadSyncBuf("default"), "sync-buf");
  assert.deepEqual(await store.loadRoutes("default"), [{ id: "r1", connectorId: "c1" }]);
  assert.equal((await fs.stat(store.credentialsPath("default"))).mode & 0o077, 0);
  assert.equal((await fs.stat(store.routesPath("default"))).mode & 0o077, 0);
  assert.equal(await store.hasProcessedMessage("default", "k1"), false);

  await store.markProcessedMessage({
    key: "k1",
    profileId: "default",
    messageId: "m1",
    conversationId: "u1",
    processedAt: Date.now(),
  });
  assert.equal(await store.hasProcessedMessage("default", "k1"), true);
});

test("file runtime state store handles concurrent processed-message writes", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-state-concurrent-"));
  const store = new FileRuntimeStateStore({ baseDir });

  await Promise.all(Array.from({ length: 20 }, (_value, index) =>
    store.markProcessedMessage({
      key: `k${index}`,
      profileId: "default",
      messageId: `m${index}`,
      conversationId: "u1",
      processedAt: Date.now(),
    })
  ));

  assert.equal(await store.hasProcessedMessage("default", "k0"), true);
  assert.equal(await store.hasProcessedMessage("default", "k19"), true);
});

test("file runtime state store keeps unsafe profile ids inside the state root", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-state-safe-profile-"));
  const store = new FileRuntimeStateStore({ baseDir });
  const profileId = "../outside/profile";
  const profileDir = store.profileDir(profileId);
  const relative = path.relative(baseDir, profileDir);

  assert.equal(relative.startsWith(".."), false);
  assert.equal(path.isAbsolute(relative), false);

  await store.saveCredentials(profileId, {
    accountId: "abc@im.bot",
    token: "token",
  });
  assert.equal((await store.loadCredentials(profileId))?.token, "token");
  assert.equal(path.relative(baseDir, store.credentialsPath(profileId)).startsWith(".."), false);
});

test("file runtime state store hardens permissions for existing local state", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-state-permissions-"));
  const nestedDir = path.join(baseDir, "media", "default");
  const nestedFile = path.join(nestedDir, "legacy.jpg");
  await fs.mkdir(nestedDir, { recursive: true, mode: 0o755 });
  await fs.writeFile(nestedFile, "legacy", { mode: 0o644 });
  await fs.chmod(baseDir, 0o755);
  await fs.chmod(nestedDir, 0o755);
  await fs.chmod(nestedFile, 0o644);

  const store = new FileRuntimeStateStore({ baseDir });
  await store.securePermissions();

  assert.equal((await fs.stat(baseDir)).mode & 0o077, 0);
  assert.equal((await fs.stat(nestedDir)).mode & 0o077, 0);
  assert.equal((await fs.stat(nestedFile)).mode & 0o077, 0);
});

test("executes runtime actions against a WeChatClient-like object", async () => {
  const sent: string[] = [];
  const client = {
    async sendText(to: string, text: string) {
      sent.push(`${to}:${text}`);
      return "client-id";
    },
  } as unknown as WeChatClient;

  const results = await executeRuntimeActions({
    client,
    actions: [{ type: "send_text", conversationId: "user-1", text: "hi" }],
  });

  assert.equal(results[0].ok, true);
  assert.deepEqual(sent, ["user-1:hi"]);
});

test("runtime exposes async action dispatch to connectors", async () => {
  const sent: string[] = [];
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "main",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    connectors: [{
      id: "async-dispatch",
      async handleMessage(message, context) {
        await context.dispatchActions?.([{
          type: "send_text",
          conversationId: message.conversationId,
          text: "async reminder",
        }]);
        return [{ type: "noop", reason: "done" }];
      },
    }],
    routes: [
      {
        id: "async-route",
        profileId: "main",
        connectorId: "async-dispatch",
        terminal: true,
      },
    ],
  });
  const client = runtime.getClient("main");
  client.sendText = async (_to: string, text: string) => {
    sent.push(text);
    return "client-id";
  };

  await runtime.handleWeixinMessage("main", {
    message_id: 200,
    from_user_id: "user-1",
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
  });

  assert.deepEqual(sent, ["async reminder"]);
});

test("runtime dispatches proactive main-assistant actions through its action queue", async () => {
  const sent: Array<{ to: string; text: string; contextToken?: string }> = [];
  const runtime = new WeChatRuntime({
    profiles: [{
      id: "main",
      credentials: { accountId: "abc@im.bot", token: "token" },
    }],
  });
  runtime.getClient("main").sendText = async (to, text, contextToken) => {
    sent.push({ to, text, contextToken });
    return "client-id";
  };
  const action = createMainAssistantSessionReminderAction({
    conversationId: "owner-1",
    contextToken: "ctx-owner",
    remainingMs: 23 * 60 * 60_000,
    expiresAt: new Date(2026, 6, 16, 12, 30).getTime(),
    scheduledAt: 1_000,
  });

  const results = await runtime.dispatchActions("main", [action]);

  assert.equal(results[0].ok, true);
  assert.equal(sent[0].to, "owner-1");
  assert.equal(sent[0].contextToken, "ctx-owner");
  assert.match(sent[0].text, /^```WeConnect-Session/);
  assert.match(sent[0].text, /Session 剩余时间：约 23 小时/);
  assert.equal(action.metadata?.source, "main-assistant");
  assert.equal(action.metadata?.routeId, "main-assistant-default");
});

test("runtime action queue retries failures and can dedupe successful actions", async () => {
  let attempts = 0;
  const client = {
    async sendText() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary");
      return "client-id";
    },
  } as unknown as WeChatClient;
  const queue = new RuntimeActionQueue({
    maxAttempts: 2,
    retryDelayMs: 0,
    dedupeWindowMs: 30_000,
  });
  const action: RuntimeAction = {
    type: "send_text",
    conversationId: "user-1",
    text: "hi",
  };

  const first = await queue.executeBatch({ client, actions: [action] });
  const second = await queue.executeBatch({ client, actions: [action] });

  assert.equal(first[0].ok, true);
  assert.equal(first[0].attempts, 2);
  assert.equal(second[0].deduped, true);
  assert.equal(attempts, 2);
});

test("stores and retrieves scoped memory", async () => {
  const memory = new InMemoryMemoryStore();
  const scope = { profileId: "p", connectorId: "c", conversationId: "u" };
  await memory.appendMessage({
    id: "1",
    scope,
    role: "user",
    content: "hello",
    createdAt: 1,
  });
  await memory.appendMessage({
    id: "2",
    scope,
    role: "assistant",
    content: "hi",
    createdAt: 2,
  });

  const recent = await memory.getRecentMessages(scope, 1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].content, "hi");
});

test("local JSONL agent memory appends and searches turns", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-memory-"));
  const memory = createLocalJsonlAgentMemoryProvider({ baseDir });
  const scope = {
    profileId: "main",
    routeId: "main-assistant-default",
    connectorId: "main-assistant",
    conversationId: "user-1",
    senderId: "user-1",
  };

  await memory.appendTurn({
    scope,
    input: { role: "user", content: "我喜欢拿铁" },
    output: { role: "assistant", content: "记住了，你喜欢拿铁。" },
  });

  const hits = await memory.search({ scope, query: "拿铁", limit: 3 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /拿铁/);
  const memoryFile = path.join(baseDir, "main", "turns.jsonl");
  assert.equal((await fs.stat(memoryFile)).mode & 0o077, 0);
});

test("local JSONL agent memory keeps unsafe profile ids inside its base dir", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-memory-safe-profile-"));
  const memory = createLocalJsonlAgentMemoryProvider({ baseDir });
  const scope = {
    profileId: "../../outside/profile",
    routeId: "main-assistant-default",
    connectorId: "main-assistant",
    conversationId: "user-1",
    senderId: "user-1",
  };

  await memory.appendTurn({
    scope,
    input: { role: "user", content: "local only" },
  });

  const entries = await fs.readdir(baseDir, { recursive: true });
  const memoryFile = entries.find((entry) => entry.endsWith("turns.jsonl"));
  assert.notEqual(memoryFile, undefined);
  const resolved = path.resolve(baseDir, memoryFile ?? "");
  assert.equal(path.relative(baseDir, resolved).startsWith(".."), false);
});

test("Mem0 agent memory maps scope to REST add and search requests", async () => {
  const requests: Array<{
    url: string;
    method?: string;
    headers: Record<string, string>;
    body?: unknown;
  }> = [];
  const fetchImpl = (async (input, init = {}) => {
    const headers = init.headers as Record<string, string>;
    requests.push({
      url: String(input),
      method: init.method,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    });

    const url = String(input);
    if (url.endsWith("/v1/ping/")) {
      return new Response(JSON.stringify({
        status: "ok",
        user_email: "tester@mem0.test",
      }));
    }
    if (url.endsWith("/v3/memories/add/")) {
      return new Response(JSON.stringify([{ id: "added" }]));
    }
    if (url.endsWith("/v3/memories/search/")) {
      return new Response(JSON.stringify({
        results: [{ id: "m1", memory: "用户喜欢拿铁", score: 0.9 }],
      }));
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  }) satisfies typeof fetch;
  const memory = createMem0AgentMemoryProvider({
    apiKey: "test-key",
    baseUrl: "https://mem0.test",
    fetch: fetchImpl,
  });
  const scope = {
    profileId: "main",
    routeId: "main-assistant-default",
    connectorId: "main-assistant",
    conversationId: "user-1",
    senderId: "user-1",
  };

  await memory.appendTurn({
    scope,
    input: { role: "user", content: "hello" },
    output: { role: "assistant", content: "hi" },
  });
  const hits = await memory.search({ scope, query: "拿铁", limit: 2 });

  assert.equal(requests[0].url, "https://mem0.test/v1/ping/");
  assert.equal(requests[0].headers.Authorization, "Token test-key");
  assert.equal(requests[1].url, "https://mem0.test/v3/memories/add/");
  assert.equal(requests[1].headers.Authorization, "Token test-key");
  assert.equal(requests[1].headers["Mem0-User-ID"], "tester@mem0.test");
  assert.deepEqual(requests[1].body, {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    user_id: "main:user-1",
    agent_id: "main-assistant-default",
    run_id: "user-1",
    metadata: {
      profileId: "main",
      routeId: "main-assistant-default",
      connectorId: "main-assistant",
      conversationId: "user-1",
      senderId: "user-1",
    },
  });
  assert.equal(requests[2].url, "https://mem0.test/v3/memories/search/");
  assert.equal(requests[2].headers["Mem0-User-ID"], "tester@mem0.test");
  assert.deepEqual(requests[2].body, {
    query: "拿铁",
    output_format: "v1.1",
    filters: {
      user_id: "main:user-1",
      agent_id: "main-assistant-default",
      run_id: "user-1",
    },
    top_k: 2,
  });
  assert.deepEqual((requests[2].body as { filters: Record<string, string> }).filters, {
    user_id: "main:user-1",
    agent_id: "main-assistant-default",
    run_id: "user-1",
  });
  assert.deepEqual(hits, [{
    id: "m1",
    content: "用户喜欢拿铁",
    score: 0.9,
    metadata: undefined,
  }]);
});

test("main assistant sends general chat to the LLM provider", async () => {
  const sent: string[] = [];
  const llm = createMockLLMProvider({
    response(messages) {
      return `LLM: ${messages.at(-1)?.content ?? ""}`;
    },
  });
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "main",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    connectors: [
      createMainAssistantConnector({ id: "main-assistant", llm }),
    ],
    routes: [
      {
        id: "main-assistant-default",
        profileId: "main",
        connectorId: "main-assistant",
        terminal: true,
      },
    ],
  });

  const client = runtime.getClient("main");
  client.sendText = async (_to: string, text: string) => {
    sent.push(text);
    return "client-id";
  };

  await runtime.handleWeixinMessage("main", {
    message_id: 2,
    from_user_id: "user-1",
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "你好" } }],
  });

  assert.deepEqual(sent, ["LLM: 你好"]);
});

test("main assistant lists visible built-in and user-created routes", async () => {
  const sent: string[] = [];
  const llm = createMockLLMProvider({ response: () => "unused" });
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "main",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    connectors: [
      createMainAssistantConnector({ id: "main-assistant", llm }),
    ],
    routes: [
      {
        id: "workspace",
        profileId: "main",
        connectorId: "workspace-connector",
        priority: 900,
        terminal: true,
        match: { kind: "text", textCommands: [] },
        metadata: {
          assistantName: "workspace",
          builtIn: true,
          systemPrompt: "Workspace route",
        },
      },
      {
        id: "assistant-route-main-sales",
        profileId: "main",
        connectorId: "route-assistant",
        priority: 80,
        terminal: true,
        match: { textIncludes: ["报价"] },
        metadata: {
          createdBy: "main-assistant",
          assistantName: "sales",
          systemPrompt: "销售助手",
        },
      },
      {
        id: "main-assistant-default",
        profileId: "main",
        connectorId: "main-assistant",
        priority: -100,
        terminal: true,
      },
    ],
  });

  const client = runtime.getClient("main");
  client.sendText = async (_to: string, text: string) => {
    sent.push(text);
    return "client-id";
  };

  await runtime.handleWeixinMessage("main", {
    message_id: 22,
    from_user_id: "user-1",
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "现在有哪些 route" } }],
  });

  assert.match(sent[0], /大助手/);
  assert.match(sent[0], /workspace/);
  assert.match(sent[0], /sales/);
  assert.doesNotMatch(sent[0], /\/workspace/);
  assert.doesNotMatch(sent[0], /main-assistant-commands/);
});

test("main assistant uses and appends agent memory", async () => {
  const sent: string[] = [];
  const appended: AgentMemoryAppendTurnParams[] = [];
  let systemPrompt = "";
  const agentMemory: AgentMemoryProvider = {
    id: "test-agent-memory",
    async appendTurn(params) {
      appended.push(params);
    },
    async search() {
      return [{ id: "mem-1", content: "用户喜欢拿铁", score: 1 }];
    },
  };
  const llm = createMockLLMProvider({
    response(messages) {
      systemPrompt = messages[0]?.content ?? "";
      return "当然，还记得你喜欢拿铁。";
    },
  });
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "main",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    connectors: [
      createMainAssistantConnector({
        id: "main-assistant",
        llm,
        agentMemory,
      }),
    ],
    routes: [
      {
        id: "main-assistant-default",
        profileId: "main",
        connectorId: "main-assistant",
        terminal: true,
      },
    ],
  });

  const client = runtime.getClient("main");
  client.sendText = async (_to: string, text: string) => {
    sent.push(text);
    return "client-id";
  };

  await runtime.handleWeixinMessage("main", {
    message_id: 6,
    from_user_id: "user-1",
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "我喜欢什么咖啡？" } }],
  });

  assert.match(systemPrompt, /长期记忆/);
  assert.match(systemPrompt, /用户喜欢拿铁/);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].scope.routeId, "main-assistant-default");
  assert.equal(appended[0].output?.content, "当然，还记得你喜欢拿铁。");
  assert.deepEqual(sent, ["当然，还记得你喜欢拿铁。"]);
});

test("main assistant replies gracefully when the LLM provider fails", async () => {
  const sent: string[] = [];
  const errors: string[] = [];
  const llm = createMockLLMProvider({
    response() {
      throw new Error("fetch failed");
    },
  });
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "main",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    connectors: [
      createMainAssistantConnector({
        id: "main-assistant",
        llm,
        onLLMError(error) {
          errors.push(error.message);
        },
      }),
    ],
    routes: [
      {
        id: "main-assistant-default",
        profileId: "main",
        connectorId: "main-assistant",
        terminal: true,
      },
    ],
  });

  const client = runtime.getClient("main");
  client.sendText = async (_to: string, text: string) => {
    sent.push(text);
    return "client-id";
  };

  await runtime.handleWeixinMessage("main", {
    message_id: 5,
    from_user_id: "user-1",
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "你好" } }],
  });

  assert.equal(errors[0], "fetch failed");
  assert.match(sent[0], /^```WeConnect-Error-Llm-Unavailable/);
  assert.match(sent[0], /连不上 LLM/);
});

test("agent connector maps agent text responses to runtime actions", async () => {
  const connector = createAgentConnector({
    id: "agent",
    agent: {
      id: "local-agent",
      async handle({ message }) {
        return { text: `agent saw ${message.text}` };
      },
    },
  });
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "text",
    text: "hello",
    attachments: [],
    raw: {},
  };

  const actions = await connector.handleMessage(message, {
    profileId: "main",
    connectorId: "agent",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: { profileId: "main", connectorId: "agent", conversationId: "user-1" },
    route: { id: "agent-route", connectorId: "agent" },
    routes: new RuntimeRouteRegistry(),
  });

  assertRuntimeActions(actions, [{
    type: "send_text",
    conversationId: "user-1",
    text: "agent saw hello",
  }]);
});

test("MCP connector calls a tool and maps text results to actions", async () => {
  let toolArgs: unknown;
  const connector = createMcpConnector({
    id: "mcp",
    toolName: "answer",
    client: {
      async callTool(_name, args) {
        toolArgs = args;
        return { text: "mcp response" };
      },
    },
  });
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "text",
    text: "hello",
    attachments: [],
    raw: {},
  };

  const actions = await connector.handleMessage(message, {
    profileId: "main",
    connectorId: "mcp",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: { profileId: "main", connectorId: "mcp", conversationId: "user-1" },
    route: { id: "mcp-route", connectorId: "mcp" },
    routes: new RuntimeRouteRegistry(),
  });

  assert.equal((toolArgs as { text?: string }).text, "hello");
  assertRuntimeActions(actions, [{
    type: "send_text",
    conversationId: "user-1",
    text: "mcp response",
  }]);
});

test("runtime media pipeline downloads and caches attachments", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-media-"));
  const pipeline = new RuntimeMediaPipeline({ cacheDir });
  const raw = {
    type: MessageItemType.FILE,
    file_item: { file_name: "report.pdf", len: "5" },
  };
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "file",
    attachments: [{
      id: "a1",
      kind: "file",
      fileName: "report.pdf",
      size: 5,
      raw,
    }],
    raw: {},
  };
  const client = {
    async downloadMedia() {
      return {
        kind: "file",
        fileName: "report.pdf",
        data: Buffer.from("hello"),
      };
    },
  } as unknown as WeChatClient;

  const media = await pipeline.downloadMessageMedia({ client, message });

  assert.equal(media.length, 1);
  assert.equal(media[0].size, 5);
  assert.equal(media[0].fileName, "report.pdf");
  assert.equal(media[0].mimeType, "application/pdf");
  assert.equal(
    await fs.readFile(media[0].filePath ?? "", "utf-8"),
    "hello",
  );
  assert.equal((await fs.stat(media[0].filePath ?? "")).mode & 0o077, 0);
});

test("runtime media pipeline keeps unsafe profile ids inside the cache dir", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-media-safe-profile-"));
  const pipeline = new RuntimeMediaPipeline({ cacheDir });
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "../outside/profile",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "file",
    attachments: [{
      id: "a1",
      kind: "file",
      fileName: "../../evil.pdf",
      size: 5,
      raw: {
        type: MessageItemType.FILE,
        file_item: { file_name: "../../evil.pdf", len: "5" },
      },
    }],
    raw: {},
  };
  const client = {
    async downloadMedia() {
      return {
        kind: "file",
        fileName: "../../evil.pdf",
        data: Buffer.from("hello"),
      };
    },
  } as unknown as WeChatClient;

  const [media] = await pipeline.downloadMessageMedia({ client, message });
  const relative = path.relative(cacheDir, media.filePath ?? "");

  assert.equal(relative.startsWith(".."), false);
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(await fs.readFile(media.filePath ?? "", "utf-8"), "hello");

  const stats = await pipeline.getCacheStats("../outside/profile");
  assert.equal(stats.fileCount, 1);
  assert.equal(path.relative(cacheDir, stats.cacheDir ?? "").startsWith(".."), false);
});

test("runtime media pipeline infers names and mime types for unnamed voice media", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-media-voice-"));
  const pipeline = new RuntimeMediaPipeline({ cacheDir });
  const raw = {
    type: MessageItemType.VOICE,
    voice_item: { playtime: 1200 },
  };
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "voice",
    attachments: [{
      id: "voice-1",
      kind: "voice",
      raw,
    }],
    raw: {},
  };
  const client = {
    async downloadMedia() {
      return {
        kind: "voice",
        data: Buffer.from("voice"),
      };
    },
  } as unknown as WeChatClient;

  const media = await pipeline.downloadMessageMedia({ client, message });

  assert.equal(media.length, 1);
  assert.match(media[0].fileName ?? "", /\.silk$/);
  assert.equal(media[0].mimeType, "audio/silk");
  assert.equal(await fs.readFile(media[0].filePath ?? "", "utf-8"), "voice");
});

test("runtime media pipeline avoids cache collisions for same-name files", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-media-collision-"));
  const pipeline = new RuntimeMediaPipeline({ cacheDir });
  const raw = {
    type: MessageItemType.FILE,
    file_item: { file_name: "report.pdf", len: "5" },
  };
  const baseMessage: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "file",
    attachments: [{
      id: "a1",
      kind: "file",
      fileName: "report.pdf",
      size: 5,
      raw,
    }],
    raw: {},
  };
  let count = 0;
  const client = {
    async downloadMedia() {
      count += 1;
      return {
        kind: "file",
        fileName: "report.pdf",
        data: Buffer.from(`hello-${count}`),
      };
    },
  } as unknown as WeChatClient;

  const first = await pipeline.downloadMessageMedia({ client, message: baseMessage });
  const second = await pipeline.downloadMessageMedia({
    client,
    message: {
      ...baseMessage,
      id: "m2",
    },
  });

  assert.notEqual(first[0].filePath, second[0].filePath);
  assert.equal(await fs.readFile(first[0].filePath ?? "", "utf-8"), "hello-1");
  assert.equal(await fs.readFile(second[0].filePath ?? "", "utf-8"), "hello-2");
});

test("runtime media pipeline avoids same-message collisions for equal-size attachments", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-media-same-message-"));
  const pipeline = new RuntimeMediaPipeline({ cacheDir, downloadConcurrency: 2 });
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "file",
    attachments: ["a", "b"].map((marker) => ({
      kind: "file" as const,
      fileName: "report.pdf",
      size: 5,
      raw: {
        msg_id: marker,
        type: MessageItemType.FILE,
        file_item: { file_name: "report.pdf", len: "5" },
      },
    })),
    raw: {},
  };
  const client = {
    async downloadMedia(item: { msg_id?: string }) {
      return {
        kind: "file",
        fileName: "report.pdf",
        data: Buffer.from(item.msg_id === "a" ? "aaaaa" : "bbbbb"),
      };
    },
  } as unknown as WeChatClient;

  const media = await pipeline.downloadMessageMedia({ client, message });

  assert.equal(media.length, 2);
  assert.notEqual(media[0].filePath, media[1].filePath);
  assert.equal(await fs.readFile(media[0].filePath ?? "", "utf-8"), "aaaaa");
  assert.equal(await fs.readFile(media[1].filePath ?? "", "utf-8"), "bbbbb");
});

test("runtime media pipeline downloads multiple attachments concurrently in source order", async () => {
  const pipeline = new RuntimeMediaPipeline({ downloadConcurrency: 2 });
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "mixed",
    attachments: ["1", "2", "3"].map((marker) => ({
      kind: "image" as const,
      raw: {
        msg_id: marker,
        type: MessageItemType.IMAGE,
        image_item: {},
      },
    })),
    raw: {},
  };
  let active = 0;
  let maxActive = 0;
  const client = {
    async downloadMedia(item: { msg_id?: string }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleepMs(item.msg_id === "1" ? 20 : 5);
      active -= 1;
      return {
        kind: "image",
        data: Buffer.from(item.msg_id ?? ""),
      };
    },
  } as unknown as WeChatClient;

  const media = await pipeline.downloadMessageMedia({ client, message });

  assert.equal(maxActive, 2);
  assert.deepEqual(media.map((item) => item.data.toString("utf-8")), ["1", "2", "3"]);
});

test("runtime media pipeline waits for all concurrent downloads before reporting failures", async () => {
  const pipeline = new RuntimeMediaPipeline({ downloadConcurrency: 2 });
  const message: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "mixed",
    attachments: ["fail", "finish"].map((marker) => ({
      kind: "file" as const,
      fileName: `${marker}.txt`,
      raw: {
        msg_id: marker,
        type: MessageItemType.FILE,
        file_item: { file_name: `${marker}.txt` },
      },
    })),
    raw: {},
  };
  let secondFinished = false;
  const client = {
    async downloadMedia(item: { msg_id?: string }) {
      if (item.msg_id === "fail") throw new Error("temporary CDN failure");
      await sleepMs(20);
      secondFinished = true;
      return { kind: "file", data: Buffer.from("done") };
    },
  } as unknown as WeChatClient;

  await assert.rejects(
    () => pipeline.downloadMessageMedia({ client, message }),
    /Failed to download 1 of 2 attachment\(s\): #1: temporary CDN failure/,
  );
  assert.equal(secondFinished, true);
});

test("runtime media pipeline prunes expired cache files", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-media-ttl-"));
  const profileDir = path.join(cacheDir, "main");
  await fs.mkdir(profileDir, { recursive: true });
  const oldFile = path.join(profileDir, "old.bin");
  const freshFile = path.join(profileDir, "fresh.bin");
  await fs.writeFile(oldFile, "old");
  await fs.writeFile(freshFile, "fresh");
  const oldDate = new Date(Date.now() - 60_000);
  await fs.utimes(oldFile, oldDate, oldDate);

  const pipeline = new RuntimeMediaPipeline({
    cacheDir,
    cacheTtlMs: 1_000,
  });
  await pipeline.pruneCache();

  await assert.rejects(() => fs.stat(oldFile));
  assert.equal(await fs.readFile(freshFile, "utf-8"), "fresh");
});

test("runtime media pipeline prunes oldest files over cache size limit", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-media-size-"));
  const profileDir = path.join(cacheDir, "main");
  await fs.mkdir(profileDir, { recursive: true });
  const oldFile = path.join(profileDir, "old.bin");
  const freshFile = path.join(profileDir, "fresh.bin");
  await fs.writeFile(oldFile, "12345");
  await fs.writeFile(freshFile, "abcde");
  const oldDate = new Date(Date.now() - 60_000);
  await fs.utimes(oldFile, oldDate, oldDate);

  const pipeline = new RuntimeMediaPipeline({
    cacheDir,
    cacheTtlMs: 0,
    maxCacheBytes: 5,
  });
  await pipeline.pruneCache();

  await assert.rejects(() => fs.stat(oldFile));
  assert.equal(await fs.readFile(freshFile, "utf-8"), "abcde");
});

test("runtime media pipeline reports and clears cache by profile", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-media-clear-"));
  const mainDir = path.join(cacheDir, "main");
  const otherDir = path.join(cacheDir, "other");
  await fs.mkdir(mainDir, { recursive: true });
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(path.join(mainDir, "one.bin"), "123");
  await fs.writeFile(path.join(mainDir, "two.bin"), "45");
  await fs.writeFile(path.join(otherDir, "keep.bin"), "keep");
  const pipeline = new RuntimeMediaPipeline({ cacheDir });

  const before = await pipeline.getCacheStats("main");
  assert.equal(before.fileCount, 2);
  assert.equal(before.totalBytes, 5);

  const cleared = await pipeline.clearCache("main");
  assert.equal(cleared.fileCount, 2);
  assert.equal(cleared.totalBytes, 5);

  const after = await pipeline.getCacheStats("main");
  assert.equal(after.fileCount, 0);
  assert.equal(after.totalBytes, 0);
  assert.equal(await fs.readFile(path.join(otherDir, "keep.bin"), "utf-8"), "keep");
});

test("dummy TTS provider writes a local test artifact", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-tts-"));
  const tts = createDummyTTSProvider({ outputDir, playtimeMsPerChar: 10 });
  const artifact = await tts.synthesize({
    text: "hello",
    conversationId: "user-1",
  });

  assert.equal(artifact.providerId, "dummy-tts");
  assert.equal(artifact.isDummy, true);
  assert.equal(artifact.playtimeMs, 500);
  assert.match(await fs.readFile(artifact.filePath, "utf-8"), /hello/);
});

test("main assistant renames current route and cd enters a route session", async () => {
  const sent: string[] = [];
  const llm = createMockLLMProvider({ response: () => "llm response" });
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "main",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    connectors: [
      createMainAssistantConnector({
        id: "main-assistant",
        llm,
      }),
      createLocalConnector({
        id: "workspace-connector",
        handleMessage(message, context) {
          if (message.text === "/cd ..") {
            context.routes.clearConversationRoute(message.profileId, message.conversationId);
            return [{
              type: "send_text",
              conversationId: message.conversationId,
              text: "已退回大助手。你现在可以继续普通聊天，或发送 /ls 查看 routes。",
            }];
          }
          if (message.text?.startsWith("/")) {
            return [{ type: "noop", reason: `unknown workspace command: ${message.text}` }];
          }
          return [{
            type: "send_text",
            conversationId: message.conversationId,
            text: `workspace saw ${message.text}`,
          }];
        },
      }),
    ],
    routes: [
      {
        id: "workspace",
        profileId: "main",
        connectorId: "workspace-connector",
        priority: 900,
        terminal: true,
        match: { kind: "text", textCommands: [] },
        metadata: {
          assistantName: "workspace",
          builtIn: true,
          systemPrompt: "Workspace route",
        },
      },
      {
        id: "main-assistant-default",
        profileId: "main",
        connectorId: "main-assistant",
        priority: -100,
        terminal: true,
      },
    ],
  });

  const client = runtime.getClient("main");
  client.sendText = async (_to: string, text: string) => {
    sent.push(text);
    return "client-id";
  };

  await runtime.handleWeixinMessage("main", {
    message_id: 3,
    from_user_id: "user-1",
    context_token: "ctx-1",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/rename 总控台" } }],
  });

  assert.match(sent[0], /^```WeConnect-Route-Renamed/);
  assert.match(sent[0], /- 已重命名为: 总控台/);
  assert.equal(
    runtime.listRoutes().find((route) => route.id === "main-assistant-default")
      ?.metadata?.assistantName,
    "总控台",
  );

  await runtime.handleWeixinMessage("main", {
    message_id: 4,
    from_user_id: "user-1",
    context_token: "ctx-2",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/workspace status" } }],
  });

  assert.equal(sent.length, 1);
  assert.equal(runtime.getConversationRoute("main", "user-1"), undefined);

  await runtime.handleWeixinMessage("main", {
    message_id: 5,
    from_user_id: "user-1",
    context_token: "ctx-3",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/cd workspace" } }],
  });

  assert.match(sent[1], /^```WeConnect-Route-Entered/);
  assert.match(sent[1], /- 已进入 route: workspace/);
  assert.match(sent[1], /当前对话会停留在这个 route 内/);
  assert.equal(runtime.getConversationRoute("main", "user-1"), "workspace");

  await runtime.handleWeixinMessage("main", {
    message_id: 6,
    from_user_id: "user-1",
    context_token: "ctx-4",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
  });

  assert.equal(sent[2], "workspace saw hello");

  await runtime.handleWeixinMessage("main", {
    message_id: 7,
    from_user_id: "user-1",
    context_token: "ctx-5",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/ls" } }],
  });

  assert.equal(sent.length, 3);

  await runtime.handleWeixinMessage("main", {
    message_id: 8,
    from_user_id: "user-1",
    context_token: "ctx-6",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/cd .." } }],
  });

  assert.match(sent[3], /已退回大助手/);
  assert.equal(runtime.getConversationRoute("main", "user-1"), undefined);

  await runtime.handleWeixinMessage("main", {
    message_id: 9,
    from_user_id: "user-1",
    context_token: "ctx-7",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello again" } }],
  });

  assert.equal(sent[4], "llm response");

  await runtime.handleWeixinMessage("main", {
    message_id: 10,
    from_user_id: "user-1",
    context_token: "ctx-8",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/route create sales | 报价 | 你是销售助手。" } }],
  });

  assert.equal(sent.length, 5);
});

test("WeChatRuntime skips duplicate inbound messages through a persistent deduper", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-dedupe-"));
  const store = new FileRuntimeStateStore({ baseDir });
  const sent: string[] = [];
  const skipped: string[] = [];
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "sales",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    deduper: createStateStoreMessageDeduper(store),
    connectors: [
      createLocalConnector({
        id: "echo",
        handleMessage: async (message) => [
          {
            type: "send_text",
            conversationId: message.conversationId,
            text: `Echo: ${message.text ?? ""}`,
          },
        ],
      }),
    ],
    routes: [
      { id: "echo-text", profileId: "sales", connectorId: "echo", match: { kind: "text" } },
    ],
  });

  runtime.on("messageSkipped", (_message, reason) => skipped.push(reason));
  const client = runtime.getClient("sales");
  client.sendText = async (_to: string, text: string) => {
    sent.push(text);
    return "client-id";
  };
  const msg = {
    message_id: 99,
    from_user_id: "user-1",
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
  };

  await runtime.handleWeixinMessage("sales", msg);
  await runtime.handleWeixinMessage("sales", msg);

  assert.deepEqual(sent, ["Echo: hello"]);
  assert.deepEqual(skipped, ["duplicate"]);
});

test("WeChatRuntime skips repeated text deliveries with different protocol ids", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-fingerprint-dedupe-"));
  const store = new FileRuntimeStateStore({ baseDir });
  const sent: string[] = [];
  const skipped: string[] = [];
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "sales",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    deduper: createStateStoreMessageDeduper(store),
    connectors: [
      createLocalConnector({
        id: "echo",
        handleMessage: async (message) => [
          {
            type: "send_text",
            conversationId: message.conversationId,
            text: `Echo: ${message.text ?? ""}`,
          },
        ],
      }),
    ],
    routes: [
      { id: "echo-text", profileId: "sales", connectorId: "echo", match: { kind: "text" } },
    ],
  });

  runtime.on("messageSkipped", (_message, reason) => skipped.push(reason));
  const client = runtime.getClient("sales");
  client.sendText = async (_to: string, text: string) => {
    sent.push(text);
    return "client-id";
  };

  await Promise.all([
    runtime.handleWeixinMessage("sales", {
      message_id: 1001,
      from_user_id: "user-1",
      context_token: "ctx-1",
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "same text" } }],
    }),
    runtime.handleWeixinMessage("sales", {
      message_id: 1002,
      from_user_id: "user-1",
      context_token: "ctx-2",
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "same text" } }],
    }),
  ]);

  assert.deepEqual(sent, ["Echo: same text"]);
  assert.deepEqual(skipped, ["duplicate"]);
});

test("WeChatRuntime handles message -> connector -> action -> memory", async () => {
  const sent: RuntimeAction[] = [];
  let sentContextToken: string | undefined;
  const runtime = new WeChatRuntime({
    profiles: [
      {
        id: "sales",
        credentials: {
          accountId: "abc@im.bot",
          token: "token",
        },
      },
    ],
    connectors: [
      createLocalConnector({
        id: "echo",
        handleMessage: async (message) => [
          {
            type: "send_text",
            conversationId: message.conversationId,
            text: `Echo: ${message.text ?? ""}`,
          },
        ],
      }),
    ],
    routes: [
      { id: "echo-text", profileId: "sales", connectorId: "echo", match: { kind: "text" } },
    ],
  });

  const client = runtime.getClient("sales");
  client.sendText = async (_to: string, text: string, contextToken?: string) => {
    sentContextToken = contextToken;
    sent.push({ type: "send_text", conversationId: "user-1", text });
    return "client-id";
  };

  await runtime.handleWeixinMessage("sales", {
    message_id: 1,
    from_user_id: "user-1",
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
  });

  assert.deepEqual(sent, [
    { type: "send_text", conversationId: "user-1", text: "Echo: hello" },
  ]);
  assert.equal(sentContextToken, "ctx");
  const memory = await runtime.memory.getRecentMessages(
    { profileId: "sales", connectorId: "echo", conversationId: "user-1" },
    10,
  );
  assert.deepEqual(memory.map((m) => [m.role, m.content]), [
    ["user", "hello"],
    ["assistant", "Echo: hello"],
  ]);
});
