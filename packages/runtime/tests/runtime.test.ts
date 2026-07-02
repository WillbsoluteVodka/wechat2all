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
  createAgentConnector,
  createCodexConnector,
  createFileCodexBridgeClient,
  createDummyTTSProvider,
  createMcpConnector,
  createStateStoreMessageDeduper,
  FileRuntimeStateStore,
  createLocalJsonlAgentMemoryProvider,
  createLocalConnector,
  createMainAssistantConnector,
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
      id: "codex",
      connectorId: "codex-bridge",
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
    findMatchingRoutes(routes, { ...baseMessage, text: "/codex status" }).map((route) => route.id),
    ["fallback"],
  );
  assert.deepEqual(
    findMatchingRoutes(routes, { ...baseMessage, text: "是不是多了一个 codexroute" }).map((route) => route.id),
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
        id: "codex",
        profileId: "main",
        connectorId: "codex-bridge",
        priority: 900,
        terminal: true,
        match: { kind: "text", textCommands: [] },
        metadata: {
          assistantName: "codex",
          builtIn: true,
          systemPrompt: "Codex bridge",
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
  assert.match(sent[0], /codex/);
  assert.match(sent[0], /sales/);
  assert.doesNotMatch(sent[0], /\/codex/);
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

  assert.deepEqual(actions, [{
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
  assert.deepEqual(actions, [{
    type: "send_text",
    conversationId: "user-1",
    text: "mcp response",
  }]);
});

test("codex connector reports status and remembers the WeChat target", async () => {
  let target: unknown;
  const connector = createCodexConnector({
    id: "codex-bridge",
    client: {
      async getStatus() {
        return {
          state: "working",
          summary: "running tests",
          currentThreadId: "thread-1",
          currentProject: "wechat2all",
          updatedAt: 42,
        };
      },
      async setDefaultTarget(nextTarget) {
        target = nextTarget;
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
    text: "status",
    attachments: [],
    replyToken: {
      userId: "user-1",
      contextToken: "ctx",
    },
    raw: {},
  };

  const actions = await connector.handleMessage(message, {
    profileId: "main",
    connectorId: "codex-bridge",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: { profileId: "main", connectorId: "codex-bridge", conversationId: "user-1" },
    route: { id: "codex", connectorId: "codex-bridge" },
    routes: new RuntimeRouteRegistry(),
  });

  assert.match((actions[0] as { text: string }).text, /正在工作/);
  assert.deepEqual(target, {
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    contextToken: "ctx",
    updatedAt: (target as { updatedAt: number }).updatedAt,
  });
});

test("codex connector returns token usage for /token", async () => {
  const connector = createCodexConnector({
    id: "codex-bridge",
    client: {
      async getStatus() {
        return { state: "idle" };
      },
    },
    async tokenUsageReader() {
      return {
        windows: [
          {
            label: "5h",
            remainingText: "97%",
            resetText: "11:35 PM",
            usedPercent: 3,
            remainingPercent: 97,
            windowDurationMins: 300,
            resetsAt: "2026-07-01T15:35:07.000Z",
          },
          {
            label: "Weekly",
            remainingText: "93%",
            resetText: "Jul 7",
            usedPercent: 7,
            remainingPercent: 93,
            windowDurationMins: 10080,
            resetsAt: "2026-07-07T14:31:47.000Z",
          },
        ],
        resetCreditsText: "1 reset available",
      };
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
    text: "/token",
    attachments: [],
    raw: {},
  };

  const actions = await connector.handleMessage(message, {
    profileId: "main",
    connectorId: "codex-bridge",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: { profileId: "main", connectorId: "codex-bridge", conversationId: "user-1" },
    route: { id: "codex", connectorId: "codex-bridge" },
    routes: new RuntimeRouteRegistry(),
  });

  assert.deepEqual(actions, [{
    type: "send_text",
    conversationId: "user-1",
    text: [
      "- 5h: 97% 11:35 PM",
      "- Weekly: 93% Jul 7",
      "- 1 reset available",
    ].join("\n"),
  }]);
});

test("codex connector lists bindable chats with /ls", async () => {
  const connector = createCodexConnector({
    id: "codex-bridge",
    client: {
      async getStatus() {
        return { state: "idle" };
      },
      async listChats() {
        return [{
          id: "thread-1",
          title: "Build bridge",
          project: "wechat2all",
          status: "idle",
        }];
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
    text: "/ls",
    attachments: [],
    raw: {},
  };

  const actions = await connector.handleMessage(message, {
    profileId: "main",
    connectorId: "codex-bridge",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: { profileId: "main", connectorId: "codex-bridge", conversationId: "user-1" },
    route: { id: "codex", connectorId: "codex-bridge" },
    routes: new RuntimeRouteRegistry(),
  });

  assert.match((actions[0] as { text: string }).text, /Codex chats/);
  assert.match((actions[0] as { text: string }).text, /thread-1/);
  assert.match((actions[0] as { text: string }).text, /\/bind <id>/);
});

test("codex connector binds a GUI thread and sends ordinary text to it", async () => {
  let binding: {
    threadId: string;
    title?: string;
    project?: string;
    boundAt?: number;
  } | null = null;
  let sentPrompt: unknown;
  const connector = createCodexConnector({
    id: "codex-bridge",
    client: {
      async getStatus() {
        return { state: "idle" };
      },
      async bindThread(threadId) {
        binding = {
          threadId,
          title: "Bridge chat",
          project: "wechat2all",
          boundAt: 42,
        };
        return binding;
      },
      async getCurrentBinding() {
        return binding;
      },
      async sendPrompt(prompt) {
        sentPrompt = prompt;
        return {
          id: prompt.id,
          threadId: binding?.threadId,
          turnId: "turn-1",
        };
      },
    },
  });
  const baseMessage: RuntimeMessage = {
    id: "m1",
    platform: "wechat-ilink",
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: 1,
    kind: "text",
    text: "/bind thread-1",
    attachments: [],
    raw: {},
  };
  const context = {
    profileId: "main",
    connectorId: "codex-bridge",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: { profileId: "main", connectorId: "codex-bridge", conversationId: "user-1" },
    route: { id: "codex", connectorId: "codex-bridge" },
    routes: new RuntimeRouteRegistry(),
  };

  const bindActions = await connector.handleMessage(baseMessage, context);
  assert.match((bindActions[0] as { text: string }).text, /Thread ID：thread-1/);

  const sendActions = await connector.handleMessage({
    ...baseMessage,
    id: "m2",
    text: "continue please",
  }, context);

  assert.deepEqual((sentPrompt as { text: string }).text, "continue please");
  assert.match((sendActions[0] as { text: string }).text, /已发送到 Codex GUI chat/);
  assert.match((sendActions[0] as { text: string }).text, /Turn ID: turn-1/);
});

test("codex connector asks for a GUI binding before sending ordinary text", async () => {
  const connector = createCodexConnector({
    id: "codex-bridge",
    client: {
      async getStatus() {
        return { state: "idle" };
      },
      async getCurrentBinding() {
        return null;
      },
      async sendPrompt() {
        throw new Error("should not send without binding");
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
    text: "continue please",
    attachments: [],
    raw: {},
  };

  const actions = await connector.handleMessage(message, {
    profileId: "main",
    connectorId: "codex-bridge",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: { profileId: "main", connectorId: "codex-bridge", conversationId: "user-1" },
    route: { id: "codex", connectorId: "codex-bridge" },
    routes: new RuntimeRouteRegistry(),
  });

  assert.match((actions[0] as { text: string }).text, /\/bind <threadId>/);
});

test("codex connector ignores unknown slash commands inside its route", async () => {
  const connector = createCodexConnector({
    id: "codex-bridge",
    client: {
      async getStatus() {
        return { state: "idle" };
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
    text: "/unknown",
    attachments: [],
    raw: {},
  };

  const actions = await connector.handleMessage(message, {
    profileId: "main",
    connectorId: "codex-bridge",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: { profileId: "main", connectorId: "codex-bridge", conversationId: "user-1" },
    route: { id: "codex", connectorId: "codex-bridge" },
    routes: new RuntimeRouteRegistry(),
  });

  assert.deepEqual(actions, [{
    type: "noop",
    reason: "unknown codex route command: /unknown",
  }]);
});

test("file codex bridge stores inbox prompts and marks outbox delivery", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-"));
  const client = createFileCodexBridgeClient({ baseDir });

  await client.sendPrompt?.({
    id: "prompt-1",
    createdAt: 1,
    profileId: "main",
    conversationId: "user-1",
    senderId: "user-1",
    text: "continue the task",
    sourceMessageId: "m1",
  });

  const inbox = await fs.readFile(path.join(baseDir, "inbox.jsonl"), "utf-8");
  assert.match(inbox, /continue the task/);

  await fs.writeFile(
    path.join(baseDir, "outbox.jsonl"),
    `${JSON.stringify({ id: "out-1", createdAt: 2, text: "done" })}\n`,
    "utf-8",
  );
  assert.equal((await client.pullOutbox?.())?.length, 1);

  await client.markOutboxDelivered?.("out-1");
  assert.equal((await client.pullOutbox?.())?.length, 0);
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
  assert.equal(
    await fs.readFile(media[0].filePath ?? "", "utf-8"),
    "hello",
  );
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
        id: "codex-bridge",
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
            return [{ type: "noop", reason: `unknown codex command: ${message.text}` }];
          }
          return [{
            type: "send_text",
            conversationId: message.conversationId,
            text: `codex saw ${message.text}`,
          }];
        },
      }),
    ],
    routes: [
      {
        id: "codex",
        profileId: "main",
        connectorId: "codex-bridge",
        priority: 900,
        terminal: true,
        match: { kind: "text", textCommands: [] },
        metadata: {
          assistantName: "codex",
          builtIn: true,
          systemPrompt: "Codex bridge",
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

  assert.match(sent[0], /已将当前 route 改名为：总控台/);
  assert.equal(
    runtime.listRoutes().find((route) => route.id === "main-assistant-default")
      ?.metadata?.assistantName,
    "总控台",
  );

  await runtime.handleWeixinMessage("main", {
    message_id: 4,
    from_user_id: "user-1",
    context_token: "ctx-2",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/codex status" } }],
  });

  assert.equal(sent.length, 1);
  assert.equal(runtime.getConversationRoute("main", "user-1"), undefined);

  await runtime.handleWeixinMessage("main", {
    message_id: 5,
    from_user_id: "user-1",
    context_token: "ctx-3",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/cd codex" } }],
  });

  assert.match(sent[1], /已进入 route：codex/);
  assert.match(sent[1], /当前对话会停留在这个 route 内/);
  assert.equal(runtime.getConversationRoute("main", "user-1"), "codex");

  await runtime.handleWeixinMessage("main", {
    message_id: 6,
    from_user_id: "user-1",
    context_token: "ctx-4",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
  });

  assert.equal(sent[2], "codex saw hello");

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
