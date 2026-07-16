import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeAgentSdkRunner } from "../src/agent.js";
import type { ClaudeRouteConfig } from "../src/types.js";

function config(overrides: Partial<ClaudeRouteConfig> = {}): ClaudeRouteConfig {
  return {
    promptFile: path.join(os.tmpdir(), "wechat2all-claude-prompt.md"),
    language: "zh",
    sessionWindowMs: 15 * 60_000,
    maxMediaBytes: 50 * 1024 * 1024,
    maxTurns: 40,
    maxBudgetUsd: 1,
    timeoutMs: 60_000,
    apiKeyConfigured: false,
    allowCliAuth: false,
    ...overrides,
  };
}

test("Claude Agent SDK availability reports missing workspace and authentication", async () => {
  const noWorkspace = new ClaudeAgentSdkRunner(config());
  assert.match((await noWorkspace.availability()).reason ?? "", /WORKDIR/);

  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-claude-agent-"));
  const noAuth = new ClaudeAgentSdkRunner(config({ workdir }));
  assert.match((await noAuth.availability()).reason ?? "", /ANTHROPIC_API_KEY/);

  const apiKey = new ClaudeAgentSdkRunner(config({
    workdir,
    apiKeyConfigured: true,
  }));
  assert.deepEqual(await apiKey.availability(), { available: true });

  const explicitCliAuth = new ClaudeAgentSdkRunner(config({
    workdir,
    allowCliAuth: true,
  }));
  assert.deepEqual(await explicitCliAuth.availability(), { available: true });
});

