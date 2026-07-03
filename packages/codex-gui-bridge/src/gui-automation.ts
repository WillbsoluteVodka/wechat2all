import { spawn } from "node:child_process";

export interface CodexGuiAutomationOptions {
  osascriptBin?: string;
  appName?: string;
  activateDelayMs?: number;
  sendDelayMs?: number;
  sendButtonRightOffsetPx?: number;
  sendButtonBottomOffsetPx?: number;
  threadId?: string;
  threadOpenDelayMs?: number;
}

const SCRIPT = `
on run argv
  set promptText to item 1 of argv
  set appName to item 2 of argv
  set activateDelaySeconds to (item 3 of argv) as number
  set targetThreadId to item 4 of argv
  set threadOpenDelaySeconds to (item 5 of argv) as number
  set sendDelaySeconds to (item 6 of argv) as number
  set sendButtonRightOffset to (item 7 of argv) as integer
  set sendButtonBottomOffset to (item 8 of argv) as integer
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
    if not (exists process appName) then error appName & " is not running"
    tell process appName
      set frontmost to true
      delay 0.2
      set windowPosition to position of front window
      set windowSize to size of front window
      set sendClickX to (item 1 of windowPosition) + (item 1 of windowSize) - sendButtonRightOffset
      set sendClickY to (item 2 of windowPosition) + (item 2 of windowSize) - sendButtonBottomOffset
      set inputClickX to (item 1 of windowPosition) + ((item 1 of windowSize) / 2)
      set inputClickY to sendClickY
      click at {inputClickX, inputClickY}
      delay 0.1
      keystroke "a" using command down
      delay 0.05
      key code 51
      delay 0.05
      keystroke "v" using command down
      delay sendDelaySeconds
      click at {sendClickX, sendClickY}
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
  const appName = opts.appName ?? "Codex";
  const activateDelaySeconds = String((opts.activateDelayMs ?? 450) / 1000);
  const sendDelaySeconds = String((opts.sendDelayMs ?? 600) / 1000);
  const sendButtonRightOffset = String(opts.sendButtonRightOffsetPx ?? 54);
  const sendButtonBottomOffset = String(opts.sendButtonBottomOffsetPx ?? 54);
  const threadId = opts.threadId?.trim() ?? "";
  const threadOpenDelaySeconds = String((opts.threadOpenDelayMs ?? 900) / 1000);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      opts.osascriptBin ?? "osascript",
      [
        "-e",
        SCRIPT,
        text,
        appName,
        activateDelaySeconds,
        threadId,
        threadOpenDelaySeconds,
        sendDelaySeconds,
        sendButtonRightOffset,
        sendButtonBottomOffset,
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
