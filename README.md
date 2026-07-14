# wechat2all

[简体中文](./README.zh_CN.md)

wechat2all is a local-first WeChat gateway for bots, agents, skills, and
desktop automations. The current target is a macOS app that lets one scanned
WeChat chat act like a local control surface: the main assistant is the OS-like
router, and each route is an app/agent you can enter, leave, and connect to
local services.

## Project Map

```mermaid
flowchart TD
  W["WeChat mobile chat"] --> C["packages/client<br/>WeChat iLink SDK"]
  C --> R["packages/runtime<br/>messages, routes, actions, memory"]
  R --> D["packages/router-daemon<br/>local process + HTTP API"]
  D --> UI["packages/desktop<br/>Tauri dashboard"]
  R --> CG["packages/codex-gui-bridge<br/>Codex GUI/app-server bridge"]
  R --> A["future route agents / MCP skills"]
```

## Layers And Boundaries

Each package owns one layer and should stay independently understandable.

| Layer | Package | Owns | Does not own |
|---|---|---|---|
| Protocol SDK | `packages/client` | WeChat iLink login, polling, media upload/download, send APIs | Route selection, LLMs, memory, UI |
| Runtime | `packages/runtime` | `WeixinMessage -> RuntimeMessage`, route matching, connectors, memory, action execution | HTTP server, QR dashboard, desktop app |
| Local daemon | `packages/router-daemon` | Process lifecycle, profile state, QR login API, dashboard HTTP API, built-in routes | UI rendering, low-level iLink protocol |
| Desktop UI | `packages/desktop` | macOS Tauri dashboard, QR/login/status/routes/logs/settings screens | Runtime business logic |
| Codex GUI bridge | `packages/codex-gui-bridge` | Codex app-server chat listing, binding, token usage, prompt delivery | WeChat routing or generic MCP tools |

Example flow:

1. A user sends `hello` in the WeChat bot chat.
2. `client` receives the raw iLink message and exposes it as a `WeixinMessage`.
3. `runtime` normalizes it into `RuntimeMessage`, checks the current route, and
   asks the matched connector for `RuntimeAction`s.
4. `router-daemon` owns the running profile and trace stream.
5. `client` executes the returned action, such as `send_text`, back to WeChat.

Route navigation currently behaves like a tiny local OS:

```text
/help        # main assistant commands
/ls          # visible routes
/rename      # rename the current route
/cd codex    # enter the codex route
/cd ..       # return to the main assistant
```

Inside a second-level route, the main assistant stops listening until the user
returns with `/cd ..`.

## Current Features

- One physical WeChat scan/profile with multiple logical routes.
- Main assistant route (`大助手`) for general LLM chat, route listing, renaming,
  and route switching.
- Codex route with `/ls`, `/bind <序号>`, `/current`, `/token`, `/autoopen 1|0`,
  `/alarm <HH:mm>`, `/cache`, `/cache clear`, and prompt delivery into a bound
  Codex GUI chat.
- The selected Codex chat binding persists across daemon/desktop restarts.
- Codex route can cache inbound WeChat images/files locally, wait for the next
  text request, then send the request plus attachment paths to Codex. Images are
  also passed as `localImage` items when the Codex app-server supports it.
- Codex-generated local images/files can be sent back to WeChat as media.
- Standard runtime action surface: `send_text`, `send_media`, `send_voice`,
  `typing`, and `noop`.
- Message normalization for text, media, voice, emoji/sticker-like attachments,
  and generic files when the iLink payload contains the needed metadata.
- Local JSONL memory plus optional Mem0 agent memory provider.
- Dummy TTS provider as a placeholder for future real voice replies.
- Tauri dashboard for QR login, routes, agents/MCP, logs/traces, memory, and
  settings.

## Tech Stack

- TypeScript monorepo with `pnpm` workspaces.
- Node.js 20+ runtime.
- `tsdown` for package builds.
- Node test runner plus `tsx` for TypeScript tests/probes.
- WeChat iLink/OpenClaw-compatible HTTP protocol in `packages/client`.
- React + Vite + Tauri v2 for the macOS dashboard.
- Rust only for the Tauri shell.
- OpenAI-compatible LLM provider configuration; DeepSeek works through the same
  interface.
- Local JSONL memory and optional Mem0 REST memory.
- Codex app-server JSON-RPC plus opt-in macOS GUI automation for visible Codex
  chat injection.

## Setup

```bash
pnpm install
pnpm check
```

Use `.env.local` at the repo root for local keys and settings. Do not commit
real API keys.

Common LLM settings:

```bash
WECHAT2ALL_LLM_PROVIDER=openai-compatible
WECHAT2ALL_LLM_BASE_URL=https://api.deepseek.com/v1
WECHAT2ALL_LLM_API_KEY=...
WECHAT2ALL_LLM_MODEL=deepseek-chat
WECHAT2ALL_LLM_TEMPERATURE=0.7
WECHAT2ALL_LLM_MAX_TOKENS=800
```

Optional memory:

