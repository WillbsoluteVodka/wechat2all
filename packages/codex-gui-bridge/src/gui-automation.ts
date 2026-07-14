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
  set oldClipboard to missing value

  try
    set oldClipboard to the clipboard as text
  end try

  set the clipboard to promptText

  if targetThreadId is not "" then
    open location ("codex://threads/" & targetThreadId)
    delay threadOpenDelaySeconds
  end if

  tell application appName to activate
  delay activateDelaySeconds

  tell application "System Events"
    if not (exists process processName) then error processName & " is not running"
    tell process processName
      set frontmost to true
      delay 0.2
      keystroke "v" using command down
      delay sendDelaySeconds
      key code 36
    end tell
  end tell

  delay 0.2
  if oldClipboard is not missing value then
    set the clipboard to oldClipboard
  end if
end run
`;

export async function injectPromptIntoCodexGui(
  text: string,
  opts: CodexGuiAutomationOptions = {},
): Promise<void> {
  const target = resolveCodexGuiAppTarget(opts);
  const activateDelaySeconds = String((opts.activateDelayMs ?? 450) / 1000);
  const sendDelaySeconds = String((opts.sendDelayMs ?? 600) / 1000);
  const threadId = opts.threadId?.trim() ?? "";
  const threadOpenDelaySeconds = String((opts.threadOpenDelayMs ?? 900) / 1000);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      opts.osascriptBin ?? "osascript",
      [
        "-e",
        SCRIPT,
        text,
        target.appName,
        target.processName,
        activateDelaySeconds,
        threadId,
        threadOpenDelaySeconds,
        sendDelaySeconds,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
      reject(
        new Error(
          `${opts.osascriptBin ?? "osascript"} failed: ` +
            `code=${code ?? "null"} signal=${signal ?? "null"} ${stderr.trim()}`,
        ),
      );
    });
  });
}
