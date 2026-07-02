# wechat2all Codex Watcher

Standalone Codex-side watcher for the legacy file bridge used by the built-in
WeChat `codex` route.

## What This Package Owns

- Polling bridge `inbox.jsonl` for pending WeChat prompts.
- Running `codex exec`, `codex exec resume --last`, or a chosen Codex session.
- Writing status and final/error messages back to bridge `outbox.jsonl`.
- Local `echo` mode for smoke tests.

It is not the preferred path for visible Codex desktop GUI chat injection. Use
`packages/codex-gui-bridge` for that.

## Tech Stack

- TypeScript.
- Node.js child process execution.
- Local JSON/JSONL bridge files from `@wechat2all/codex-mcp/bridge`.
- Codex CLI / app binary for `exec` and `resume` modes.

## Run

```bash
pnpm --filter @wechat2all/codex-watcher build
pnpm --filter @wechat2all/codex-watcher start -- --mode resume-last
```

Useful modes:

- `resume-last` - inject into the most recent Codex session with `codex exec resume --last`.
- `resume-session` - inject into a specific session id with `--session-id <id>`.
- `exec` - start a fresh non-interactive `codex exec` task for each prompt.
- `echo` - local smoke-test mode that does not call Codex.

Use `--process-existing` only when you intentionally want to drain old pending
prompts already present in `inbox.jsonl`.

Common options:

```bash
pnpm --filter @wechat2all/codex-watcher start -- \
  --mode resume-last \
  --poll-ms 1500 \
  --timeout-ms 600000
```

If the watcher says `spawn codex ENOENT`, point it at the Codex app binary:

```bash
pnpm --filter @wechat2all/codex-watcher start -- \
  --mode resume-last \
  --codex-bin /Applications/Codex.app/Contents/Resources/codex
```

## Bridge Directory

Default:

```text
~/.wechat2all-runtime-bot/codex-bridge/
```

Override:

```text
WECHAT2ALL_CODEX_BRIDGE_DIR=/path/to/bridge
```

## Collaborator Notes

Keep this package isolated. It is intentionally a separate process so it can be
removed or packaged independently later.
