import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { injectPromptIntoCodexGui } from "../src/index.js";

test("GUI automation clears stale input and clicks the send button after paste", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-gui-automation-"));
  const capturePath = path.join(dir, "args.json");
  const fakeOsascript = path.join(dir, "fake-osascript.mjs");
  await fs.writeFile(
    fakeOsascript,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.WECHAT2ALL_CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.chmod(fakeOsascript, 0o755);

  const previousCapturePath = process.env.WECHAT2ALL_CAPTURE_ARGS;
  process.env.WECHAT2ALL_CAPTURE_ARGS = capturePath;
  try {
    await injectPromptIntoCodexGui("hello from WeChat", {
      osascriptBin: fakeOsascript,
      appName: "Codex",
      activateDelayMs: 450,
      threadId: "thread-1",
      threadOpenDelayMs: 900,
      sendDelayMs: 250,
      sendButtonRightOffsetPx: 70,
      sendButtonBottomOffsetPx: 80,
    });
  } finally {
    if (previousCapturePath === undefined) {
      delete process.env.WECHAT2ALL_CAPTURE_ARGS;
    } else {
      process.env.WECHAT2ALL_CAPTURE_ARGS = previousCapturePath;
    }
  }

  const args = JSON.parse(await fs.readFile(capturePath, "utf-8")) as string[];
  assert.equal(args[0], "-e");
  assert.match(args[1], /keystroke "a" using command down/);
  assert.match(args[1], /key code 51/);
  assert.match(args[1], /click at \{inputClickX, inputClickY\}/);
  assert.match(args[1], /click at \{sendClickX, sendClickY\}/);
  assert.doesNotMatch(args[1], /key code 36 using command down/);
  assert.equal(args[2], "hello from WeChat");
  assert.equal(args[3], "Codex");
  assert.equal(args[4], "0.45");
  assert.equal(args[5], "thread-1");
  assert.equal(args[6], "0.9");
  assert.equal(args[7], "0.25");
  assert.equal(args[8], "70");
  assert.equal(args[9], "80");
});
