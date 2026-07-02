#!/usr/bin/env node
import { runMcpServer } from "./server.js";

runMcpServer().catch((err) => {
  const error = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(`[wechat2all-codex-mcp] fatal: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
