import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileClaudeSessionStore } from "../src/session-store.js";

test("FileClaudeSessionStore persists and clears independent sessions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-claude-sessions-"));
  const filePath = path.join(dir, "sessions.json");
  const store = new FileClaudeSessionStore(filePath);

  await Promise.all([
    store.set("one", { sessionId: "session-1", updatedAt: 10 }),
    store.set("two", { sessionId: "session-2", updatedAt: 20 }),
  ]);

  assert.deepEqual(await store.get("one"), { sessionId: "session-1", updatedAt: 10 });
  assert.deepEqual(await store.get("two"), { sessionId: "session-2", updatedAt: 20 });
  await store.clear("one");
  assert.equal(await store.get("one"), null);
  assert.deepEqual(await store.get("two"), { sessionId: "session-2", updatedAt: 20 });

  const mode = (await fs.stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});
