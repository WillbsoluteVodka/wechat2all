import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  RuntimeAction,
  RuntimeHandlerContext,
  RuntimeMessage,
} from "@wechat2all/runtime";

import { createClaudeRouteConnector } from "../src/connector.js";
import { createClaudeRouteDefinition } from "../src/route.js";
import type {
  ClaudeAgentRunRequest,
  ClaudeAgentRunner,
  ClaudeRouteConfig,
  ClaudeSessionStore,
  ClaudeStoredSession,
} from "../src/types.js";

class MemorySessionStore implements ClaudeSessionStore {
  values = new Map<string, ClaudeStoredSession>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: ClaudeStoredSession) {
    this.values.set(key, value);
  }

  async clear(key: string) {
    this.values.delete(key);
  }
}

function config(workdir?: string): ClaudeRouteConfig {
  return {
    workdir,
    promptFile: path.join(workdir ?? os.tmpdir(), ".wechat2all-claude-prompt.md"),
    language: "zh",
    sessionWindowMs: 15 * 60_000,
    maxMediaBytes: 50 * 1024 * 1024,
    maxTurns: 40,
    maxBudgetUsd: 1,
    timeoutMs: 60_000,
    apiKeyConfigured: true,
    allowCliAuth: false,
  };
}

function message(params: Partial<RuntimeMessage> = {}): RuntimeMessage {
  return {
    id: "message-1",
    platform: "wechat-ilink",
    profileId: "default",
    conversationId: "conversation",
    senderId: "sender",
    timestamp: Date.now(),
    kind: "text",
    text: "hello",
    attachments: [],
    raw: {} as RuntimeMessage["raw"],
    ...params,
  };
}

function context(params: {
  clearRoute?: () => void;
  downloadMessageMedia?: RuntimeHandlerContext["media"] extends infer _T
    ? (value: unknown) => Promise<unknown[]>
    : never;
} = {}): RuntimeHandlerContext {
  return {
    profileId: "default",
    connectorId: "claude-route",
    client: {} as RuntimeHandlerContext["client"],
    memory: {} as RuntimeHandlerContext["memory"],
    memoryScope: {
      profileId: "default",
      connectorId: "claude-route",
      conversationId: "conversation",
    },
    route: createClaudeRouteDefinition("default"),
    routes: {
      addRoute() {},
      upsertRoute() {},
      removeRoute() { return false; },
      listRoutes() { return []; },
      setConversationRoute() {},
      clearConversationRoute() {
        params.clearRoute?.();
        return true;
      },
      getConversationRoute() { return "claude"; },
    },
    media: params.downloadMessageMedia
      ? ({ downloadMessageMedia: params.downloadMessageMedia } as unknown as RuntimeHandlerContext["media"])
      : undefined,
  };
}

function sentText(actions: RuntimeAction[]): string {
  const action = actions.find((item) => item.type === "send_text");
  assert.ok(action && action.type === "send_text");
  return action.text;
}

test("Claude route definition is an isolated second-level route", () => {
  const route = createClaudeRouteDefinition("profile");
  assert.equal(route.id, "claude");
  assert.equal(route.connectorId, "claude-route");
  assert.equal(route.terminal, true);
  assert.deepEqual(route.match?.textCommands, []);
});

test("commands are local and /cd .. returns to the main router", async () => {
  let runs = 0;
  let clearedRoute = false;
  const runner: ClaudeAgentRunner = {
    async run() {
      runs += 1;
      return { outputs: [] };
    },
  };
  const connector = createClaudeRouteConnector({
    id: "claude-route",
    config: config(os.tmpdir()),
    runner,
    sessions: new MemorySessionStore(),
  });

  assert.match(sentText(await connector.handleMessage(
    message({ text: "/help" }),
    context(),
  )), /Claude - Help/);
  assert.match(sentText(await connector.handleMessage(
    message({ text: "/new" }),
    context(),
  )), /New Session/);
  assert.match(sentText(await connector.handleMessage(
    message({ text: "/cd .." }),
    context({ clearRoute: () => { clearedRoute = true; } }),
  )), /Returned/);
  assert.equal(clearedRoute, true);
  assert.equal(runs, 0);
});

