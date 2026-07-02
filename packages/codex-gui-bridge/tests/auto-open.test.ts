import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ensureCodexGuiOpen,
  readCodexGuiAutoOpen,
  writeCodexGuiAutoOpen,
} from "../src/index.js";

function tempConfigPath(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
    .then((dir) => path.join(dir, "autoopen.json"));
}

test("Codex GUI auto-open defaults to disabled", async () => {
  const configPath = await tempConfigPath("wechat2all-codex-autoopen-");

  assert.deepEqual(await readCodexGuiAutoOpen({ configPath }), {
    enabled: false,
  });
});

test("Codex GUI auto-open persists the enabled flag", async () => {
  const configPath = await tempConfigPath("wechat2all-codex-autoopen-");

  const enabled = await writeCodexGuiAutoOpen(true, { configPath });
  assert.equal(enabled.enabled, true);
  assert.equal(typeof enabled.updatedAt, "number");

  const disabled = await writeCodexGuiAutoOpen(false, { configPath });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(await readCodexGuiAutoOpen({ configPath }), disabled);
});

test("ensureCodexGuiOpen skips when auto-open is disabled", async () => {
  const configPath = await tempConfigPath("wechat2all-codex-autoopen-");
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = await ensureCodexGuiOpen({
    configPath,
    platform: "darwin",
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(result, {
    enabled: false,
    alreadyOpen: false,
    opened: false,
    dryRun: false,
    skippedReason: "disabled",
  });
  assert.deepEqual(calls, []);
});

test("ensureCodexGuiOpen opens Codex when enabled and not running", async () => {
  const configPath = await tempConfigPath("wechat2all-codex-autoopen-");
  await writeCodexGuiAutoOpen(true, { configPath });
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = await ensureCodexGuiOpen({
    configPath,
    platform: "darwin",
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      if (command === "/usr/bin/pgrep") return { ok: false, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.enabled, true);
  assert.equal(result.opened, true);
  assert.deepEqual(calls.at(-1), {
    command: "/usr/bin/open",
    args: ["/Applications/Codex.app"],
  });
});

test("ensureCodexGuiOpen does not reopen an already running Codex app", async () => {
  const configPath = await tempConfigPath("wechat2all-codex-autoopen-");
  await writeCodexGuiAutoOpen(true, { configPath });
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = await ensureCodexGuiOpen({
    configPath,
    platform: "darwin",
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, stdout: "123\n", stderr: "" };
    },
  });

  assert.equal(result.alreadyOpen, true);
  assert.equal(result.opened, false);
  assert.equal(calls.some((call) => call.command === "/usr/bin/open"), false);
});
