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
```

## Environment

```text
WECHAT2ALL_CODEX_BACKEND=gui-app-server
WECHAT2ALL_CODEX_DELIVERY=app-server
# WECHAT2ALL_CODEX_DELIVERY=gui-automation
WECHAT2ALL_CODEX_THREAD_ID=<optional-prebound-thread-id>
WECHAT2ALL_CODEX_APP_SERVER_SOCKET=<optional-control-socket>
WECHAT2ALL_CODEX_APP_SERVER_TIMEOUT_MS=8000
WECHAT2ALL_CODEX_TURN_TIMEOUT_MS=180000
WECHAT2ALL_CODEX_GUI_POLL_INTERVAL_MS=1000
WECHAT2ALL_CODEX_GUI_THREAD_OPEN_DELAY_MS=900
WECHAT2ALL_CODEX_LIST_LIMIT=20
```

## Collaborator Notes

- Do not silently fall back to the CLI watcher. If app-server is unavailable,
  report bridge unavailable.
- Do not write directly into Codex SQLite state.
- Prefer app-server protocol. Use GUI automation only when the user explicitly
  wants visible prompt injection into a desktop chat.
