import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { RuntimeMessage } from "@wechat2all/runtime";

import {
  SessionReminderService,
  nextSessionReminderAt,
  readSessionReminderTarget,
} from "../src/session-reminders.js";

function ownerMessage(contextToken = "ctx-owner"): RuntimeMessage {
  return {
    id: "message-1",
    platform: "wechat-ilink",
    profileId: "default",
    conversationId: "owner-1",
    senderId: "owner-1",
    timestamp: Date.now(),
    kind: "text",
    text: "hello",
    attachments: [],
    replyToken: { userId: "owner-1", contextToken },
    raw: {},
  };
}

test("next reminder follows session hour boundaries and stops before expiry", () => {
  const hour = 60 * 60_000;
  const loginAt = 1_000;

  assert.equal(nextSessionReminderAt({
    loginAt,
    now: loginAt,
    sessionDurationMs: 24 * hour,
    reminderIntervalMs: hour,
  }), loginAt + hour);
  assert.equal(nextSessionReminderAt({
    loginAt,
    now: loginAt + 5.5 * hour,
    sessionDurationMs: 24 * hour,
    reminderIntervalMs: hour,
  }), loginAt + 6 * hour);
  assert.equal(nextSessionReminderAt({
    loginAt,
    now: loginAt + 23.5 * hour,
    sessionDurationMs: 24 * hour,
    reminderIntervalMs: hour,
  }), undefined);
});

test("session reminder persists the owner context token privately", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-session-reminder-"));
  const statePath = path.join(dir, "session-reminder.json");
  const service = new SessionReminderService({
    statePath,
    sessionDurationMs: 60_000,
    onReminder() {},
  });
  await service.initialize();
  const loginAt = Date.now();
  await service.startSession({ loginAt, ownerUserId: "owner-1" });

  assert.equal(service.getSessionExpiresAt(), loginAt + 60_000);
  assert.equal(await service.captureMessage(ownerMessage()), true);
  const target = await readSessionReminderTarget(statePath);
  assert.equal(target?.userId, "owner-1");
  assert.equal(target?.contextToken, "ctx-owner");
  assert.equal(typeof target?.updatedAt, "number");
  assert.equal((await fs.stat(statePath)).mode & 0o077, 0);
  service.close();
});

test("session reminder fires on schedule and ignores a non-owner target", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-session-reminder-"));
  const statePath = path.join(dir, "session-reminder.json");
  let resolveReminder: (() => void) | undefined;
  const reminder = new Promise<void>((resolve) => {
    resolveReminder = resolve;
  });
  const events: string[] = [];
  const service = new SessionReminderService({
    statePath,
    sessionDurationMs: 500,
    reminderIntervalMs: 25,
    onReminder(event) {
      events.push(event.target.userId);
      resolveReminder?.();
    },
  });
  await service.initialize();
  await service.startSession({ loginAt: Date.now(), ownerUserId: "owner-1" });
  assert.equal(await service.captureMessage({
    ...ownerMessage("ctx-other"),
    senderId: "other-user",
    conversationId: "other-user",
    replyToken: { userId: "other-user", contextToken: "ctx-other" },
  }), false);
  assert.equal(await service.captureMessage(ownerMessage()), true);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("session reminder did not fire")),
      500,
    );
  });
  try {
    await Promise.race([reminder, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  assert.deepEqual(events, ["owner-1"]);
  service.close();
});
