import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApiClient } from "../src/index.js";
import { SESSION_EXPIRED_ERRCODE, startMonitor } from "../src/index.js";
import type { GetUpdatesResp } from "../src/index.js";

test("startMonitor stops immediately when session expires and behavior is stop", async () => {
  let polls = 0;
  let expirations = 0;
  const api = {
    async getUpdates(): Promise<GetUpdatesResp> {
      polls++;
      return { ret: SESSION_EXPIRED_ERRCODE, errmsg: "expired" };
    },
  } as unknown as ApiClient;

  await startMonitor(
    api,
    { sessionExpiredBehavior: "stop" },
    {
      onMessage() {
        throw new Error("should not receive messages");
      },
      onSessionExpired() {
        expirations++;
      },
    },
  );

  assert.equal(polls, 1);
  assert.equal(expirations, 1);
});

test("startMonitor loads and saves sync cursor around message dispatch", async () => {
  const controller = new AbortController();
  const seenBufs: string[] = [];
  let savedBuf = "";

  const api = {
    async getUpdates(buf: string): Promise<GetUpdatesResp> {
      seenBufs.push(buf);
      return {
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [{ from_user_id: "user", context_token: "ct" }],
      };
    },
  } as unknown as ApiClient;

  await startMonitor(
    api,
    {
      signal: controller.signal,
      loadSyncBuf: () => "initial-cursor",
      saveSyncBuf: (buf) => {
        savedBuf = buf;
      },
    },
    {
      onMessage(msg) {
        assert.equal(msg.from_user_id, "user");
        controller.abort();
      },
    },
  );

  assert.deepEqual(seenBufs, ["initial-cursor"]);
  assert.equal(savedBuf, "next-cursor");
});
