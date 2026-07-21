import { spawn } from "node:child_process";

import { resolveCodexGuiAppTarget } from "./gui-app.js";

export interface CodexGuiAutomationOptions {
  osascriptBin?: string;
  env?: NodeJS.ProcessEnv;
  appName?: string;
  appPath?: string;
  processName?: string;
  bundleId?: string;
  activateDelayMs?: number;
  sendDelayMs?: number;
  attachmentDelayMs?: number;
  attachmentPaths?: string[];
  threadId?: string;
  threadOpenDelayMs?: number;
}

const SCRIPT = `
on run argv
  set promptText to item 1 of argv
  set appName to item 2 of argv
  set processName to item 3 of argv
  set activateDelaySeconds to (item 4 of argv) as number
  set targetThreadId to item 5 of argv
  set threadOpenDelaySeconds to (item 6 of argv) as number
  set sendDelaySeconds to (item 7 of argv) as number
  set attachmentDelaySeconds to (item 8 of argv) as number
  set attachmentPaths to {}
  if (count of argv) > 8 then set attachmentPaths to items 9 thru -1 of argv
  set oldClipboard to missing value
  set clipboardChanged to false

  try
    if targetThreadId is not "" then
      do shell script "/usr/bin/open " & quoted form of ("codex://threads/" & targetThreadId)
      delay threadOpenDelaySeconds
    end if

    tell application appName to activate
    delay activateDelaySeconds

    tell application "System Events"
      if UI elements enabled is false then error "Accessibility is not available for GUI automation"
      if not (exists process processName) then error processName & " is not running"
      tell process processName
        if (count of windows) is 0 then error processName & " has no accessible window"
        set frontmost to true
        delay 0.2
      end tell
    end tell

    try
      set oldClipboard to the clipboard as text
    end try
    tell application "System Events"
      tell process processName
        repeat with attachmentPath in attachmentPaths
          set the clipboard to (POSIX file (contents of attachmentPath))
          set clipboardChanged to true
          keystroke "v" using command down
          delay attachmentDelaySeconds
        end repeat
        if promptText is not "" then
          set the clipboard to promptText
          set clipboardChanged to true
          keystroke "v" using command down
        end if
        delay sendDelaySeconds
        key code 36
      end tell
    end tell
  on error errorMessage number errorNumber
    if clipboardChanged and oldClipboard is not missing value then
      try
        set the clipboard to oldClipboard
      end try
    end if
    error errorMessage number errorNumber
  end try

  delay 0.2
  if clipboardChanged and oldClipboard is not missing value then
    set the clipboard to oldClipboard
  end if
end run
`;

const NEW_CHAT_SCRIPT = `
on run argv
  set appName to item 1 of argv
  set processName to item 2 of argv
  set activateDelaySeconds to (item 3 of argv) as number
  set newChatDelaySeconds to (item 4 of argv) as number

  tell application appName to activate
  delay activateDelaySeconds

  tell application "System Events"
    if UI elements enabled is false then error "Accessibility is not available for GUI automation"
    if not (exists process processName) then error processName & " is not running"
    tell process processName
      if (count of windows) is 0 then error processName & " has no accessible window"
      set frontmost to true
      if not (exists menu item "New Chat" of menu "File" of menu bar 1) then
        error "New Chat menu item is unavailable"
      end if
      click menu item "New Chat" of menu "File" of menu bar 1
      delay newChatDelaySeconds
    end tell
  end tell
end run
`;

async function runOsascript(
  script: string,
  args: string[],
  osascriptBin = "osascript",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(osascriptBin, ["-e", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${osascriptBin} failed: code=${code ?? "null"} signal=${signal ?? "null"} ${stderr.trim()}`,
      ));
    });
  });
}

export async function injectPromptIntoCodexGui(
  text: string,
  opts: CodexGuiAutomationOptions = {},
): Promise<void> {
  const target = resolveCodexGuiAppTarget(opts);
  const activateDelaySeconds = String((opts.activateDelayMs ?? 450) / 1000);
  const sendDelaySeconds = String((opts.sendDelayMs ?? 600) / 1000);
  const attachmentDelaySeconds = String((opts.attachmentDelayMs ?? 700) / 1000);
  const threadId = opts.threadId?.trim() ?? "";
  const threadOpenDelaySeconds = String((opts.threadOpenDelayMs ?? 900) / 1000);
  await runOsascript(SCRIPT, [
    text,
    target.appName,
    target.processName,
    activateDelaySeconds,
    threadId,
    threadOpenDelaySeconds,
    sendDelaySeconds,
    attachmentDelaySeconds,
    ...(opts.attachmentPaths ?? []).map((filePath) => filePath.trim()).filter(Boolean),
  ], opts.osascriptBin);
}

export async function startNewChatInCodexGui(
  opts: CodexGuiAutomationOptions = {},
): Promise<void> {
  const target = resolveCodexGuiAppTarget(opts);
  await runOsascript(NEW_CHAT_SCRIPT, [
    target.appName,
    target.processName,
    String((opts.activateDelayMs ?? 450) / 1000),
    String((opts.sendDelayMs ?? 600) / 1000),
  ], opts.osascriptBin);
}
