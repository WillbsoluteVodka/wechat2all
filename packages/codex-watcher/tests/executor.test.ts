import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexArgs,
  formatCodexPrompt,
} from "../src/executor.js";

test("formatCodexPrompt wraps WeChat prompt metadata and text", () => {
  const prompt = formatCodexPrompt({
    id: "prompt-1",
    createdAt: 1,
    profileId: "default",
    conversationId: "conv-1",
    senderId: "sender-1",
    text: "continue this task",
    sourceMessageId: "m1",
  });

  assert.match(prompt, /wechat2all/);
  assert.match(prompt, /prompt-1/);
  assert.match(prompt, /continue this task/);
});

test("buildCodexArgs supports resume-last, resume-session, and exec modes", () => {
  assert.deepEqual(
    buildCodexArgs({
      mode: "resume-last",
      outputLastMessagePath: "/tmp/last.txt",
    }),
    ["exec", "resume", "--last", "--output-last-message", "/tmp/last.txt", "-"],
  );

  assert.deepEqual(
    buildCodexArgs({
      mode: "resume-session",
      sessionId: "session-1",
      outputLastMessagePath: "/tmp/last.txt",
      model: "gpt-5",
      extraArgs: ["--json"],
    }),
    [
      "exec",
      "resume",
      "--model",
      "gpt-5",
      "--json",
      "--output-last-message",
      "/tmp/last.txt",
      "session-1",
      "-",
    ],
  );

  assert.deepEqual(
    buildCodexArgs({
      mode: "exec",
      outputLastMessagePath: "/tmp/last.txt",
      bypassApprovalsAndSandbox: true,
    }),
    [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-last-message",
      "/tmp/last.txt",
      "-",
    ],
  );

  assert.throws(
    () => buildCodexArgs({
      mode: "resume-session",
      outputLastMessagePath: "/tmp/last.txt",
    }),
    /requires --session-id/,
  );
});
