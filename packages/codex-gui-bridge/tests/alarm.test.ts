import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CodexGuiAppServerBridge,
  nextAlarmFireAt,
  parseCodexGuiAlarmTime,
  readCodexGuiAlarm,
  type CodexAppServerTransport,
} from "../src/index.js";

class MinimalTransport implements CodexAppServerTransport {
  async request<T>(): Promise<T> {
    throw new Error("transport should not be used by alarm state tests");
  }
}

function tempConfigPath(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
    .then((dir) => path.join(dir, "alarm.json"));
}

test("Codex GUI alarm defaults to disabled", async () => {
  const configPath = await tempConfigPath("wechat2all-codex-alarm-");

  assert.deepEqual(await readCodexGuiAlarm({ configPath }), {
    enabled: false,
  });
});

test("Codex GUI alarm parses 24-hour time", () => {
  assert.deepEqual(parseCodexGuiAlarmTime("9:05"), {
    hour: 9,
    minute: 5,
    timeText: "09:05",
  });
  assert.deepEqual(parseCodexGuiAlarmTime("23"), {
    hour: 23,
    minute: 0,
    timeText: "23:00",
  });
  assert.throws(() => parseCodexGuiAlarmTime("24:00"), /24-hour time/);
});

test("Codex GUI alarm computes the next occurrence within 24 hours", () => {
  const now = new Date("2026-07-03T10:00:00+08:00").getTime();
  assert.equal(
    new Date(nextAlarmFireAt({ hour: 11, minute: 30, now })).toISOString(),
    new Date("2026-07-03T11:30:00+08:00").toISOString(),
  );
  assert.equal(
    new Date(nextAlarmFireAt({ hour: 9, minute: 30, now })).toISOString(),
    new Date("2026-07-04T09:30:00+08:00").toISOString(),
  );
});

test("Codex GUI bridge persists alarm settings", async () => {
  const configPath = await tempConfigPath("wechat2all-codex-alarm-");
  const bridge = new CodexGuiAppServerBridge({
    transport: new MinimalTransport(),
    alarmConfigPath: configPath,
  });

  const alarm = await bridge.setAlarm("09:30");
  assert.equal(alarm.enabled, true);
  assert.equal(alarm.timeText, "09:30");
  assert.equal(typeof alarm.nextFireAt, "number");
  assert.equal((await bridge.getAlarm()).timeText, "09:30");

  assert.equal((await bridge.clearAlarm()).enabled, false);
  assert.equal((await bridge.getAlarm()).enabled, false);
  assert.equal((await fs.stat(configPath)).mode & 0o077, 0);
  bridge.close();
});
