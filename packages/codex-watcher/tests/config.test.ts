import assert from "node:assert/strict";
import test from "node:test";

import { parseWatcherCliConfig } from "../src/config.js";

test("parseWatcherCliConfig combines CLI args and env", () => {
  const config = parseWatcherCliConfig(
    [
      "--bridge-dir",
      "/tmp/bridge",
      "--mode",
      "resume-session",
      "--session-id",
      "session-1",
      "--once",
      "--process-existing",
      "--poll-ms",
      "250",
      "--no-ack",
    ],
    {
      WECHAT2ALL_CODEX_MODEL: "gpt-5",
      WECHAT2ALL_CODEX_EXTRA_ARGS: "[\"--json\"]",
    },
  );

  assert.equal(config.bridgeDir, "/tmp/bridge");
  assert.equal(config.mode, "resume-session");
  assert.equal(config.sessionId, "session-1");
  assert.equal(config.once, true);
  assert.equal(config.processExisting, true);
  assert.equal(config.pollIntervalMs, 250);
  assert.equal(config.sendAck, false);
  assert.equal(config.model, "gpt-5");
  assert.deepEqual(config.extraArgs, ["--json"]);
});
