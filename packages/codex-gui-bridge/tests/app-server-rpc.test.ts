import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CodexAppServerRpc } from "../src/index.js";

test("RPC timeout discards the wedged child and the next request starts a fresh server", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-codex-rpc-test-"));
  const markerPath = path.join(dir, "first-process-started");
  const executablePath = path.join(dir, "fake-codex");
  await fs.writeFile(executablePath, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const marker = ${JSON.stringify(markerPath)};
const first = !fs.existsSync(marker);
if (first) fs.writeFileSync(marker, "1");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (first) return;
  const request = JSON.parse(line);
  if (request.id == null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) + "\\n");
});
`);
  await fs.chmod(executablePath, 0o755);

  const rpc = new CodexAppServerRpc({ command: executablePath, timeoutMs: 1_500 });
  await assert.rejects(rpc.request("initialize"), /Timed out waiting for initialize/);
  const generationAfterTimeout = rpc.getGeneration();

  assert.deepEqual(await rpc.request("initialize", undefined, 4_000), { ok: true });
  assert.ok(rpc.getGeneration() >= generationAfterTimeout);
  rpc.close();
});
