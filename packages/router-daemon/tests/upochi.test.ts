import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryMemoryStore,
  RuntimeRouteRegistry,
  type RuntimeHandlerContext,
  type RuntimeMessage,
} from "@wechat2all/runtime";
import type { WeChatClient } from "wechat2all";

import {
  createUpochiConnector,
  createUpochiRouteDefinition,
} from "../src/upochi.js";

function message(text: string): RuntimeMessage {
  return {
    id: "message-1",
    platform: "wechat-ilink",
    profileId: "default",
    conversationId: "user-1",
    senderId: "user-1",
    timestamp: Date.now(),
    kind: "text",
    text,
    attachments: [],
    raw: {},
  };
}

function context(routes: RuntimeRouteRegistry): RuntimeHandlerContext {
  return {
    profileId: "default",
    connectorId: "upochi-route",
    client: {} as WeChatClient,
    memory: new InMemoryMemoryStore(),
    memoryScope: {
      profileId: "default",
      connectorId: "upochi-route",
      conversationId: "user-1",
    },
    route: createUpochiRouteDefinition("default"),
    routes,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Upochi route ignores ordinary messages", async () => {
  const routes = new RuntimeRouteRegistry({
    routes: [createUpochiRouteDefinition("default")],
  });
  const actions = await createUpochiConnector().handleMessage(
    message("hello"),
    context(routes),
  );

  assert.deepEqual(actions, [{
    type: "noop",
    reason: "Upochi route only handles /check, /add, and /remove commands.",
  }]);
});

test("Upochi /check returns every todo with its id", async () => {
  const routes = new RuntimeRouteRegistry({
    routes: [createUpochiRouteDefinition("default")],
  });
  const requestedPaths: string[] = [];
  const connector = createUpochiConnector({
    baseUrl: "http://127.0.0.1:8765",
    fetch: (async (input) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      if (url.endsWith("/health")) {
        return jsonResponse({ status: "ok", service: "upochi-local-api" });
      }
      return jsonResponse({
        todos: [
          { id: "todo-1", title: "Buy milk", completed: false },
          { id: "todo-2", title: "Send report", completed: true },
        ],
        count: 2,
      });
    }) as typeof fetch,
  });

  const actions = await connector.handleMessage(message("/check"), context(routes));

  assert.deepEqual(requestedPaths, ["/health", "/v1/todos"]);
  assert.equal(actions[0]?.type, "send_text");
  if (actions[0]?.type !== "send_text") return;
  assert.match(actions[0].text, /Buy milk/);
  assert.match(actions[0].text, /id: todo-1/);
  assert.match(actions[0].text, /\[已完成\] Send report/);
  assert.match(actions[0].text, /id: todo-2/);
});

test("Upochi /add creates a todo through the local API", async () => {
  const routes = new RuntimeRouteRegistry({
    routes: [createUpochiRouteDefinition("default")],
  });
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const connector = createUpochiConnector({
    baseUrl: "http://127.0.0.1:8765",
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, init });
      if (path === "/health") return jsonResponse({ status: "ok" });
      return jsonResponse({
        todo: { id: "new-todo", title: "准备周报", completed: false },
      }, 201);
    }) as typeof fetch,
  });

  const actions = await connector.handleMessage(message("/add 准备周报"), context(routes));

  assert.deepEqual(requests.map((request) => request.path), ["/health", "/v1/todos"]);
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    title: "准备周报",
    source: "wechat2all-upochi-route",
  });
  assert.equal(actions[0]?.type, "send_text");
  if (actions[0]?.type !== "send_text") return;
  assert.match(actions[0].text, /已新增 Todo/);
  assert.match(actions[0].text, /id: new-todo/);
});

test("Upochi /remove deletes a todo by the id returned from /check", async () => {
  const routes = new RuntimeRouteRegistry({
    routes: [createUpochiRouteDefinition("default")],
  });
  const requests: Array<{ path: string; method?: string }> = [];
  const connector = createUpochiConnector({
    baseUrl: "http://127.0.0.1:8765",
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: init?.method });
      if (path === "/health") return jsonResponse({ status: "ok" });
      return jsonResponse({
        deleted: true,
        todo: { id: "todo-to-remove", title: "旧任务", completed: false },
      });
    }) as typeof fetch,
  });

  const actions = await connector.handleMessage(
    message("/remove [todo-to-remove]"),
    context(routes),
  );

  assert.deepEqual(requests, [
    { path: "/health", method: undefined },
    { path: "/v1/todos/todo-to-remove", method: "DELETE" },
  ]);
  assert.equal(actions[0]?.type, "send_text");
  if (actions[0]?.type !== "send_text") return;
  assert.match(actions[0].text, /已删除 Todo/);
  assert.match(actions[0].text, /id: todo-to-remove/);
});

test("Upochi commands explain when the local app is unavailable", async () => {
  const routes = new RuntimeRouteRegistry({
    routes: [createUpochiRouteDefinition("default")],
  });
  const connector = createUpochiConnector({
    baseUrl: "http://127.0.0.1:8765",
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });

  const actions = await connector.handleMessage(message("/check"), context(routes));

  assert.equal(actions[0]?.type, "send_text");
  if (actions[0]?.type !== "send_text") return;
  assert.match(actions[0].text, /Upochi 操作失败/);
  assert.match(actions[0].text, /请确认 Upochi 已启动/);
  assert.match(actions[0].text, /http:\/\/127\.0\.0\.1:8765/);
});

test("Upochi route still allows returning to the main assistant", async () => {
  const routes = new RuntimeRouteRegistry({
    routes: [createUpochiRouteDefinition("default")],
  });
  routes.setConversationRoute("default", "user-1", "upochi");

  const actions = await createUpochiConnector().handleMessage(
    message("/cd .."),
    context(routes),
  );

  assert.equal(routes.getConversationRoute("default", "user-1"), undefined);
  assert.equal(actions[0]?.type, "send_text");
});
