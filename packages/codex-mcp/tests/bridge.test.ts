import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexBridgeStore,
  codexBridgeDirFromEnv,
} from "../src/bridge.js";

test("codexBridgeDirFromEnv matches router-daemon default profile layout", () => {
  assert.equal(
    codexBridgeDirFromEnv({
      HOME: "/Users/example",
    }),
    path.join(os.homedir(), ".wechat2all-runtime-bot", "codex-bridge"),
  );
  assert.equal(
    codexBridgeDirFromEnv({
      WECHAT2ALL_STATE_DIR: "/state",
      WECHAT_RUNTIME_PROFILE: "work",
    }),
    path.join("/state", "profiles", "work", "codex-bridge"),
  );
  assert.equal(
    codexBridgeDirFromEnv({
      WECHAT2ALL_CODEX_BRIDGE_DIR: "/custom/bridge",
    }),
    path.join("/custom/bridge"),
  );
});

test("CodexBridgeStore writes status and outbox messages", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-mcp-"));
  const store = new CodexBridgeStore(baseDir);

  const status = await store.updateStatus({
    state: "working",
    summary: "running checks",
    currentProject: "wechat2all",
  });
  assert.equal(status.state, "working");
  assert.equal((await store.getStatus())?.summary, "running checks");

  const outbox = await store.sendWechatMessage({
    text: "Codex is working",
    level: "info",
  });
  assert.equal(outbox.text, "Codex is working");
  assert.match(await fs.readFile(path.join(baseDir, "outbox.jsonl"), "utf-8"), /Codex is working/);

  const state = await store.getBridgeState();
  assert.equal(state.undeliveredOutboxCount, 1);
  assert.equal(state.pendingPromptCount, 0);
});

test("CodexBridgeStore lists and marks WeChat prompts", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-mcp-"));
  const store = new CodexBridgeStore(baseDir);
  await fs.writeFile(
    path.join(baseDir, "inbox.jsonl"),
    [
      JSON.stringify({
        id: "prompt-1",
        createdAt: 1,
        profileId: "default",
        conversationId: "user-1",
        senderId: "user-1",
        text: "continue the task",
        sourceMessageId: "m1",
      }),
      JSON.stringify({
        id: "prompt-2",
        createdAt: 2,
        profileId: "default",
        conversationId: "user-1",
        senderId: "user-1",
        text: "show status",
        sourceMessageId: "m2",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  assert.deepEqual(
    (await store.listWechatPrompts()).map((prompt) => prompt.id),
    ["prompt-1", "prompt-2"],
  );

  await store.markWechatPromptHandled("prompt-1");
  assert.deepEqual(
    (await store.listWechatPrompts()).map((prompt) => prompt.id),
    ["prompt-2"],
  );
  assert.deepEqual(
    (await store.listWechatPrompts({ includeHandled: true })).map((prompt) => prompt.id),
    ["prompt-1", "prompt-2"],
  );
});
