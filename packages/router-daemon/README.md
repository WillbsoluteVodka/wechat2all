# wechat2all Router Daemon

Local app backend for the desktop dashboard. It wires the low-level WeChat
client to the runtime layer, exposes local HTTP endpoints, and keeps the app's
current state visible to the UI.

## What This Package Owns

- Process lifecycle for the local router.
- Loading `.env.local`.
- Starting one default WeChat runtime profile.
- QR login endpoints for the dashboard.
- Dashboard snapshots: profile status, route list, agents, settings, traces.
- Trace logging.
- Built-in route wiring, including the main assistant and `codex`.
- Wiring the Codex route to the GUI app-server bridge.

It should not own generic route behavior, memory policy, action semantics, or
message normalization. Those belong to `packages/runtime`.

## Source Layout

- `src/index.ts` - process lifecycle, runtime startup, QR login, and HTTP server wiring.
- `src/env.ts` - `.env.local` loading and typed environment helpers.
- `src/routes.ts` - built-in route definitions and dashboard route labels.
- `src/codex.ts` - Codex backend selection and bridge construction.
- `src/dashboard.ts` - dashboard snapshot projection for the Tauri UI.
- `src/trace.ts` - in-memory trace buffer and console logging.

## Tech Stack

- Node.js HTTP server.
- TypeScript.
- `wechat2all` client SDK.
- `@wechat2all/runtime`.
- `@wechat2all/codex-gui-bridge` for the GUI app-server backend.
- Local filesystem state through runtime state stores.

## HTTP API

Default endpoint:

```text
http://127.0.0.1:39787
```

Common endpoints:

- `GET /health`
- `GET /snapshot`
- `POST /profiles/:profileId/qr-login`
- `GET /profiles/:profileId/login-status`
- settings/dashboard endpoints used by Tauri commands

## Run

```bash
pnpm --filter @wechat2all/router-daemon dev
```

Change host/port:

```bash
WECHAT2ALL_ROUTER_HOST=127.0.0.1 \
WECHAT2ALL_ROUTER_PORT=39788 \
pnpm --filter @wechat2all/router-daemon dev
```

## Codex Bridge

The built-in `codex` route talks to Codex app-server threads through
`@wechat2all/codex-gui-bridge`.

Inside WeChat:

```text
/cd codex
/status
/ls
/bind 1
/current
/mode final
hello from WeChat
/token
```

The bridge uses Codex app-server methods `thread/list`, `thread/read`,
`thread/resume`, `turn/start`, and `account/rateLimits/read`. If no thread is
bound, ordinary text is rejected with a `/bind` instruction.

Optional environment:

```text
WECHAT2ALL_CODEX_THREAD_ID=<prebound-thread-id>
WECHAT2ALL_CODEX_DELIVERY=app-server
# WECHAT2ALL_CODEX_DELIVERY=gui-automation
WECHAT2ALL_CODEX_REPLY_MODE=final
# WECHAT2ALL_CODEX_REPLY_MODE=silent
# WECHAT2ALL_CODEX_REPLY_MODE=stream
WECHAT2ALL_CODEX_APP_SERVER_SOCKET=<optional-control-socket>
WECHAT2ALL_CODEX_APP_SERVER_TIMEOUT_MS=8000
WECHAT2ALL_CODEX_TURN_TIMEOUT_MS=180000
WECHAT2ALL_CODEX_IN_PROGRESS_GRACE_MS=120000
WECHAT2ALL_CODEX_COMPACTION_GRACE_MS=180000
WECHAT2ALL_CODEX_GUI_POLL_INTERVAL_MS=1000
WECHAT2ALL_CODEX_GUI_THREAD_OPEN_DELAY_MS=900
WECHAT2ALL_CODEX_LIST_LIMIT=20
WECHAT2ALL_CODEX_GUI_BINDING_FILE=<optional-binding-state-file>
WECHAT2ALL_MEDIA_DOWNLOAD_TIMEOUT_MS=60000
WECHAT2ALL_MEDIA_DOWNLOAD_MAX_RETRIES=3
WECHAT2ALL_MEDIA_DOWNLOAD_RETRY_DELAY_MS=500
WECHAT2ALL_MEDIA_DOWNLOAD_CONCURRENCY=3
WECHAT2ALL_MEDIA_CACHE_TTL_MS=604800000
WECHAT2ALL_MEDIA_CACHE_MAX_BYTES=1073741824
WECHAT2ALL_MEDIA_CACHE_PRUNE_INTERVAL_MS=60000
```

`WECHAT2ALL_CODEX_DELIVERY=gui-automation` is the opt-in mode that opens the
bound Codex desktop chat with `codex://threads/<threadId>`, pastes into that
chat, and polls the same bound thread for the final answer. It requires macOS
Accessibility permission for the app/terminal running wechat2all.

Inbound WeChat media is cached under `~/.wechat2all-runtime-bot/media/<profile>`
so runtime connectors can hand local file paths to Codex and other local agents.
Profile cache directory names are sanitized when needed, so profile names cannot
escape the configured cache root. The three `WECHAT2ALL_MEDIA_CACHE_*` settings
control best-effort pruning. `WECHAT2ALL_MEDIA_DOWNLOAD_*` controls bounded
parallel downloads and retry behavior for unstable CDN/network connections.
The Codex route also exposes `/cache` and `/cache clear` for inspecting and
clearing the current profile cache from WeChat.
`/bind` persists the selected Codex thread under local bridge state, so normal
desktop/daemon restarts restore the same chat automatically.

## Collaborator Notes

- If you add a new built-in route, define the route here but put reusable
  connector behavior in `packages/runtime`.
- If the desktop cannot start, check whether port `39787` is already in use.
- `pnpm desktop` enables the local-only `/dev/shutdown` endpoint while it owns
  the daemon, so an existing development stack can stop cleanly before restart.
  The endpoint remains disabled for normal standalone daemon runs.
- Keep this package local-only. Do not introduce a centralized hosted server.
