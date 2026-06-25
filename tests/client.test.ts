import assert from "node:assert/strict";
import { test } from "node:test";

import { WeChatClient } from "../src/index.js";
import type { GetUpdatesResp } from "../src/index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("constructor normalizes accountId and exposes credentials", () => {
  const client = new WeChatClient({
    accountId: "ABC@im.bot",
    token: "token",
    baseUrl: "https://api.example",
  });

  assert.equal(client.getAccountId(), "abc-im-bot");
  assert.deepEqual(client.getCredentials(), {
    accountId: "abc-im-bot",
    token: "token",
    baseUrl: "https://api.example",
  });
});

test("start rejects duplicate runs and stop clears running state", async () => {
  const client = new WeChatClient({
    accountId: "abc@im.bot",
    token: "token",
  });

  client.api.getUpdates = async (): Promise<GetUpdatesResp> => {
    await sleep(5);
    return { ret: 0, msgs: [], get_updates_buf: "" };
  };

  const running = client.start({
    retryDelayMs: 0,
    backoffDelayMs: 0,
  });
  await sleep(1);

  assert.equal(client.isRunning(), true);
  await assert.rejects(
    () => client.start(),
    /already running/,
  );

  client.stop();
  await running;
  assert.equal(client.isRunning(), false);
});