test("messages resume the last fresh session and serialize concurrent runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-claude-route-"));
  const requests: ClaudeAgentRunRequest[] = [];
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const runner: ClaudeAgentRunner = {
    async run(request) {
      requests.push(request);
      if (requests.length === 1) {
        markFirstStarted?.();
        await firstBlocked;
      }
      return {
        text: `reply-${requests.length}`,
        sessionId: `session-${requests.length}`,
        costUsd: 0.01,
        turns: 2,
        outputs: [],
      };
    },
  };
  const connector = createClaudeRouteConnector({
    id: "claude-route",
    config: config(dir),
    runner,
    sessions: new MemorySessionStore(),
    now: () => 1_000,
  });

  const first = connector.handleMessage(message({ id: "one", text: "first" }), context());
  await firstStarted;
  const second = connector.handleMessage(message({ id: "two", text: "second" }), context());
  assert.equal(requests.length, 1);
  releaseFirst?.();
  const [firstActions, secondActions] = await Promise.all([first, second]);

  assert.match(sentText(firstActions), /reply-1/);
  assert.match(sentText(firstActions), /\$0\.010 · 2 turns/);
  assert.match(sentText(secondActions), /reply-2/);
  assert.equal(requests[0].resumeSessionId, undefined);
  assert.equal(requests[1].resumeSessionId, "session-1");
});

test("a zero session window starts every message fresh", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-claude-no-resume-"));
  const requests: ClaudeAgentRunRequest[] = [];
  const runner: ClaudeAgentRunner = {
    async run(request) {
      requests.push(request);
      return {
        text: "ok",
        sessionId: `session-${requests.length}`,
        outputs: [],
      };
    },
  };
  const routeConfig = config(dir);
  routeConfig.sessionWindowMs = 0;
  const connector = createClaudeRouteConnector({
    id: "claude-route",
    config: routeConfig,
    runner,
    sessions: new MemorySessionStore(),
  });

  await connector.handleMessage(message({ id: "one", text: "first" }), context());
  await connector.handleMessage(message({ id: "two", text: "second" }), context());

  assert.equal(requests.length, 2);
  assert.equal(requests[0].resumeSessionId, undefined);
  assert.equal(requests[1].resumeSessionId, undefined);
});

test("image input is copied into Wechat_Saved and output media is returned", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-claude-media-"));
  const outputPath = path.join(dir, "answer.png");
  await fs.writeFile(outputPath, "generated");
  let request: ClaudeAgentRunRequest | undefined;
  const runner: ClaudeAgentRunner = {
    async run(value) {
      request = value;
      return {
        text: "看到了",
        sessionId: "image-session",
        outputs: [{ kind: "image", filePath: outputPath }],
      };
    },
  };
  const connector = createClaudeRouteConnector({
    id: "claude-route",
    config: config(dir),
    runner,
    sessions: new MemorySessionStore(),
  });
  const actions = await connector.handleMessage(message({
    kind: "mixed",
    text: "这是什么？",
    attachments: [{
      id: "image-1",
      kind: "image",
      fileName: "photo.jpg",
      size: 4,
      raw: {} as RuntimeMessage["attachments"][number]["raw"],
    }],
  }), context({
    downloadMessageMedia: async () => [{
      id: "cached",
      messageId: "message-1",
      attachmentId: "image-1",
      kind: "image",
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      size: 4,
      data: Buffer.from("jpeg"),
    }],
  }));

  assert.match(request?.prompt ?? "", /Wechat_Saved\//);
  const stagedRelative = request?.prompt.match(/Wechat_Saved\/[^\s]+/)?.[0];
  assert.ok(stagedRelative);
  assert.equal((await fs.readFile(path.join(dir, stagedRelative), "utf-8")), "jpeg");
  assert.match(sentText(actions), /看到了/);
  const media = actions.find((item) => item.type === "send_media");
  assert.ok(media && media.type === "send_media");
  assert.equal(media.filePath, outputPath);
});

test("missing workspace and video fail locally without invoking Claude", async () => {
  let runs = 0;
  const runner: ClaudeAgentRunner = {
    async run() {
      runs += 1;
      return { outputs: [] };
    },
  };
  const noWorkspace = createClaudeRouteConnector({
    id: "claude-route",
    config: config(),
    runner,
    sessions: new MemorySessionStore(),
  });
  assert.match(sentText(await noWorkspace.handleMessage(message(), context())), /Workspace Missing/);

  const withWorkspace = createClaudeRouteConnector({
    id: "claude-route",
    config: config(os.tmpdir()),
    runner,
    sessions: new MemorySessionStore(),
  });
  assert.match(sentText(await withWorkspace.handleMessage(message({
    kind: "video",
    text: undefined,
    attachments: [{
      kind: "video",
      raw: {} as RuntimeMessage["attachments"][number]["raw"],
    }],
  }), context())), /Unsupported Video/);
  assert.equal(runs, 0);
});
