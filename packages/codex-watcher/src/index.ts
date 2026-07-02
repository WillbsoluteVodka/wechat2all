#!/usr/bin/env node
import path from "node:path";

import {
  createExecutorFromConfig,
  createStoreFromConfig,
  parseWatcherCliConfig,
} from "./config.js";
import { WatcherLock } from "./lock.js";
import { CodexPromptWatcher } from "./watcher.js";

async function main(): Promise<void> {
  const config = parseWatcherCliConfig();
  const store = createStoreFromConfig(config);
  const executor = createExecutorFromConfig(config);
  const watcher = new CodexPromptWatcher({
    store,
    executor,
    options: {
      pollIntervalMs: config.pollIntervalMs,
      batchSize: config.batchSize,
      maxAttempts: config.maxAttempts,
      retryDelayMs: config.retryDelayMs,
      processExisting: config.processExisting,
      sendAck: config.sendAck,
      sendResult: config.sendResult,
      sendErrors: config.sendErrors,
      maxWechatMessageChars: config.maxWechatMessageChars,
      currentProject: config.currentProject,
      currentThreadId: config.currentThreadId,
    },
  });
  const lock = new WatcherLock(path.join(store.baseDir, "watcher.lock"));
  await lock.acquire();

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  try {
    if (config.once) {
      const result = await watcher.processOnce();
      process.stderr.write(`[wechat2all-codex-watcher] once ${JSON.stringify(result)}\n`);
      return;
    }
    await watcher.run(controller.signal);
  } finally {
    await lock.release();
  }
}

main().catch((err) => {
  const error = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(`[wechat2all-codex-watcher] fatal ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
