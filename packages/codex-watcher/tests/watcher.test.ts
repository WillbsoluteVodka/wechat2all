import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexBridgeStore,
  type CodexBridgePrompt,
} from "@wechat2all/codex-mcp/bridge";

import type {
  CodexExecutionResult,
  CodexPromptExecutor,
} from "../src/executor.js";
import { WatcherStateStore } from "../src/state.js";
import { CodexPromptWatcher } from "../src/watcher.js";

class StaticExecutor implements CodexPromptExecutor {
  prompts: CodexBridgePrompt[] = [];
  constructor(private result: string) {}
  async run(prompt: CodexBridgePrompt): Promise<CodexExecutionResult> {
    this.prompts.push(prompt);
    return {
      finalText: this.result,
      stdout: this.result,
      stderr: "",
      exitCode: 0,
      mode: "echo",
    };
  }
}

class FailingExecutor implements CodexPromptExecutor {
  attempts = 0;
  async run(): Promise<CodexExecutionResult> {
    this.attempts += 1;
    throw new Error("boom");
  }
}

async function writePrompt(baseDir: string, prompt: Partial<CodexBridgePrompt> = {}): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  const item: CodexBridgePrompt = {
    id: prompt.id ?? "prompt-1",
    createdAt: prompt.createdAt ?? 1,
    profileId: prompt.profileId ?? "default",
    conversationId: prompt.conversationId ?? "user-1",
    senderId: prompt.senderId ?? "user-1",
    text: prompt.text ?? "continue",
    sourceMessageId: prompt.sourceMessageId ?? "m1",
  };
  await fs.appendFile(
    path.join(baseDir, "inbox.jsonl"),
    `${JSON.stringify(item)}\n`,
    "utf-8",
  );
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

test("CodexPromptWatcher injects pending prompts and writes result to outbox", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-watcher-"));
  await writePrompt(baseDir, { text: "what changed?" });
  const store = new CodexBridgeStore(baseDir);
  const executor = new StaticExecutor("done from codex");
  const watcher = new CodexPromptWatcher({
    store,
    executor,
    state: new WatcherStateStore(path.join(baseDir, "watcher-state.json")),
    options: {
      processExisting: true,
      sendAck: true,
      sendResult: true,
      pollIntervalMs: 1,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  const result = await watcher.processOnce();

  assert.deepEqual(result, { seen: 1, processed: 1, skipped: 0, failed: 0 });
  assert.equal(executor.prompts[0]?.text, "what changed?");
  assert.deepEqual(await store.listWechatPrompts(), []);
  assert.equal((await store.getStatus())?.state, "completed");
  const outbox = await readJsonl(path.join(baseDir, "outbox.jsonl"));
  assert.equal(outbox.length, 2);
  assert.match(JSON.stringify(outbox[0]), /正在交给 Codex/);
  assert.match(JSON.stringify(outbox[1]), /done from codex/);
});

test("CodexPromptWatcher skips failed prompts until retry time", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-watcher-"));
  await writePrompt(baseDir);
  const store = new CodexBridgeStore(baseDir);
  const executor = new FailingExecutor();
  const watcher = new CodexPromptWatcher({
    store,
    executor,
    state: new WatcherStateStore(path.join(baseDir, "watcher-state.json")),
    options: {
      processExisting: true,
      sendAck: false,
      retryDelayMs: 60_000,
      maxAttempts: 2,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  const first = await watcher.processOnce();
  const second = await watcher.processOnce();

  assert.deepEqual(first, { seen: 1, processed: 0, skipped: 0, failed: 1 });
  assert.deepEqual(second, { seen: 1, processed: 0, skipped: 1, failed: 0 });
  assert.equal(executor.attempts, 1);
});

test("CodexPromptWatcher marks terminal failures handled and sends error", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-watcher-"));
  await writePrompt(baseDir);
  const store = new CodexBridgeStore(baseDir);
  const executor = new FailingExecutor();
  const watcher = new CodexPromptWatcher({
    store,
    executor,
    state: new WatcherStateStore(path.join(baseDir, "watcher-state.json")),
    options: {
      processExisting: true,
      sendAck: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      sendErrors: true,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  const result = await watcher.processOnce();

  assert.deepEqual(result, { seen: 1, processed: 0, skipped: 0, failed: 1 });
  assert.deepEqual(await store.listWechatPrompts(), []);
  assert.equal((await store.getStatus())?.state, "blocked");
  const outbox = await readJsonl(path.join(baseDir, "outbox.jsonl"));
  assert.equal(outbox.length, 1);
  assert.match(JSON.stringify(outbox[0]), /已停止重试/);
});

test("CodexPromptWatcher skips prompts older than watcher startup by default", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-watcher-"));
  await writePrompt(baseDir, {
    id: "old-prompt",
    createdAt: 1000,
    text: "old message",
  });
  const store = new CodexBridgeStore(baseDir);
  const executor = new StaticExecutor("should not run");
  const watcher = new CodexPromptWatcher({
    store,
    executor,
    state: new WatcherStateStore(path.join(baseDir, "watcher-state.json")),
    options: {
      ignoreBeforeMs: 2000,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  const result = await watcher.processOnce();

  assert.deepEqual(result, { seen: 0, processed: 0, skipped: 0, failed: 0 });
  assert.equal(executor.prompts.length, 0);
  assert.deepEqual((await store.listWechatPrompts()).map((prompt) => prompt.id), ["old-prompt"]);
});
