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

test("Upochi route is blank for ordinary messages", async () => {
  const routes = new RuntimeRouteRegistry({
    routes: [createUpochiRouteDefinition("default")],
  });
  const actions = await createUpochiConnector().handleMessage(
    message("hello"),
    context(routes),
  );

  assert.deepEqual(actions, [{
    type: "noop",
    reason: "Upochi route is intentionally blank.",
  }]);
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