```bash
WECHAT2ALL_MEM0_API_KEY=...
```

Optional local media cache limits:

```bash
WECHAT2ALL_MEDIA_DOWNLOAD_TIMEOUT_MS=60000      # per CDN attempt
WECHAT2ALL_MEDIA_DOWNLOAD_MAX_RETRIES=3         # transient failures
WECHAT2ALL_MEDIA_DOWNLOAD_RETRY_DELAY_MS=500
WECHAT2ALL_MEDIA_DOWNLOAD_CONCURRENCY=3         # ordered, bounded parallelism
WECHAT2ALL_MEDIA_CACHE_TTL_MS=604800000        # default: 7 days
WECHAT2ALL_MEDIA_CACHE_MAX_BYTES=1073741824    # default: 1 GB
WECHAT2ALL_MEDIA_CACHE_PRUNE_INTERVAL_MS=60000 # default: 60 seconds
```

Inbound WeChat media is cached under `~/.wechat2all-runtime-bot/media/<profile>`
by default so local agents/Codex can read file paths. The profile directory
segment is sanitized when needed, so unusual profile names cannot escape the
configured cache root. These files are local runtime cache, not source data.
`.gitignore` also ignores equivalent repo-local state paths in case a developer
points runtime state into the checkout.
Inside the `codex` route, `/cache` shows the current profile cache path, file
count, and size. `/cache clear` clears that profile's attachment cache.
CDN downloads retry transient failures and multiple attachments download with
bounded concurrency while preserving their original message order.

## Local Data And Privacy

`packages/client` remains stateless. The desktop/runtime layer stores private
state under `~/.wechat2all-runtime-bot` by default:

- `credentials.json`: WeChat login credentials (`0600`).
- `sync-buf.json` and `processed-messages.json`: polling cursor and dedupe state.
- `memory/<profile>/turns.jsonl`: local assistant memory.
- `media/<profile>/`: inbound attachment cache, default 7-day / 1-GB cap.
- `codex-gui-bridge/`: local Codex binding, auto-open, and alarm preferences.

Runtime-created private directories use `0700`; state, memory, and cached media
files use `0600`. None of these paths are tracked by Git. Codex-generated files
remain in Codex's own local output directory until its own cleanup policy or the
user removes them.

There are two intentional non-local data paths: messages sent to the configured
LLM provider, and agent memory sent to Mem0 when `WECHAT2ALL_MEM0_API_KEY` is
present. Remove that key to keep agent memory on local JSONL only.

## Run

Low-level SDK echo bot:

```bash
pnpm echo-bot
```

Runtime bot without the desktop dashboard:

```bash
pnpm runtime-bot
pnpm runtime-bot -- --profile main --fresh
```

Full local dashboard stack:

```bash
pnpm desktop
```

In development, `pnpm desktop` restarts stale local wechat2all dev processes:
the desktop app process, the router port (`39787`), and the UI port (`5173`).
It then starts a fresh router-daemon + Tauri session. On macOS, it also runs
the Codex GUI auto-open check, but that check is disabled by default and only
opens Codex after the user enables `/autoopen 1` inside the `codex` route.
To opt back into reuse:

```bash
WECHAT2ALL_DESKTOP_RESTART=0 pnpm desktop
```

To skip the Codex GUI auto-open check entirely:

```bash
WECHAT2ALL_DESKTOP_OPEN_CODEX=0 pnpm desktop
```

Use visible Codex GUI delivery:

```bash
WECHAT2ALL_CODEX_DELIVERY=gui-automation \
pnpm desktop
```

If port `39787` is occupied by something that is not wechat2all, point this run
at a different local port:

```bash
WECHAT2ALL_ROUTER_PORT=39788 pnpm desktop
```

## macOS Privacy Settings

For normal QR login and dashboard viewing, no special macOS permission should be
needed beyond network access.

For Codex GUI delivery with `WECHAT2ALL_CODEX_DELIVERY=gui-automation`, macOS
must allow the process running wechat2all to control the computer:

1. Open System Settings.
2. Go to Privacy & Security -> Accessibility.
3. Enable the app or terminal you use to start wechat2all. Common entries:
   `Terminal`, `iTerm`, `Codex`, and sometimes `Codex Computer Use`.
4. Keep the Codex desktop app installed and logged in.

The GUI delivery path opens `codex://threads/<threadId>`, waits briefly, pastes
the prompt into that bound chat, presses Enter, then polls the same thread for a
final answer.

## Current Progress For Collaborators

- `packages/client` is the robust low-level SDK. Keep it stateless.
- `packages/runtime` is the primary product logic layer. Add new route behavior,
  memory policies, connectors, and action abstractions here.
- `packages/router-daemon` is the local app backend. It should wire runtime to
  QR login, HTTP endpoints, traces, and desktop state, but not absorb runtime
  business logic.
- `packages/desktop` is a usable development dashboard, not yet a packaged
  installer.
- `packages/codex-gui-bridge` is the Codex integration path. The old
  `codex exec` watcher has been removed.

Before changing behavior, read the README in the package you are touching.
