#!/usr/bin/env node
export * from "./types.js";
export * from "./app-server-rpc.js";
export * from "./desktop-ipc.js";
export * from "./alarm.js";
export * from "./auto-open.js";
export * from "./binding.js";
export * from "./gui-app.js";
export * from "./gui-automation.js";
export * from "./client.js";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureCodexGuiOpen } from "./auto-open.js";
import { createCodexGuiBridgeClientFromEnv } from "./client.js";

function parseAutoOpenArg(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const command = args[0] ?? "help";
  const bridge = createCodexGuiBridgeClientFromEnv();
  try {
    if (command === "ensure-open") {
      const result = await ensureCodexGuiOpen({
        dryRun: args.includes("--dry-run"),
        quiet: args.includes("--quiet"),
        force: args.includes("--force"),
      });
      if (!args.includes("--quiet")) console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "autoopen") {
      const enabled = parseAutoOpenArg(args[1]);
      const state = enabled === undefined
        ? await bridge.getAutoOpen()
        : await bridge.setAutoOpen(enabled);
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    if (command === "alarm") {
      const value = args[1]?.trim();
      const state = !value
        ? await bridge.getAlarm()
        : value.toLowerCase() === "off" || value === "0"
          ? await bridge.clearAlarm()
          : await bridge.setAlarm(value);
      console.log(JSON.stringify(state, null, 2));
      return;
    }
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
      "  autoopen [0|1]    Read or set Codex GUI auto-open",
      "  ensure-open       Open Codex GUI when auto-open is enabled",
      "  alarm [HH:mm|off] Read, set, or clear the Codex keepalive alarm",
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
