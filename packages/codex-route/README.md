# wechat2all Codex Route

This package owns the complete Codex route boundary:

- route definition and metadata;
- WeChat slash commands and attachment lifecycle;
- processing reminders and reply formatting;
- Codex GUI bridge construction;
- Codex prerequisite/setup checks.
- schema-driven dashboard controls, command help, and manual permission notes.

The host router only installs the module's connector and route definition. The
main assistant and generic runtime do not import Codex implementation code.
The desktop renders the route's dashboard metadata through generic route UI;
it does not contain a Codex-specific setup endpoint or configuration form.

`@wechat2all/codex-gui-bridge` remains a lower-level driver owned by this route.
It can be replaced without changing the main assistant.

## Availability and recovery

- app-server exits, broken pipes, initialization loss, and RPC timeouts
  invalidate the current child session; the next operation starts and
  initializes a fresh child automatically;
- turn observation has a hard ceiling, even if Codex remains `inProgress`;
- each WeChat conversation queue has an independent watchdog, so one stuck
  request cannot permanently block later messages;
- `/recover` bypasses the conversation queue, restarts the app-server session,
  keeps the current binding, and can be used remotely without restarting
  WeConnect;
- delivery failures attempt recovery before returning the error to WeChat.
- if macOS silently ignores GUI paste/Return while locked or display-asleep,
  absence of a new observable turn triggers full app-server delivery and reply
  collection instead of returning a GUI timeout.

The default route watchdog is 35 minutes and can be overridden with
`WECHAT2ALL_CODEX_ROUTE_OPERATION_TIMEOUT_MS`.
