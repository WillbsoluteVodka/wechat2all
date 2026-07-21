import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { injectPromptIntoCodexGui, startNewChatInCodexGui } from "../src/index.js";

test("GUI automation submits pasted prompts with Return after a send delay", async () => {
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
      attachmentDelayMs: 300,
      attachmentPaths: ["/tmp/wechat-image.png"],
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
  assert.match(args[1], /keystroke "v" using command down/);
  assert.match(args[1], /key code 36/);
  assert.match(args[1], /do shell script "\/usr\/bin\/open "/);
  assert.match(args[1], /UI elements enabled is false/);
  assert.match(args[1], /count of windows/);
  assert.ok(
    args[1].indexOf("count of windows") < args[1].indexOf("set the clipboard to promptText"),
  );
  assert.match(args[1], /on error errorMessage number errorNumber/);
  assert.doesNotMatch(args[1], /click at/);
  assert.equal(args[2], "hello from WeChat");
  assert.equal(args[3], "Codex");
  assert.equal(args[4], "Codex");
  assert.equal(args[5], "0.45");
  assert.equal(args[6], "thread-1");
  assert.equal(args[7], "0.9");
  assert.equal(args[8], "0.25");
  assert.equal(args[9], "0.3");
  assert.equal(args[10], "/tmp/wechat-image.png");
});

test("GUI automation discovers the current ChatGPT app name", async () => {
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
    await injectPromptIntoCodexGui("hello ChatGPT", {
      osascriptBin: fakeOsascript,
      env: { HOME: "/Users/test" },
      appPath: "/Applications/ChatGPT.app",
    });
  } finally {
    if (previousCapturePath === undefined) {
      delete process.env.WECHAT2ALL_CAPTURE_ARGS;
    } else {
      process.env.WECHAT2ALL_CAPTURE_ARGS = previousCapturePath;
    }
  }

  const args = JSON.parse(await fs.readFile(capturePath, "utf-8")) as string[];
  assert.equal(args[3], "ChatGPT");
  assert.equal(args[4], "ChatGPT");
});

test("GUI automation opens File > New Chat", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-gui-new-chat-"));
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
    await startNewChatInCodexGui({
      osascriptBin: fakeOsascript,
      appName: "Codex",
      activateDelayMs: 400,
      sendDelayMs: 700,
    });
  } finally {
    if (previousCapturePath === undefined) {
      delete process.env.WECHAT2ALL_CAPTURE_ARGS;
    } else {
      process.env.WECHAT2ALL_CAPTURE_ARGS = previousCapturePath;
    }
  }

  const args = JSON.parse(await fs.readFile(capturePath, "utf-8")) as string[];
  assert.match(args[1], /menu item "New Chat" of menu "File"/);
  assert.match(args[1], /click menu item "New Chat"/);
  assert.equal(args[2], "Codex");
  assert.equal(args[3], "Codex");
  assert.equal(args[4], "0.4");
  assert.equal(args[5], "0.7");
});
