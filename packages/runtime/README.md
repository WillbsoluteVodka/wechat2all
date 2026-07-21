# wechat2all Runtime

Platform-neutral runtime layer for routing normalized WeChat messages to local
connectors, agents, memory, and action execution.

## What This Package Owns

- `WeixinMessage -> RuntimeMessage` normalization.
- `RuntimeAction` definitions and execution through `WeChatClient`.
- Route matching by `profileId`, `conversationId`, `senderId`, `kind`,
  `textIncludes`, and slash commands.
- Multiple logical routes under one scanned WeChat profile.
- Main assistant (`大助手`) behavior: `/help`, `/ls`, `/rename`, `/cd`.
- Route-local behavior such as `/cd ..`.
- Connector interfaces for local handlers, route assistants, MCP-style tools,
  agents, and independently packaged routes.
- Conversation memory and agent memory providers.
- Media cache pipeline and dummy TTS provider.
- Message dedupe and typed runtime events.

It does not own QR login UI, HTTP endpoints, or Tauri dashboard state. Those are
owned by `packages/router-daemon` and `packages/desktop`.

## Mental Model

```mermaid
flowchart LR
  W["WeixinMessage"] --> N["normalizeWeixinMessage"]
  N --> M["RuntimeMessage"]
  M --> RM["route matching"]
  RM --> C["connector"]
  C --> A["RuntimeAction[]"]
  A --> X["executeRuntimeActions"]
  X --> WC["WeChatClient"]
```

Example: a text message starts in the main assistant. If the user sends `/cd`
for an installed route, runtime binds that conversation to the route's connector
until `/cd ..`. Runtime does not import or export any specific route implementation.

## Memory

Runtime has two memory concepts:

- Conversation memory: scoped message history for current route/profile/user.
- Agent memory: longer-lived memory provider abstraction.

Implemented providers:

- `local-jsonl`: simple local JSONL store.
- `mem0`: optional Mem0 REST integration.
- `noop`: disabled memory.
- `composite`: writes/searches across multiple providers.

## Tech Stack

- TypeScript library package.
- Depends on the local `wechat2all` client package.
- No hosted server.
- Uses Node built-ins for local files/state in the example and state-store
  implementations.
- Optional external services are behind provider interfaces, such as Mem0 and
  OpenAI-compatible LLM APIs.

## LLM

LLM access is abstracted behind `LLMProvider`.

Current providers:

- `mock`: deterministic local fallback.
- `openai-compatible`: works with OpenAI-compatible APIs, including DeepSeek.

Common env:

```text
WECHAT2ALL_LLM_PROVIDER=openai-compatible
WECHAT2ALL_LLM_BASE_URL=https://api.deepseek.com/v1
WECHAT2ALL_LLM_API_KEY=...
WECHAT2ALL_LLM_MODEL=deepseek-chat
```

## Media Cache And Attachments

Runtime downloads inbound WeChat media through the client and can cache it on
disk for route connectors. The desktop router stores this under
`~/.wechat2all-runtime-bot/media/<profile>` by default.
The profile directory segment is sanitized and hash-suffixed when needed, so
unusual profile names cannot escape the configured cache root.

Route packages receive a narrow `RuntimeMediaService` capability for downloading
message media, reading cache stats, and clearing cache. Route-specific attachment
lifecycle and output handling stay inside the route package.

Cache pruning is best-effort and configurable:

```text
WECHAT2ALL_MEDIA_DOWNLOAD_TIMEOUT_MS=60000
WECHAT2ALL_MEDIA_DOWNLOAD_MAX_RETRIES=3
WECHAT2ALL_MEDIA_DOWNLOAD_RETRY_DELAY_MS=500
WECHAT2ALL_MEDIA_DOWNLOAD_CONCURRENCY=3
WECHAT2ALL_MEDIA_CACHE_TTL_MS=604800000
WECHAT2ALL_MEDIA_CACHE_MAX_BYTES=1073741824
WECHAT2ALL_MEDIA_CACHE_PRUNE_INTERVAL_MS=60000
```

Downloads use bounded concurrency and preserve attachment order. Cache files
are content-hashed and written atomically, so same-name/same-size attachments
from one message cannot overwrite each other. Transient CDN failures are
retried before the connector reports a media error.

Inside the Codex route:

```text
/cache
/cache clear
```

`/cache` reports the current profile's resolved cache directory, file count, and size.
`/cache clear` clears that profile's attachment cache and drops the current
conversation's pending attachment draft so old file paths are not reused.

Codex output images, videos, and generic files are returned through
`send_media`. Supported native voice-bubble formats (`.silk`, `.amr`, `.mp3`,
`.ogg`, `.spx`, `.wav`, `.pcm`) use `send_voice`; other audio formats are sent
as normal files so WeChat does not receive an invalid voice payload.

## Run The Runtime Bot

```bash
pnpm runtime-bot
pnpm runtime-bot -- --profile main --fresh
```

Try in WeChat:

```text
hello
/help
/ls
/rename
/cd codex
/cd ..
```

State for the example is stored under `~/.wechat2all-runtime-bot`.

## Collaborator Notes

- Add new reusable route behavior here, not in `router-daemon`.
- Keep connector interfaces generic so downstream products can be local agents,
  MCP servers, app-specific handlers, or future skills.
- Keep `client` imports limited to action execution and WeChat type adapters.
