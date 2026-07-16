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
- Hourly WeChat session-expiry reminders sent by the main WeConnect route.
- Built-in route wiring, including the main assistant, `codex`, and `claude`.
- Wiring the Codex route to the GUI app-server bridge.
- Wiring the Claude route to the independent Claude Agent SDK package.

It should not own generic route behavior, memory policy, action semantics, or
message normalization. Those belong to `packages/runtime`.

## Source Layout

- `src/index.ts` - process lifecycle, runtime startup, QR login, and HTTP server wiring.
- `src/env.ts` - `.env.local` loading and typed environment helpers.
- `src/session-reminders.ts` - 24-hour session scheduling and local reminder target state.
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
- `@wechat2all/claude-route` for the headless Claude Agent SDK route.
- Local filesystem state through runtime state stores.

## HTTP API

Default endpoint:

```text
http://127.0.0.1:39787
```

Common endpoints:

- `GET /health`
- `GET /snapshot`
- `GET /config`
- `PATCH /config`
- `GET /llm/health`
- `POST /llm/health/check`
- `POST /profiles/:profileId/qr-login`
- `GET /profiles/:profileId/login-status`
- settings/dashboard endpoints used by Tauri commands

## Local Provider Configuration API

The desktop UI can read and save WeConnect assistant provider settings without
handling the `.env.local` file itself:

```bash
curl http://127.0.0.1:39787/config

curl -X PATCH http://127.0.0.1:39787/config \
  -H 'content-type: application/json' \
  -d '{
    "llm": {
      "provider": "openai-compatible",
      "apiKey": "replace-me",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com/v1"
    },
    "memory": {
      "provider": "mem0",
      "apiKey": "replace-me",
      "baseUrl": "https://api.mem0.ai"
    },
    "claude": {
      "apiKey": "replace-me",
      "workdir": "/absolute/path/to/obsidian-vault",
      "model": "claude-sonnet-4-5"
    }
  }'
```

`GET /config` never returns a complete secret. It only returns `configured` and
a masked value. In `PATCH /config`, an omitted secret or an empty secret input
is preserved, which makes an unedited password field safe to submit; send
`null` to explicitly clear it. Only documented LLM, memory, and Claude fields are
accepted, and updates are written atomically to `.env.local` with mode `0600`.
Responses include `schemaVersion: 1` so the future desktop form can version its
integration.

## WeConnect LLM Health API

The daemon performs one lightweight LLM check in the background whenever it
starts. The check sends `Reply with exactly: OK` with an 8-token response limit,
caches the result, and never returns the API key or the model response body.

Read the cached startup result without issuing another paid request:

```bash
curl http://127.0.0.1:39787/llm/health
```

Explicitly run the check again, for example from a Retry button:

```bash
curl -X POST http://127.0.0.1:39787/llm/health/check \
  -H 'content-type: application/json' \
  -d '{}'
```

Both endpoints return HTTP 200 when the health operation itself succeeds. Read
`llm.status`, `llm.apiKeyConfigured`, and `llm.usable` to determine provider
health; the top-level `ok` only means that the local API request was handled.
Possible statuses are `idle`, `checking`, `not-configured`, `ready`, and `error`.
Provider failures include a stable error code and a sanitized message.

The health check uses the configuration applied to the running daemon. After a
`PATCH /config` response with `restartRequired: true`, restart the app before
using the health result for the new settings.

LLM, memory, and Claude providers are constructed when the daemon starts. A successful
change therefore returns `restartRequired: true`; the UI should show that state
and restart the local app stack before treating the new provider as active.

## Session Expiry Reminders

The router reads `loginAt` from the local profile credentials and schedules a
WeConnect reminder at each session-hour boundary until the 24-hour expiry. The
reminder contains both the remaining duration and the local expiry time. It is
created by the main-assistant module and sent through the runtime action queue;
the Codex route is not involved.

WeChat requires a recent `context_token` for proactive sends. After a fresh QR
login, the owner must send the assistant at least one message. The target and
latest token are then stored locally in the profile's private
`session-reminder.json`, allowing reminders to survive daemon restarts. A new
QR login or unlink clears the old target.

Defaults and optional test overrides:

```text
WECHAT2ALL_SESSION_DURATION_MINUTES=1440
WECHAT2ALL_SESSION_REMINDER_INTERVAL_MINUTES=60
```

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
