#!/usr/bin/env node
export * from "./types.js";
export * from "./app-server-rpc.js";
export * from "./gui-automation.js";
export * from "./client.js";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCodexGuiBridgeClientFromEnv } from "./client.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const command = args[0] ?? "help";
  const bridge = createCodexGuiBridgeClientFromEnv();
  try {
    if (command === "ls" || command === "chats") {
      const chats = await bridge.listChats();
      console.log(JSON.stringify(chats, null, 2));
      return;
    }
    if (command === "token") {
      console.log(JSON.stringify(await bridge.getTokenUsage(), null, 2));
      return;
    }
    if (command === "current") {
      console.log(JSON.stringify(await bridge.getCurrentBinding(), null, 2));
      return;
    }
    if (command === "bind") {
      const threadId = args[1];
      if (!threadId) throw new Error("Usage: wechat2all-codex-gui-bridge bind <threadId>");
      console.log(JSON.stringify(await bridge.bindThread(threadId), null, 2));
      return;
    }
    if (command === "send") {
      const text = args.slice(1).join(" ").trim();
      if (!text) throw new Error("Usage: wechat2all-codex-gui-bridge send <text>");
      console.log(JSON.stringify(await bridge.sendPrompt({ text }), null, 2));
      return;
    }

    console.log([
      "Usage: wechat2all-codex-gui-bridge <command>",
      "",
      "Commands:",
      "  ls | chats        List bindable Codex chats",
      "  token             Read account usage from app-server",
      "  current           Show current env/default binding",
      "  bind <threadId>   Validate and display a thread binding",
      "  send <text>       Send text to the bound thread",
    ].join("\n"));
  } finally {
    bridge.close();
  }
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedFile === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
