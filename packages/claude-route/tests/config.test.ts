import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claudeRouteConfigFromEnv } from "../src/config.js";

test("claudeRouteConfigFromEnv applies safe defaults and aliases", () => {
  const config = claudeRouteConfigFromEnv({
    stateDir: "/tmp/claude-state",
    env: {
      ANTHROPIC_API_KEY: "sk-ant-test",
      WECHAT2ALL_CLAUDE_VAULT: "~/Notes",
      WECHAT2ALL_CLAUDE_LANGUAGE: "en",
      WECHAT2ALL_CLAUDE_SESSION_WINDOW_MINUTES: "30",
      WECHAT2ALL_CLAUDE_MAX_MEDIA_MB: "12",
      WECHAT2ALL_CLAUDE_MAX_TURNS: "8",
      WECHAT2ALL_CLAUDE_MAX_BUDGET_USD: "0.5",
      WECHAT2ALL_CLAUDE_TIMEOUT_MS: "90000",
    },
  });

  assert.equal(config.workdir, path.join(os.homedir(), "Notes"));
  assert.equal(config.language, "en");
  assert.equal(config.sessionWindowMs, 30 * 60_000);
  assert.equal(config.maxMediaBytes, 12 * 1024 * 1024);
  assert.equal(config.maxTurns, 8);
  assert.equal(config.maxBudgetUsd, 0.5);
  assert.equal(config.timeoutMs, 90_000);
  assert.equal(config.apiKeyConfigured, true);
  assert.equal(config.allowCliAuth, false);
});

test("a zero Claude session window disables session resume", () => {
  const config = claudeRouteConfigFromEnv({
    stateDir: "/tmp/claude-state",
    env: {
      WECHAT2ALL_CLAUDE_SESSION_WINDOW_MINUTES: "0",
    },
  });

  assert.equal(config.sessionWindowMs, 0);
});
