# wechat2all Codex MCP

Experimental Codex-side MCP server with a local file-backed bridge store.

The built-in `codex` route no longer uses this package. Current Codex chat
integration lives in `packages/codex-gui-bridge`.

## What This Package Owns

- A small MCP server that exposes tools to Codex.
- A standalone file-backed bridge store for MCP experiments.
- Reading WeChat prompts from `inbox.jsonl`.
- Writing proactive WeChat replies to `outbox.jsonl`.
- Publishing Codex status and optional thread lists.

It does not push prompts into an already running GUI chat.

## Tech Stack

- TypeScript.
- MCP-compatible JSON-RPC over stdio.
- Local JSON/JSONL files for bridge state.
- Node.js filesystem APIs.

## Bridge Directory

Default:

```text
~/.wechat2all-runtime-bot/codex-bridge/
```

Override:

```text
WECHAT2ALL_CODEX_BRIDGE_DIR=/path/to/bridge
```

## Register With Codex

```bash
pnpm --filter @wechat2all/codex-mcp build
codex mcp add wechat2all-codex -- pnpm --dir /path/to/wechat2all --filter @wechat2all/codex-mcp start
```

## Tools

- `update_codex_status` - publish current Codex status for the WeChat route.
- `send_wechat_message` - append a message to the WeChat outbox.
- `list_wechat_prompts` - read prompts sent from WeChat while inside the `codex` route.
- `mark_wechat_prompt_handled` - mark a prompt id as handled.
- `sync_codex_threads` - publish a chat/project list.
- `get_bridge_state` - inspect target/status/inbox/outbox counts.

## Collaborator Notes

This package is useful for MCP experiments only. New GUI chat binding work
should happen in `codex-gui-bridge`.
