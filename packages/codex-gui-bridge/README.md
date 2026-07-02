# wechat2all Codex GUI Bridge

Bridge from the wechat2all `codex` route to Codex desktop/app-server threads.
This is the current preferred Codex integration path.

## What This Package Owns

- Connecting to Codex app-server JSON-RPC.
- Listing bindable Codex chats/threads.
- Reading a thread and current binding.
- Binding a WeChat route conversation to a specific Codex thread id.
- Reading token usage from `account/rateLimits/read`.
- Sending prompts to the bound thread.
- Filtering Codex turn output with reply modes: `final`, `silent`, and `stream`.
- Persisting the Codex GUI auto-open preference used by `/autoopen 1|0`.
- Opening the Codex desktop app at project boot when auto-open is enabled.
- Persisting a `/alarm <HH:mm>` keepalive timer that sends a silent dummy
  `你好` prompt to the bound Codex chat once per day.
- Optional GUI automation that opens `codex://threads/<threadId>`, pastes into
  that chat, presses Enter, and polls the same thread for the final answer.

It does not own WeChat routing, the main assistant, or dashboard endpoints.
Those live in `runtime` and `router-daemon`.

## Delivery Modes

`app-server`:

- Uses `thread/resume` and `turn/start`.
- Protocol-first and does not require Accessibility permission.
- May not visually type into the currently open GUI window.

`gui-automation`:

- Opens the bound Codex GUI thread with `codex://threads/<threadId>`.
- Pastes the prompt and presses Enter.
- Polls the same bound thread for the final answer.
- Requires macOS Accessibility permission for the launching app/terminal.

## Reply Modes

`final` is the default. It only returns `final_answer` text to WeChat and drops
thinking/commentary items.

`silent` waits for the Codex turn to complete, then lets the runtime send only a
short completion notice.

`stream` returns every completed Codex assistant text part for that turn. The
runtime maps these parts to multiple WeChat text actions.

## Tech Stack

- TypeScript.
- Node.js child process and stdio/socket JSON-RPC transport.
- Codex app-server protocol.
- macOS `osascript` only for opt-in GUI automation.

## CLI

```bash
pnpm --filter @wechat2all/codex-gui-bridge build
pnpm --filter @wechat2all/codex-gui-bridge dev -- ls
pnpm --filter @wechat2all/codex-gui-bridge dev -- token
pnpm --filter @wechat2all/codex-gui-bridge dev -- bind <threadId>
WECHAT2ALL_CODEX_THREAD_ID=<threadId> pnpm --filter @wechat2all/codex-gui-bridge dev -- send "hello"
pnpm --filter @wechat2all/codex-gui-bridge dev -- autoopen 1
pnpm --filter @wechat2all/codex-gui-bridge dev -- ensure-open --dry-run
pnpm --filter @wechat2all/codex-gui-bridge dev -- alarm 09:30
pnpm --filter @wechat2all/codex-gui-bridge dev -- alarm off
```

`autoopen 1` is the same persisted setting exposed in the WeChat `codex` route
as `/autoopen 1`. `autoopen 0` disables it. The default is disabled.

## Environment

```text
WECHAT2ALL_CODEX_DELIVERY=app-server
# WECHAT2ALL_CODEX_DELIVERY=gui-automation
WECHAT2ALL_CODEX_THREAD_ID=<optional-prebound-thread-id>
WECHAT2ALL_CODEX_REPLY_MODE=final
# WECHAT2ALL_CODEX_REPLY_MODE=silent
# WECHAT2ALL_CODEX_REPLY_MODE=stream
WECHAT2ALL_CODEX_APP_SERVER_SOCKET=<optional-control-socket>
WECHAT2ALL_CODEX_APP_SERVER_TIMEOUT_MS=8000
WECHAT2ALL_CODEX_TURN_TIMEOUT_MS=180000
WECHAT2ALL_CODEX_GUI_POLL_INTERVAL_MS=1000
WECHAT2ALL_CODEX_GUI_THREAD_OPEN_DELAY_MS=900
WECHAT2ALL_CODEX_LIST_LIMIT=20
WECHAT2ALL_CODEX_GUI_AUTOOPEN_FILE=<optional-autoopen-state-file>
WECHAT2ALL_CODEX_GUI_ALARM_FILE=<optional-alarm-state-file>
WECHAT2ALL_CODEX_AUTOOPEN=1
WECHAT2ALL_CODEX_GUI_APP_NAME=Codex
WECHAT2ALL_CODEX_GUI_APP_PATH=/Applications/Codex.app
WECHAT2ALL_CODEX_GUI_PROCESS_NAME=Codex
WECHAT2ALL_CODEX_GUI_BUNDLE_ID=<optional-bundle-id>
```

`WECHAT2ALL_CODEX_AUTOOPEN=1` is an environment override. Without it, the bridge
reads the persisted `/autoopen` setting from local runtime state.

## Collaborator Notes

- If app-server is unavailable, report bridge unavailable.
- Do not write directly into Codex SQLite state.
- Prefer app-server protocol. Use GUI automation only when the user explicitly
  wants visible prompt injection into a desktop chat.
