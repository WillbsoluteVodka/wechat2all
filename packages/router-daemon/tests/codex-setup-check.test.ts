import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  resolveCodexSetupCheckPath,
  runCodexSetupCheck,
  type CodexSetupCheckLogger,
} from "../src/codex-setup-check.js";

async function fakeChecker(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-setup-check-"));
  const scriptPath = path.join(dir, "check.sh");
  await fs.writeFile(scriptPath, source, { mode: 0o700 });
  return scriptPath;
}

test("Codex setup checker resolves an explicit package script", async () => {
  const scriptPath = await fakeChecker("#!/bin/sh\nexit 0\n");

  assert.equal(resolveCodexSetupCheckPath({ scriptPath }), scriptPath);
});

test("Codex setup checker resolves the script owned by codex-gui-bridge", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");

  assert.equal(
    resolveCodexSetupCheckPath({ cwd: repoRoot }),
    path.join(repoRoot, "packages/codex-gui-bridge/scripts/check.sh"),
  );
});

test("Codex setup checker streams output and does not reject a missing-condition exit", async () => {
  const scriptPath = await fakeChecker([
    "#!/bin/sh",
    "printf 'public\\n'",
    "printf '  PASS     desktop installed\\n'",
    "printf '  MISSING  task binding\\n'",
    "printf 'permission missing\\n' >&2",
    "exit 1",
    "",
  ].join("\n"));
  const info: string[] = [];
  const warnings: string[] = [];
  const streamedItems: string[] = [];
  const logger: CodexSetupCheckLogger = {
    info: (message) => info.push(message),
    warn: (message) => warnings.push(message),
  };

  const result = await runCodexSetupCheck({
    env: { ...process.env },
    scriptPath,
    logger,
    onItem: (item) => streamedItems.push(item.message),
  });

  assert.equal(result.started, true);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.items, [
    { status: "pass", message: "desktop installed", section: "public" },
    { status: "missing", message: "task binding", section: "public" },
  ]);
  assert.deepEqual(streamedItems, ["desktop installed", "task binding"]);
  assert.ok(warnings.includes("permission missing"));
  assert.match(warnings.at(-1) ?? "", /WeConnect will continue starting/);
});

test("Codex setup checker can be disabled without spawning", async () => {
  const messages: string[] = [];
  const result = await runCodexSetupCheck({
    env: { WECHAT2ALL_CODEX_SETUP_CHECK: "0" },
    scriptPath: "/does/not/exist",
    logger: {
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    },
  });

  assert.equal(result.started, false);
  assert.match(messages.join(" "), /disabled/);
});
